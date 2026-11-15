import { ownStack, reviewAgain, type StackPr, type Target } from "../shared/attention";
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
  // Asked again, what I said last time and what changed since, on each PR I reviewed [REV-02].
  const stack = target.stack ?? [];
  const again = kind === "review" ? reviewAgainContext(target) : Promise.resolve("");
  if (kind === "review" && stack.length > 1) {
    const lines = stack.map((pr) => `${branchLine(pr)}${pr.review ? `, review requested: https://github.com/${target.repo}/pull/${pr.number}` : ", mine"}`);
    return join(`Stack, bottom first:\n${lines.join("\n")}`, await again);
  }

  // review, start: the whole description and the latest comments.
  const [talk, since] = await Promise.all([conversation(ref, target), again]);
  return join(talk, since);
}

const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n");

const MY_REVIEWS = 5;
const MY_THREADS = 100;

// For each PR asking for my review again: my last reviews and the threads I'm in, with what came after, and how to find
// the commits since the one I reviewed, whether the branch moved on, was rebased, or lost it [REV-02]. Empty when none
// asks again.
export async function reviewAgainContext(target: Target): Promise<string> {
  const prs = reviewAgain(target);
  const named = (target.stack?.length ?? 0) > 1;
  const blocks = await Promise.all(prs.map((pr) => lastReview(target.repo, pr.number, named)));
  return join(...blocks);
}

async function lastReview(repo: string, number: number, named: boolean): Promise<string> {
  type Author = { login: string } | null;
  type Review = { author: Author; state: string; body: string; submittedAt: string | null; commit: { oid: string } | null };
  type Thread = { isResolved: boolean; path: string; line: number | null; comments: { totalCount: number; nodes: { author: Author; body: string }[] } };
  const [owner, name] = repo.split("/");
  const data = await graphql<{
    viewer: { login: string };
    repository: { pullRequest: { url: string; baseRefName: string; headRefOid: string; reviews: { nodes: Review[] }; reviewThreads: { totalCount: number; nodes: Thread[] } } };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          url baseRefName headRefOid
          reviews(last: 50) { nodes { author { login } state body submittedAt commit { oid } } }
          reviewThreads(first: ${MY_THREADS}) { totalCount nodes { isResolved path line comments(first: ${THREAD_COMMENTS}) { totalCount nodes { author { login } body } } } }
        }
      }
    }`,
    { owner, name, number },
  );
  const me = data.viewer.login.toLowerCase();
  const mine = (author: Author) => author?.login.toLowerCase() === me;
  const pr = data.repository.pullRequest;
  const reviews = pr.reviews.nodes.filter((r) => mine(r.author));
  const latest = reviews.at(-1);
  const title = `Your last review${named ? ` of #${number}` : ""}`;
  if (!latest) return `${title}: not among the PR's last 50 reviews; read them at ${pr.url}`;

  const who = (author: Author) => (mine(author) ? "you" : `@${author?.login ?? "ghost"}`);
  const said = reviews
    .filter((r) => r.body.trim())
    .slice(-MY_REVIEWS)
    .map((r) => `- ${r.state.toLowerCase()}${r.submittedAt ? `, ${r.submittedAt}` : ""}: ${clip(r.body, 1500)}`);
  const threads = pr.reviewThreads.nodes
    .filter((t) => t.comments.nodes.some((c) => mine(c.author)))
    .map((t) => {
      const comments = t.comments.nodes.map((c) => `  ${who(c.author)}: ${clip(c.body, 800).replace(/\n/g, "\n  ")}`);
      const more = notShown(t.comments.totalCount - t.comments.nodes.length, "more comments", pr.url);
      return [`- ${t.path}${t.line ? `:${t.line}` : ""} (${t.isResolved ? "resolved" : "unresolved"})`, ...comments, more && `  ${more}`].filter(Boolean).join("\n");
    });
  const laterThreads = notShown(pr.reviewThreads.totalCount - pr.reviewThreads.nodes.length, "more review threads, some maybe yours", pr.url);

  return join(
    `${title}: ${latest.state.toLowerCase()}${latest.submittedAt ? ` on ${latest.submittedAt}` : ""}.\n${sinceSteps(latest.commit?.oid, pr.headRefOid, pr.baseRefName)}`,
    said.length ? `What you wrote in your reviews:\n${said.join("\n")}` : "",
    threads.length ? `Review threads you're in, with the replies:\n${threads.join("\n")}` : "",
    laterThreads,
  );
}

// How to find the commits since the one I reviewed: they follow it, or the branch was rebased or force-pushed past it.
function sinceSteps(reviewed: string | undefined, head: string, base: string): string {
  if (!reviewed) return `GitHub no longer has the commit you reviewed, so review the whole diff against ${base} and say you couldn't narrow it down.`;
  if (reviewed === head) return `No commits since: the head is still ${head}. What's new is in the replies below.`;
  return [
    `You reviewed commit ${reviewed}; the head is now ${head}.`,
    `- \`git fetch origin ${reviewed} ${head}\``,
    `- If \`git merge-base --is-ancestor ${reviewed} ${head}\`: the new commits are \`git log ${reviewed}..${head}\`, their changes \`git diff ${reviewed}..${head}\`.`,
    `- Otherwise the branch was rebased or force-pushed: compare the two versions with \`git range-diff origin/${base}..${reviewed} origin/${base}..${head}\`.`,
    `- If ${reviewed} can't be fetched, review the whole diff against ${base} and say you couldn't narrow it down.`,
  ].join("\n");
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
