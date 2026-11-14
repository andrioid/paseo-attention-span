import type { GithubColor, UnclaimedSource } from "../shared/attention";
import type { AttentionConfig } from "../shared/config";
import type { PickableNode, PullRequestNode, RequiredChecks } from "./github-types";
import type { IssueRef } from "./references";

// An issue or PR with its last conversation comments [ATT-16], rendered too for who my questions tag [WAI-02].
const THREAD = `__typename
      ... on Issue { number title url createdAt author { ...author } repository { nameWithOwner } comments(last: 10) { nodes { ...comment bodyHTML } } }
      ... on PullRequest { number title url createdAt author { ...author } repository { nameWithOwner } comments(last: 10) { nodes { ...comment bodyHTML } } }`;

// Each search with how many results it asks for and what it reads of each.
const SEARCHES = {
  mine: { first: 50, nodes: "...pr" },
  reviews: { first: 30, nodes: "...pr" },
  mentions: {
    first: 30,
    nodes: `__typename
      ... on Issue { id number title url createdAt body author { ...author } reactionGroups { viewerHasReacted } repository { nameWithOwner } comments(last: 30) { nodes { ...comment } } }
      ... on PullRequest {
        id number title url createdAt body author { ...author } reactionGroups { viewerHasReacted } repository { nameWithOwner } comments(last: 30) { nodes { ...comment } }
        reviews(last: 20) { nodes { author { login } submittedAt } }
        reviewThreads(last: 30) { nodes { isResolved comments(first: 20) { nodes { ...comment } } } }
      }`,
  },
  // Threads I'm in, with their last conversation comments and what the 👍 picker needs, to tell whether I'm answered [ATT-16].
  involved: { first: 100, nodes: THREAD },
  // My own issues where I commented, for questions nobody answered however old [ATT-11].
  asked: { first: 50, nodes: THREAD },
  assigned: { first: 50, nodes: "...pickable" },
  unclaimed: { first: 100, nodes: "...pickable" },
  // My PRs closed lately, with who merged or closed them, for Changed by others [HIS-07]. Who closed one comes from its last
  // close event; assignees tell a PR handed over before it closed [PRS-08].
  ended: {
    first: 50,
    nodes: `... on PullRequest {
      id number title url merged mergedAt closedAt repository { nameWithOwner } mergedBy { login }
      assignees(first: 10) { nodes { login } }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { createdAt actor { login } } } }
    }`,
  },
  // Issues assigned to me closed lately, so someone else's close is a change too [HIS-07]. Bounded like `ended`.
  closedIssues: {
    first: 50,
    nodes: `... on Issue {
      id number title url closedAt stateReason repository { nameWithOwner }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { createdAt actor { login } } } }
    }`,
  },
  // Who merged it, when it wasn't me [HIS-05].
  merged: {
    first: 100,
    nodes: "... on PullRequest { number title url body mergedAt mergedBy { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } closingIssuesReferences(first: 3) { nodes { number repository { nameWithOwner } } } }",
  },
  // Who merged someone else's PR I reviewed, for the week's Changed by others copy and Wrap up [HIS-02, ATT-22].
  reviewed: { first: 100, nodes: "... on PullRequest { number title url mergedAt mergedBy { login } repository { nameWithOwner } author { ...author } labels(first: 20) { nodes { name } } }" },
  // Labels and type say what kind of work each was [HIS-04]; the close event's actor says who closed it [HIS-07].
  closed: {
    first: 100,
    nodes: "... on Issue { number title url closedAt stateReason repository { nameWithOwner } issueType { name } labels(first: 20) { nodes { name } } timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } } }",
  },
};
export type SearchName = keyof typeof SEARCHES;

// Doing, Waiting and Next up. History has its own, slower schedule.
export const LIVE_SEARCHES = ["mine", "reviews", "mentions", "involved", "asked", "assigned", "unclaimed", "ended", "closedIssues"] as const;
export const HISTORY_SEARCHES = ["merged", "reviewed", "closed"] as const;

