import { ownStack, type StackPr, type Target } from "../shared/attention";
import type { SessionKind } from "../shared/config";
import { graphql, runGh } from "./gh";

// Context for a session prompt, fetched deterministically when a session starts [SES-04].

// Cuts long text, but lists every link from the cut part so the agent can still open them, like a Jam recording at the
// bottom of a support issue.
export function clip(text: string | null | undefined, max: number): string {
  const value = (text ?? "").trim();
  if (value.length <= max) return value;
  const links = (part: string) => [...part.matchAll(/(.?)(https?:\/\/[^\s<>"'`\[\]]+)/gi)].map(([, before, url]) => trimLink(url, before));
  const kept = new Set(links(value.slice(0, max)));
  // A link the cut splits in half is listed whole.
  const cut = [...new Set(links(value))].filter((url) => !kept.has(url));
  const listed = cut.length ? `\nLinks in the cut part:\n${cut.map((url) => `- ${url}`).join("\n")}` : "";
  return `${value.slice(0, max)}\n…(truncated)${listed}`;
}

// A link runs to the first space, quote or square bracket. Trailing punctuation belongs to the sentence, a closing
// parenthesis only when the link has no opening one (Markdown's [text](url)), and * or _ only when they also open it
// (**url**, _url_).
function trimLink(url: string, before: string): string {
  let link = url;
  for (let previous = ""; previous !== link; ) {
    previous = link;
    link = link.replace(/[.,;:!?]+$/, "");
    if (link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) link = link.slice(0, -1);
    if ((before === "*" || before === "_") && link.endsWith(before)) link = link.replace(before === "*" ? /\*+$/ : /_+$/, "");
  }
  return link;
}

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
  // Only my branches are rebased and pushed, never others' in the same stack [ATT-04].
  if (kind === "rebase" || kind === "refresh") return `Branches, bottom first:\n${ownStack(target).map(branchLine).join("\n")}`;
  if (kind === "fix") return failingChecks(ref, target.repo);
  if (kind === "address") return reviewFeedback(target);

  // Review of a stack: every branch, with a link to each PR asking for my review; the agent reads what it needs [ATT-04].
  const stack = target.stack ?? [];
  if (kind === "review" && stack.length > 1) {
    const lines = stack.map((pr) => `${branchLine(pr)}${pr.review ? `, review requested: https://github.com/${target.repo}/pull/${pr.number}` : ", mine"}`);
    return `Stack, bottom first:\n${lines.join("\n")}`;
  }

  // review, start: the whole description and the latest comments.
  return conversation(ref, target);
}

const branchLine = (pr: StackPr) => `- #${pr.number}: ${pr.head} (on ${pr.base})`;

const RECENT_COMMENTS = 5;

async function conversation(ref: string[], target: Target): Promise<string> {
  type View = { body: string; comments: { author: { login: string } | null; body: string }[] };
  const view = await ghJson<View>([target.kind === "pr" ? "pr" : "issue", "view", ...ref, "--json", "body,comments"]);
  const comments = view.comments.slice(-RECENT_COMMENTS).map((c) => `@${c.author?.login ?? "ghost"}: ${clip(c.body, 800)}`);
  const older = view.comments.length > RECENT_COMMENTS ? `Showing the last ${RECENT_COMMENTS} of ${view.comments.length} comments; the rest are at ${target.url}` : "";
  // The description goes in whole: GitHub caps it at 65,536 characters, and its links are often at the bottom.
  return [`Description:\n${(view.body ?? "").trim() || "(empty)"}`, comments.length ? `Recent comments:\n${[older, ...comments].filter(Boolean).join("\n\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
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

// What one page of a review query leaves out, with where to read the rest.
const notShown = (count: number, what: string, url: string) => (count > 0 ? `${count} ${what} not shown, see ${url}` : "");

const THREADS = 100;
const THREAD_COMMENTS = 20;
const REVIEWS = 20;

// gh has no command for unresolved review threads, so this one is GraphQL.
async function reviewFeedback(target: Target): Promise<string> {
  type Author = { login: string } | null;
  const [owner, name] = target.repo.split("/");
  const data = await graphql<{
    repository: {
      pullRequest: {
        reviews: { totalCount: number; nodes: { author: Author; state: string; body: string }[] };
        reviewThreads: {
          totalCount: number;
          nodes: { isResolved: boolean; path: string; line: number | null; comments: { totalCount: number; nodes: { author: Author; body: string }[] } }[];
        };
      };
    };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(last: ${REVIEWS}, states: [CHANGES_REQUESTED, COMMENTED]) { totalCount nodes { author { login } state body } }
          reviewThreads(first: ${THREADS}) { totalCount nodes { isResolved path line comments(first: ${THREAD_COMMENTS}) { totalCount nodes { author { login } body } } } }
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
    .map((t) => {
      const comments = t.comments.nodes.map((c) => `  ${who(c.author)}: ${clip(c.body, 1500).replace(/\n/g, "\n  ")}`);
      const more = notShown(t.comments.totalCount - t.comments.nodes.length, "more comments", target.url);
      return [`- ${t.path}${t.line ? `:${t.line}` : ""}`, ...comments, more && `  ${more}`].filter(Boolean).join("\n");
    });
  // Older reviews and later threads past one page are left out; say so, since some of those threads may be unresolved.
  const olderReviews = notShown(reviews.totalCount - reviews.nodes.length, "older reviews", target.url);
  const laterThreads = notShown(reviewThreads.totalCount - reviewThreads.nodes.length, "more review threads (resolved or not)", target.url);
  return [
    summaries.length ? `Review summaries:\n${summaries.join("\n")}` : "",
    threads.length ? `Unresolved review threads:\n${threads.join("\n")}` : laterThreads ? "" : "No unresolved review threads.",
    olderReviews,
    laterThreads,
  ]
    .filter(Boolean)
    .join("\n\n");
}
