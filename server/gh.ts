import { spawn } from "node:child_process";

// Everything goes through the host's existing gh login; no token is stored [SEC-01].

// Previews run on made-up data and never reach GitHub.
export const FIXTURE = process.env.PASEO_ATTENTION_SPAN_FIXTURE === "1";

// `timeoutMs` stops gh and fails the call when GitHub takes longer, for asks that mustn't hold anything else up.
export function runGh(args: string[], input?: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (FIXTURE) return Promise.reject(new Error("GitHub is off in fixture mode."));
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`GitHub didn't answer within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("The GitHub CLI (gh) isn't on the daemon's PATH.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

// GitHub's answer with its errors kept beside whatever data resolved, for callers that must tell a partial answer from a
// whole one. Throws only when nothing came back at all.
// `failures` says where each error was and what kind, for callers that tell a node GitHub can't find from one it failed on.
export interface GraphqlFailure {
  message: string;
  type?: string;
  path?: (string | number)[];
}

export async function graphqlResult<T>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<{ data: T | null; errors: string[]; failures: GraphqlFailure[] }> {
  const { code, stdout, stderr } = await runGh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }), options);
  let parsed: { data?: T | null; errors?: GraphqlFailure[] } | undefined;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON: an auth or network failure.
  }
  const failures = parsed?.errors ?? [];
  const errors = failures.map((error) => error.message);
  if (parsed?.data) return { data: parsed.data, errors, failures };
  throw new Error(errors.join("; ") || stderr.trim() || `gh exited with ${code}`);
}

// Partial errors (e.g. a deleted branch in a compare) still return the data that resolved.
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return (await graphqlResult<T>(query, variables)).data as T;
}