const FRAGMENTS: Record<string, string> = {
  author: "fragment author on Actor { __typename login avatarUrl(size: 64) }",
  comment: `fragment comment on Comment {
  body createdAt
  author { ...author }
  ... on IssueComment { id url reactionGroups { viewerHasReacted } }
  ... on PullRequestReviewComment { id url reactionGroups { viewerHasReacted } }
}`,
  pickable: `fragment pickable on Issue {
  id number title url createdAt
  repository { nameWithOwner isFork defaultBranchRef { name } }
  issueType { name }
  issueFieldValues(first: 20) { nodes { ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldCommon { name } } } } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { number url state author { login } } }
}`,
  // Needs read:project, so only asked for once the login is known to have it; without it GitHub fails the whole search [NXT-12].
  // Archived items are off the board, so they don't count. Each board's Status options come once per board, from
  // projectStatusesQuery, not with every issue on it [GH-01]. hasNextPage says when the list was cut short.
  projects: `fragment projects on Issue {
  projectItems(first: 10, includeArchived: false) {
    pageInfo { hasNextPage }
    nodes {
      project { id title closed }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name color } }
    }
  }
}`,
  pr: `fragment pr on PullRequest {
  id number title url body isDraft createdAt updatedAt
  author { ...author }
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed autoMergeAllowed defaultBranchRef { name } }
  baseRefName headRefName headRefOid isCrossRepository mergeable mergeStateStatus reviewDecision
  autoMergeRequest { enabledAt }
  assignees(first: 10) { nodes { login } }
  closingIssuesReferences(first: 5) { nodes { number title url repository { nameWithOwner } } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 5) { nodes { requestedReviewer { ... on User { ...author } ... on Bot { ...author } ... on Team { __typename combinedSlug avatarUrl } } } }
  latestReviews(first: 10) { nodes { author { ...author } state submittedAt } }
  reviewThreads(last: 30) {
    nodes {
      isResolved
      opener: comments(first: 1) { nodes { author { __typename login } } }
      comments(last: 1) { nodes { author { login } createdAt } }
    }
  }
  comments(last: 10) { nodes { author { login } createdAt } }
}`,
};

// Next up's searches, which read the projects of what they find when they can [NXT-12].
const PICKABLE_SEARCHES: readonly SearchName[] = ["assigned", "unclaimed"];

// A query for some searches, as aliases named after them, with only the fragments they use; GitHub rejects unused ones.
// GitHub runs the searches in one request one after another, so the live ones go out as separate requests in parallel [GH-01].
export function searchQuery(names: readonly SearchName[], withViewer = false, { projects = false } = {}): string {
  const nodes = (name: SearchName) => `${SEARCHES[name].nodes}${projects && PICKABLE_SEARCHES.includes(name) ? " ...projects" : ""}`;
  const fields = names.map((name) => `  ${name}: search(type: ISSUE, query: $${name}, first: ${SEARCHES[name].first}) {\n    nodes { ${nodes(name)} }\n  }`);
  const used = new Set<string>();
  const collect = (text: string) => {
    for (const [, name] of text.matchAll(/\.\.\.(\w+)/g)) {
      if (used.has(name)) continue;
      used.add(name);
      collect(FRAGMENTS[name]);
    }
  };
  fields.forEach(collect);
  const variables = names.map((name) => `$${name}: String!`).join(", ");
  return `query Attention(${variables}) {\n${withViewer ? "  viewer { login id }\n" : ""}${fields.join("\n")}\n}\n${[...used].map((name) => FRAGMENTS[name]).join("\n")}`;
}

