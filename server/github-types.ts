// Shapes returned by the queries in queries.ts.

type Nodes<T> = { nodes: T[] };
type Repo = { nameWithOwner: string; defaultBranchRef?: { name: string } | null };

export interface Actor {
  __typename?: string; // "User", "Bot", ...
  login: string;
  avatarUrl?: string;
}

export interface Comment {
  id?: string;
  author: Actor | null;
  body?: string;
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
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  autoMergeRequest?: { enabledAt: string } | null;
  assignees: Nodes<{ login: string }>;
  closingIssuesReferences: Nodes<{ number: number; title: string; url: string; repository: Repo }>;
  commits: Nodes<{ commit: { committedDate: string; statusCheckRollup: { state: string } | null } }>;
  reviewRequests: Nodes<{ requestedReviewer: Actor | null }>;
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

export interface IssueNode {
  number: number;
  title: string;
  url: string;
  repository: Repo;
  comments: Nodes<Comment>;
}

export interface PickableNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  repository: Repo & { isFork?: boolean };
  issueType: { name: string } | null;
  issueFieldValues: Nodes<{ name?: string; field?: { name: string } }>;
  // Open PRs that close it, so a card can say someone is on it [NXT-10].
  closedByPullRequestsReferences?: Nodes<{ number: number; url: string; state: string; author: { login: string } | null }>;
  // Added after the search: the Next up sources that found it [NXT-09].
  sources?: string[];
}

// One request per search, merged [GH-01].
export interface LiveResult {
  viewer: { login: string; id: string };
  mine: Nodes<PullRequestNode>;
  reviews: Nodes<PullRequestNode>;
  mentions: Nodes<MentionNode>;
  commented: Nodes<IssueNode>;
  assigned: Nodes<PickableNode>;
  unclaimed: Nodes<PickableNode>;
}

// One request for all three [HIS-01, HIS-02].
export interface HistoryResult {
  merged: Nodes<{ number: number; title: string; url: string; mergedAt: string; repository: Repo; closingIssuesReferences: Nodes<{ number: number; repository: Repo }> }>;
  reviewed: Nodes<{ number: number; title: string; url: string; mergedAt: string; repository: Repo; author: Actor | null }>;
  closed: Nodes<{ number: number; title: string; url: string; closedAt: string; stateReason: string | null; repository: Repo }>;
}

export type SearchResult = LiveResult & HistoryResult;

// From the request after my PRs and Next up's issues.
export interface Details {
  // "owner/name#number" -> commits the head is behind its base.
  behind: Record<string, number>;
  // Issue field name -> its options in order.
  fieldOptions: Record<string, string[]>;
}
