// Shapes returned by the queries in queries.ts.

import type { GithubColor } from "../shared/attention";

type Nodes<T> = { nodes: T[] };
type Repo = { nameWithOwner: string; defaultBranchRef?: { name: string } | null };

export interface Actor {
  __typename?: string; // "User", "Bot", ...
  login: string;
  avatarUrl?: string;
}

export interface RequestedReviewer {
  __typename?: string; // "User", "Team", ...
  login?: string;
  combinedSlug?: string;
  avatarUrl?: string;
}

export interface Comment {
  id?: string;
  author: Actor | null;
  body?: string;
  // Threads I'm in only: GitHub's rendering, where tags of real accounts are links [WAI-02].
  bodyHTML?: string;
  createdAt: string;
  url?: string;
  reactionGroups?: { viewerHasReacted: boolean }[];
}

export interface ReviewThread {
  isResolved: boolean;
  opener?: Nodes<Comment>;
  comments: Nodes<Comment>;
}

export interface PullRequestNode {
  id: string;
  number: number;
  title: string;
  url: string;
  body?: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: Actor | null;
  repository: Repo & { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; autoMergeAllowed?: boolean };
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository?: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  // GitHub's own answer to whether the repo's rules let it merge now; BLOCKED doesn't say which rule [PRS-13].
  // Wrong when a request asks about more than a few PRs, as search does, so Details' answer comes first.
  mergeStateStatus?: MergeStateStatus;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  autoMergeRequest?: { enabledAt: string } | null;
  assignees: Nodes<{ login: string }>;
  closingIssuesReferences: Nodes<LinkedIssue>;
  commits: Nodes<{ commit: { committedDate: string; statusCheckRollup: { state: string } | null } }>;
  // A person, or a team by its "org/slug"; null when it can't be seen.
  reviewRequests: Nodes<{ requestedReviewer: RequestedReviewer | null }>;
  latestReviews: Nodes<{ author: Actor | null; state: string; submittedAt: string | null }>;
  reviewThreads: Nodes<ReviewThread>;
  comments: Nodes<Comment>;
}

// A search hit from mentions:@me, with bodies for finding the mention.
export interface MentionNode {
  __typename: "Issue" | "PullRequest";
  id?: string;
  reactionGroups?: { viewerHasReacted: boolean }[];
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: Actor | null;
  body: string;
  repository: Repo;
  comments: Nodes<Comment>;
  reviews?: Nodes<{ author: Actor | null; submittedAt: string | null }>;
  reviewThreads?: Nodes<ReviewThread>;
}

// An issue or PR I'm in, with its last conversation comments.
export interface IssueNode {
  __typename?: "Issue" | "PullRequest";
  createdAt: string;
  author: Actor | null;
  number: number;
  title: string;
  url: string;
  repository: Repo;
  comments: Nodes<Comment>;
}

export interface PickableNode {
  // The issue's node id, which a transfer keeps [HIS-07].
  id?: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  repository: Repo & { isFork?: boolean };
  issueType: { name: string } | null;
  issueFieldValues: Nodes<{ name?: string; field?: { name: string } }>;
  // Open PRs that close it, so a card can say someone is on it [NXT-10].
  closedByPullRequestsReferences?: Nodes<{ number: number; url: string; state: string; author: { login: string } | null }>;
  // Only when projects can be read: the projects it's on, with the board's Status field and where it is on it [NXT-12].
  projectItems?: Nodes<ProjectItemNode | null> & { pageInfo?: { hasNextPage: boolean } };
  // Added after the search: the Next up sources that found it [NXT-09].
  sources?: string[];
}

export interface ProjectItemNode {
  // Null for a board the token can't see, like one in an org that enforces SSO.
  project: { id: string; title: string; closed: boolean } | null;
  // The built-in Status field's value; empty when the item has none.
  status: { name?: string; color?: GithubColor } | null;
}

