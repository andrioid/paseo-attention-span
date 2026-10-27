import { spawn } from "node:child_process";

// Everything goes through the host's existing gh login; no token is stored [SEC-01].

// Previews run on made-up data and never reach GitHub.
export const FIXTURE = process.env.PASEO_GITHUB_INBOX_FIXTURE === "1";

export function runGh(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (FIXTURE) return Promise.reject(new Error("GitHub is off in fixture mode."));
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error("The GitHub CLI (gh) isn't on the daemon's PATH.") : error),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// Partial errors (e.g. a deleted branch in a compare) still return the data that resolved.
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { code, stdout, stderr } = await runGh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let parsed: { data?: T; errors?: { message: string }[] } | undefined;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON: an auth or network failure.
  }
  if (parsed?.data) return parsed.data;
  const message = parsed?.errors?.map((error) => error.message).join("; ") || stderr.trim() || `gh exited with ${code}`;
  throw new Error(message);
}