function where(orgs: string[], repos: string[]): string {
  return [...orgs.map((org) => `org:${org}`), ...repos.map((repo) => `repo:${repo}`), "archived:false"].join(" ");
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

function startOfWeek(now: Date): Date {
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday;
}

// Where History starts: whole weeks, from a Monday, so the oldest week isn't cut short [HIS-01].
export function historySince(now: Date, weeks: number): string {
  return new Date(startOfWeek(now).getTime() - (weeks - 1) * 7 * 86_400_000).toISOString();
}

// Where Next up looks for unclaimed issues [NXT-04, NXT-08]: one search per chosen source, so each issue says which
// sources found it and no query outgrows GitHub's limit [NXT-09]. Without sources, the configured orgs and repos,
// else my Paseo projects' repos. Never all of GitHub: unlike the other searches, this one isn't about me.
export function unclaimedSearches(config: AttentionConfig, projectRepos: string[], login: string | null): { from: UnclaimedSource; searches: UnclaimedSearch[] } {
  const search = (source: string | null, scope: string) => ({ source, query: `is:issue is:open no:assignee ${scope}` });
  const { mine, orgs, repos } = config.nextUp;
  if (mine || orgs.length || repos.length) {
    if (mine && !login) throw new Error("Couldn't tell which GitHub account is yours, for My repos");
    return {
      from: "config",
      searches: [
        ...(mine ? [search("mine", `user:${login} archived:false`)] : []),
        ...orgs.map((org) => search(`org:${org}`, where([org], []))),
        ...repos.map((repo) => search(`repo:${repo}`, where([], [repo]))),
      ],
    };
  }
  if (config.orgs.length || config.repos.length) return { from: "config", searches: [search(null, where(config.orgs, config.repos))] };
  return projectRepos.length ? { from: "projects", searches: [search(null, where([], projectRepos))] } : { from: "none", searches: [] };
}

// One search's query, and the source it stands for; null when Next up has no sources of its own.
export interface UnclaimedSearch {
  source: string | null;
  query: string;
}

// An issue found by several sources is listed once, under each of them [NXT-09]. Forks don't count as my repos.
export function mergeUnclaimed(results: { source: string | null; nodes: (PickableNode | null)[] }[]): PickableNode[] {
  const byKey = new Map<string, PickableNode>();
  for (const { source, nodes } of results) {
    for (const node of nodes) {
      if (!node?.repository || (source === "mine" && node.repository.isFork)) continue;
      const seen = byKey.get(prKey(node)) ?? { ...node, sources: [] };
      if (source && !seen.sources!.includes(source)) seen.sources!.push(source);
      byKey.set(prKey(node), seen);
    }
  }
  return [...byKey.values()];
}

// The searches about me. Next up's unclaimed issues have their own [NXT-04].
export function searchVariables(config: AttentionConfig, now: Date): Record<Exclude<SearchName, "unclaimed">, string> {
  const scope = where(config.orgs, config.repos);
  const since = isoDate(new Date(now.getTime() - config.mentionDays * 86_400_000));
  const history = isoDate(new Date(historySince(now, config.historyWeeks)));
  return {
    mine: `is:pr is:open author:@me ${scope}`,
    // By name only, not via a team [REV-01].
    reviews: `is:pr is:open user-review-requested:@me ${scope}`,
    mentions: `is:open mentions:@me updated:>=${since} ${scope}`,
    assigned: `is:issue is:open assignee:@me ${scope}`,
    // Within the window Changed by others catches up over [HIS-07].
    ended: `is:pr is:closed author:@me closed:>=${since} sort:updated-desc ${scope}`,
    // Issues assigned to me that closed lately: someone else's close is a change too [HIS-07].
    closedIssues: `is:issue is:closed assignee:@me closed:>=${since} sort:updated-desc ${scope}`,
    // Threads I opened, commented on, was assigned or mentioned in, active lately: answers, and fresh questions [ATT-16].
    involved: `is:open involves:@me updated:>=${since} sort:updated-desc ${scope}`,
    // On my own issues a question nobody answered stays however old [ATT-11]. Newest first, so old ones go last.
    asked: `is:issue is:open author:@me commenter:@me sort:updated-desc ${scope}`,
    // History [HIS-01, HIS-02]
    merged: `is:pr is:merged author:@me merged:>=${history} ${scope}`,
    reviewed: `is:pr is:merged reviewed-by:@me -author:@me merged:>=${history} ${scope}`,
    closed: `is:issue is:closed assignee:@me closed:>=${history} ${scope}`,
  };
}

// Who assigned and unassigned whom on PRs and issues that may have left my hands, by node id, a batch per request [HIS-07, GH-01].
// The last events are enough: a handover is the latest change of hands.
export const ASSIGNMENT_BATCH = 20;
const ASSIGNMENT_EVENT = "createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } }";
export function assignmentsQuery(ids: string[]): string {
  const subject = `id number title url state repository { nameWithOwner } assignees(first: 10) { nodes { login } }
      timelineItems(itemTypes: [ASSIGNED_EVENT, UNASSIGNED_EVENT], last: 30) { nodes { __typename ... on AssignedEvent { ${ASSIGNMENT_EVENT} } ... on UnassignedEvent { ${ASSIGNMENT_EVENT} } } }`;
  const fields = ids.map((id, index) => `a${index}: node(id: ${JSON.stringify(id)}) { __typename ... on PullRequest { ${subject} } ... on Issue { ${subject} } }`);
  return `query Assignments {\n${fields.join("\n")}\n}`;
}

// PRs Attention Span saw closed, by node id, a batch per request: only a state and a reopen event [HIS-07, GH-01].
export function reopenQuery(ids: string[]): string {
  const fields = ids.map(
    (id, index) => `a${index}: node(id: ${JSON.stringify(id)}) {
      ... on PullRequest { id number title url state repository { nameWithOwner }
        timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt actor { login } } } }
      }
    }`,
  );
  return `query Reopened {\n${fields.join("\n")}\n}`;
}

export function prKey(node: { repository: { nameWithOwner: string }; number: number }): string {
  return `${node.repository.nameWithOwner}#${node.number}`;
}

const repository = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})`;
};

// After my PRs and Next up's issues: how far my PRs are behind their bases, which of their checks the repo requires, the
// option order of org issue fields, and what the issues my PRs' descriptions refer to are [GH-01, ATT-03, PRS-14].
export function detailsQuery(prs: PullRequestNode[], orgs: string[], refs: IssueRef[] = []): { query: string; compares: Record<string, string> } {
  const compares: Record<string, string> = {};
  const fields = prs.flatMap((pr, index) => {
    compares[`c${index}`] = prKey(pr);
    compares[`r${index}`] = prKey(pr);
    const required = `isRequired(pullRequestNumber: ${pr.number})`;
    // Apart from the compare, so a repo that won't say which checks are required costs only this field.
    return [
      `c${index}: ${repository(pr.repository.nameWithOwner)} {
      ref(qualifiedName: ${JSON.stringify(`refs/heads/${pr.baseRefName}`)}) { compare(headRef: ${JSON.stringify(pr.headRefName)}) { behindBy } }
    }`,
      `r${index}: ${repository(pr.repository.nameWithOwner)} {
      pullRequest(number: ${pr.number}) { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { status conclusion ${required} }
        ... on StatusContext { state ${required} }
      } } } } } } }
    }`,
    ];
  });
  refs.forEach((ref, index) =>
    fields.push(`i${index}: ${repository(ref.repo)} {
      issueOrPullRequest(number: ${ref.number}) { ... on Issue { number title url state repository { nameWithOwner } } }
    }`),
  );
  orgs.forEach((org, index) => fields.push(orgFields(`o${index}`, org)));
  return { query: `query Details {\n${fields.join("\n")}\n}`, compares };
}

// An org's single-select issue fields with their options, in the org's order [NXT-02], and the colors it gave them [NXT-10].
const orgFields = (alias: string, org: string) => `${alias}: organization(login: ${JSON.stringify(org)}) {
      issueFields(first: 50) { nodes { ... on IssueFieldSingleSelect { name options { name color } } } }
    }`;
export type OrgFields = { issueFields?: { nodes: { name?: string; options?: { name: string; color?: GithubColor }[] }[] } } | null;

// The Status options of the boards Next up's issues are on, in each board's order, once per board [NXT-03, GH-01].
// Asked apart from the details request, so a board that can't be read costs only the filter's statuses.
export function projectStatusesQuery(ids: string[]): string {
  const fields = ids.map(
    (id, index) => `b${index}: node(id: ${JSON.stringify(id)}) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { options { name color } } } } }`,
  );
  return `query ProjectStatuses {\n${fields.join("\n")}\n}`;
}
export type ProjectStatusesResult = Record<string, { field?: { options?: { name: string; color: GithubColor }[] } | null } | null>;

// Answers only when the login may read projects; without read:project GitHub refuses it, which is how Next up tells [NXT-12].
// It must ask for a field read:project guards: totalCount isn't, so a token without the scope answered it. GitHub checks
// the scope against the query, not the data, so it's refused even for someone with no projects (seen 2026-11-11). One
// node keeps it small and within GitHub's documented 1–100.
export const PROJECTS_PROBE = "query ProjectsProbe { viewer { projectsV2(first: 1) { nodes { id } } } }";

// How GitHub says the login lacks read:project.
export const missingProjectScope = (error: unknown): boolean => /read:project/i.test(typeof error === "string" ? error : ((error as Error)?.message ?? ""));

// The fields settings offers for Next up, from every org it might pick from [NXT-04]. An owner that's a person fails only its own field.
export function issueFieldsQuery(orgs: string[]): string {
  return `query IssueFields {\n${orgs.map((org, index) => orgFields(`o${index}`, org)).join("\n")}\n}`;
}

// GitHub works out at most this many PRs' merge state per request; asked about more, it says BLOCKED for all of them, even
// in search and in a repo's PR list. Seen on 2026-11-04 [PRS-13].
export const MERGE_STATE_BATCH = 5;

// The merge state of up to MERGE_STATE_BATCH PRs, in one request; m0, m1, … map back to their keys.
export function mergeStateQuery(prs: PullRequestNode[]): { query: string; keys: Record<string, string> } {
  const keys: Record<string, string> = {};
  const fields = prs.map((pr, index) => {
    keys[`m${index}`] = prKey(pr);
    return `m${index}: ${repository(pr.repository.nameWithOwner)} { pullRequest(number: ${pr.number}) { mergeStateStatus } }`;
  });
  return { query: `query MergeState {\n${fields.join("\n")}\n}`, keys };
}

export type CheckContext = { status?: string; conclusion?: string | null; state?: string; isRequired?: boolean };

// How the checks the repo requires stand. A check run passes as success, neutral or skipped, like GitHub counts it [PRS-14].
export function requiredChecks(contexts: CheckContext[]): RequiredChecks {
  const required = contexts.filter((context) => context.isRequired);
  const pending = (c: CheckContext) => (c.state ? c.state === "PENDING" || c.state === "EXPECTED" : c.status !== "COMPLETED");
  const failing = (c: CheckContext) => (c.state ? c.state === "FAILURE" || c.state === "ERROR" : !pending(c) && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? ""));
  return { required: required.length, failing: required.filter(failing).length, pending: required.filter(pending).length };
}
