import type { SessionKind } from "../shared/config";
import type { Target } from "../shared/inbox";
import { graphql, runGh } from "./gh";

// Context for a session prompt, fetched only when a session starts [SES-04, GH-01].

const MAX_BODY = 4000;
const LOG_LINES = 120;

function clip(text: string | null | undefined, max = MAX_BODY): string {
  const value = (text ?? "").trim();
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
}

function split(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

interface Author {
  login: string;
}

export async function sessionContext(kind: SessionKind, target: Target): Promise<string> {
  switch (kind) {
    case "fix":
      return failingChecks(target);
    case "address":
      return reviewFeedback(target);
    case "rebase":
    case "refresh":
      return stackBranches(target);
    case "review":
      return description(target);
    case "start":
      return description(target);
  }
}

async function description(target: Target): Promise<string> {
  const field = target.kind === "pr" ? "pullRequest" : "issue";
  const data = await graphql<{
    repository: { item: { body: string; comments: { nodes: { author: Author | null; body: string }[] } } | null };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        item: ${field}(number: $number) { body comments(last: 5) { nodes { author { login } body } } }
      }
    }`,
    { ...split(target.repo), number: target.number },
  );
  const item = data.repository.item;
  if (!item) return "";
  const comments = item.comments.nodes.map((c) => `@${c.author?.login ?? "ghost"}: ${clip(c.body, 800)}`);
  return [`Description:\n${clip(item.body) || "(empty)"}`, comments.length ? `Recent comments:\n${comments.join("\n\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

async function failingChecks(target: Target): Promise<string> {
  type CheckContext =
    | { __typename: "CheckRun"; name: string; conclusion: string | null; detailsUrl: string | null; checkSuite: { workflowRun: { databaseId: number } | null } | null }
    | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null; description: string | null };
  const data = await graphql<{
    repository: { pullRequest: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] } } };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
            __typename
            ... on CheckRun { name conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
            ... on StatusContext { context state targetUrl description }
          } } } } } }
        }
      }
    }`,
    { ...split(target.repo), number: target.number },
  );
  const contexts = data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const failed = contexts.filter((c) =>
    c.__typename === "CheckRun"
      ? ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(c.conclusion ?? "")
      : ["FAILURE", "ERROR"].includes(c.state),
  );
  if (failed.length === 0) return "No failing checks were found on the latest commit.";
  const lines = failed.map((c) =>
    c.__typename === "CheckRun" ? `- ${c.name}: ${c.conclusion} ${c.detailsUrl ?? ""}` : `- ${c.context}: ${c.state} ${c.description ?? ""} ${c.targetUrl ?? ""}`,
  );
  const runs = [
    ...new Set(failed.flatMap((c) => (c.__typename === "CheckRun" && c.checkSuite?.workflowRun ? [c.checkSuite.workflowRun.databaseId] : []))),
  ].slice(0, 2);
  const logs: string[] = [];
  for (const run of runs) {
    const { code, stdout } = await runGh(["run", "view", String(run), "--repo", target.repo, "--log-failed"]);
    if (code === 0 && stdout.trim()) logs.push(`Failed log of run ${run} (last ${LOG_LINES} lines):\n${stdout.trim().split("\n").slice(-LOG_LINES).join("\n")}`);
  }
  return [`Failing checks:\n${lines.join("\n")}`, ...logs].join("\n\n");
}

async function reviewFeedback(target: Target): Promise<string> {
  const data = await graphql<{
    repository: {
      pullRequest: {
        reviews: { nodes: { author: Author | null; state: string; body: string }[] };
        reviewThreads: {
          nodes: { isResolved: boolean; path: string; line: number | null; comments: { nodes: { author: Author | null; body: string }[] } }[];
        };
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
    { ...split(target.repo), number: target.number },
  );
  const pr = data.repository.pullRequest;
  const reviews = pr.reviews.nodes
    .filter((r) => r.body.trim())
    .map((r) => `- @${r.author?.login ?? "ghost"} (${r.state.toLowerCase().replace("_", " ")}): ${clip(r.body, 1500)}`);
  const threads = pr.reviewThreads.nodes
    .filter((t) => !t.isResolved)
    .map(
      (t) =>
        `- ${t.path}${t.line ? `:${t.line}` : ""}\n${t.comments.nodes.map((c) => `  @${c.author?.login ?? "ghost"}: ${clip(c.body, 1500).replace(/\n/g, "\n  ")}`).join("\n")}`,
    );
  return [
    reviews.length ? `Review summaries:\n${reviews.join("\n")}` : "",
    threads.length ? `Unresolved review threads:\n${threads.join("\n")}` : "No unresolved review threads.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function stackBranches(target: Target): Promise<string> {
  const keys = target.stack ?? [`${target.repo}#${target.number}`];
  if (keys.length < 2) return `Branch: ${target.headRefName} onto ${target.baseRefName}`;
  const fields = keys.map((key, index) => {
    const [repo, number] = key.split("#");
    const { owner, name } = split(repo);
    return `s${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(number)}) { number headRefName baseRefName } }`;
  });
  const data = await graphql<Record<string, { pullRequest: { number: number; headRefName: string; baseRefName: string } | null }>>(
    `query { ${fields.join("\n")} }`,
  );
  const rows = keys.map((_, index) => data[`s${index}`]?.pullRequest).filter(Boolean);
  return `Branches in the stack, bottom first:\n${rows.map((pr) => `- #${pr!.number}: ${pr!.headRefName} (on ${pr!.baseRefName})`).join("\n")}`;
}