// One request per search, merged [GH-01].
export interface LiveResult {
  viewer: { login: string; id: string };
  mine: Nodes<PullRequestNode>;
  reviews: Nodes<PullRequestNode>;
  mentions: Nodes<MentionNode>;
  involved: Nodes<IssueNode>;
  asked: Nodes<IssueNode>;
  assigned: Nodes<PickableNode>;
  unclaimed: Nodes<PickableNode>;
  // My PRs closed lately [HIS-07].
  ended: Nodes<EndedPullRequest>;
  // Issues assigned to me closed lately, for a change by others [HIS-07].
  closedIssues: Nodes<ClosedIssue>;
}

export interface ClosedIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  closedAt: string;
  stateReason: string | null;
  repository: Repo;
  timelineItems: Nodes<{ createdAt?: string; actor?: { login: string } | null }>;
}

// A PR of mine known to have been closed, as it is now [HIS-07].
export interface ReopenSubject {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  repository: Repo;
  timelineItems: Nodes<{ createdAt?: string; actor?: { login: string } | null }>;
}

export interface EndedPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string;
  repository: Repo;
  mergedBy: { login: string } | null;
  assignees: Nodes<{ login: string }>;
  timelineItems: Nodes<{ createdAt?: string; actor?: { login: string } | null }>;
}

// Who assigned or unassigned whom; actor and assignee are null for a deleted account [HIS-07].
export interface AssignmentEvent {
  __typename: "AssignedEvent" | "UnassignedEvent";
  createdAt: string;
  actor: { login: string } | null;
  assignee: { login?: string } | null;
}

export interface AssignmentSubject {
  __typename: "PullRequest" | "Issue";
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  repository: Repo;
  assignees: Nodes<{ login: string }>;
  timelineItems: Nodes<AssignmentEvent | Record<string, never>>;
}

// One request for all three [HIS-01, HIS-02].
// Labels say what kind of work a finished item was [HIS-04].
type Labels = { labels?: Nodes<{ name: string }> };

export interface HistoryResult {
  // Who I am, to tell a merge by someone else [HIS-05]; missing in older fixtures.
  viewer?: { login: string; id: string };
  merged: Nodes<{ number: number; title: string; url: string; body?: string; mergedAt: string; mergedBy?: { login: string } | null; repository: Repo; closingIssuesReferences: Nodes<{ number: number; repository: Repo }> } & Labels>;
  reviewed: Nodes<{ number: number; title: string; url: string; mergedAt: string; mergedBy?: { login: string } | null; repository: Repo; author: Actor | null } & Labels>;
  closed: Nodes<{ number: number; title: string; url: string; closedAt: string; stateReason: string | null; repository: Repo; issueType?: { name: string } | null; timelineItems?: Nodes<{ actor?: { login: string } | null }> } & Labels>;
}

export type SearchResult = LiveResult & HistoryResult;

// From the request after my PRs and Next up's issues.
export interface Details {
  // "owner/name#number" -> commits the head is behind its base.
  behind: Record<string, number>;
  // Org (lower case) -> issue field name -> its options in that org's order. Per org, as two orgs may order a Priority
  // field differently [NXT-02].
  fieldOptions: Record<string, Record<string, string[]>>;
  // Org (lower case) -> issue field name -> option name -> the color that org gave it. Per org, as two orgs may both have a
  // Priority field and color it differently [NXT-10].
  fieldColors: Record<string, Record<string, Record<string, GithubColor>>>;
  // Project id -> its Status options in the board's order, for Next up's filter [NXT-03].
  projectStatuses: Record<string, { name: string; color: GithubColor }[]>;
  // "owner/name#number" -> the open issue my PRs' descriptions refer to; PRs and closed issues are left out [ATT-03].
  issues: Record<string, LinkedIssue>;
  // "owner/name#number" -> the checks the repo requires on my PR's last commit, as far as they've reported [PRS-14].
  checks: Record<string, RequiredChecks>;
  // "owner/name#number" -> my PR's merge state, asked a few PRs at a time: asked about more, GitHub says BLOCKED [PRS-13].
  mergeState: Record<string, MergeStateStatus>;
}

export type MergeStateStatus = "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";

export type RequiredChecks = { required: number; failing: number; pending: number };

export type LinkedIssue = { number: number; title: string; url: string; repository: Repo };
