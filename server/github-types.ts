// Shapes returned by the queries in queries.ts.

type Nodes<T> = { nodes: T[] };
type Repo = { nameWithOwner: string; defaultBranchRef?: { name: string } | null };

export interface Actor {
  __typename?: string; // "User", "Bot", ...
  login: string;
  avatarUrl?: string;
}

export interface Comment {
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
  repository: Repo & { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean };
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository?: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
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
  repository: Repo;
  issueType: { name: string } | null;
  issueFieldValues: Nodes<{ name?: string; field?: { name: string } }>;
}

export interface SearchResult {
  viewer: { login: string; id: string };
  mine: Nodes<PullRequestNode>;
  reviews: Nodes<PullRequestNode>;
  mentions: Nodes<MentionNode>;
  commented: Nodes<IssueNode>;
  assigned: Nodes<PickableNode>;
  unclaimed: Nodes<PickableNode>;
  merged: Nodes<{ number: number; title: string; url: string; mergedAt: string; repository: Repo; closingIssuesReferences: Nodes<{ number: number; repository: Repo }> }>;
  reviewed: Nodes<{ number: number; title: string; url: string; mergedAt: string; repository: Repo; author: Actor | null }>;
  closed: Nodes<{ number: number; title: string; url: string; closedAt: string; stateReason: string | null; repository: Repo }>;
}

// From the second request.
export interface Details {
  // "owner/name#number" -> commits the head is behind its base.
  behind: Record<string, number>;
  // Issue field name -> its options in order.
  fieldOptions: Record<string, string[]>;
}
