import type { SessionKind } from "../shared/config";
import type { Target } from "../shared/inbox";
import { graphql, runGh } from "./gh";

// Context for a session prompt, fetched deterministically when a session starts [SES-04].

const clip = (text: string | null | undefined, max = 4000) => {
  const value = (text ?? "").trim();
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
};

async function ghJson<T>(args: string[]): Promise<T> {
  // `gh pr checks` exits non-zero when checks fail but still prints the JSON.
  const { stdout, stderr } = await runGh(args);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(stderr.trim() || `gh ${args.join(" ")} failed`);
  }
}

export async function sessionContext(kind: SessionKind, target: Target): Promise<string> {
  const ref = [String(target.number), "--repo", target.repo];
  if (kind === "rebase" || kind === "refresh") {
    const stack = target.stack ?? [];
    return `Branches, bottom first:\n${stack.map((pr) => `- #${pr.number}: ${pr.head} (on ${pr.base})`).join("\n")}`;
  }
  if (kind === "fix") return failingChecks(ref, target.repo);
  if (kind === "address") return reviewFeedback(target);

  // review, start: the description and the latest comments.
  type View = { body: string; comments: { author: { login: string }; body: string }[] };
  const view = await ghJson<View>([target.kind === "pr" ? "pr" : "issue", "view", ...ref, "--json", "body,comments"]);
  const comments = view.comments.slice(-5).map((c) => `@${c.author.login}: ${clip(c.body, 800)}`);
  return [`Description:\n${clip(view.body) || "(empty)"}`, comments.length ? `Recent comments:\n${comments.join("\n\n")}` : ""].filter(Boolean).join("\n\n");
}

export async function defaultBranch(repo: string): Promise<string | null> {
  const view = await ghJson<{ defaultBranchRef: { name: string } | null }>(["repo", "view", repo, "--json", "defaultBranchRef"]);
  return view.defaultBranchRef?.name ?? null;
}

async function failingChecks(ref: string[], repo: string): Promise<string> {
  const checks = await ghJson<{ name: string; bucket: string; link: string }[]>(["pr", "checks", ...ref, "--json", "name,bucket,link"]);
  const failed = checks.filter((check) => check.bucket === "fail");
  if (failed.length === 0) return "No failing checks were found on the latest commit.";
  const runs = [...new Set(failed.map((check) => /\/actions\/runs\/(\d+)/.exec(check.link)?.[1]).filter(Boolean))].slice(0, 2);
  const logs: string[] = [];
  for (const run of runs) {
    const { code, stdout } = await runGh(["run", "view", run!, "--repo", repo, "--log-failed"]);
    if (code === 0 && stdout.trim()) logs.push(`Failed log of run ${run} (last 120 lines):\n${stdout.trim().split("\n").slice(-120).join("\n")}`);
  }
  return [`Failing checks:\n${failed.map((check) => `- ${check.name} ${check.link}`).join("\n")}`, ...logs].join("\n\n");
}

// gh has no command for unresolved review threads, so this one is GraphQL.
async function reviewFeedback(target: Target): Promise<string> {
  type Author = { login: string } | null;
  const [owner, name] = target.repo.split("/");
  const data = await graphql<{
    repository: {
      pullRequest: {
        reviews: { nodes: { author: Author; state: string; body: string }[] };
        reviewThreads: { nodes: { isResolved: boolean; path: string; line: number | null; comments: { nodes: { author: Author; body: string }[] } }[] };
      };
    };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(last: 20, states: [CHANGES_REQUESTED, COMMENTED]) { nodes { author { login } state body } }
          reviewThreads(first: 100) { nodes { isResolved path line comments(first: 20) { nodes { author { login } body } } } }
        }
      }
    }`,
    { owner, name, number: target.number },
  );
  const { reviews, reviewThreads } = data.repository.pullRequest;
  const who = (author: Author) => `@${author?.login ?? "ghost"}`;
  const summaries = reviews.nodes.filter((r) => r.body.trim()).map((r) => `- ${who(r.author)} (${r.state.toLowerCase()}): ${clip(r.body, 1500)}`);
  const threads = reviewThreads.nodes
    .filter((t) => !t.isResolved)
    .map((t) => `- ${t.path}${t.line ? `:${t.line}` : ""}\n${t.comments.nodes.map((c) => `  ${who(c.author)}: ${clip(c.body, 1500).replace(/\n/g, "\n  ")}`).join("\n")}`);
  return [summaries.length ? `Review summaries:\n${summaries.join("\n")}` : "", threads.length ? `Unresolved review threads:\n${threads.join("\n")}` : "No unresolved review threads."]
    .filter(Boolean)
    .join("\n\n");
}
