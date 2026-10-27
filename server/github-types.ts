// Shapes returned by the queries in queries.ts.

export interface Actor {
  __typename: string; // "User", "Bot", "Mannequin", ...
  login: string;
}

export interface Comment {
  id?: string;
  url?: string;
  author: Actor | null;
  body?: string;
  createdAt: string;
  reactionGroups?: { viewerHasReacted: boolean }[];
}

export interface ReviewThread {
  isResolved: boolean;
  // First comment, on PRs from the pr fragment; mention threads list every comment instead.
  opener?: { nodes: Comment[] };
  comments: { nodes: Comment[] };
}

export interface RepositoryInfo {
  nameWithOwner: string;
  squashMergeAllowed?: boolean;
  mergeCommitAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
  defaultBranchRef?: { name: string } | null;
}

export type RollupState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

export interface PullRequestNode {
  __typename?: "PullRequest";
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: Actor | null;
  repository: RepositoryInfo;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository?: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  assignees: { nodes: { login: string }[] };
  closingIssuesReferences: {
    nodes: { number: number; title: string; url: string; repository: { nameWithOwner: string } }[];
  };
  commits: {
    nodes: {
      commit: { oid: string; committedDate: string; statusCheckRollup: { state: RollupState } | null };
    }[];
  };
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string } | null }[] };
  latestReviews: { nodes: { author: Actor | null; state: string; submittedAt: string | null }[] };
  reviewThreads: { nodes: ReviewThread[] };
  comments: { nodes: Comment[] };
}

// A search hit from mentions:@me, with bodies for finding the mention.
export interface MentionNode {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  createdAt: string;
  updatedAt: string;
  author: Actor | null;
  body: string;
  repository: { nameWithOwner: string };
  comments: { nodes: Comment[] };
  reviewThreads?: { nodes: ReviewThread[] };
}

export interface IssueNode {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  comments: { nodes: Comment[] };
}

export interface MergedNode {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  repository: { nameWithOwner: string };
}

export interface SearchResult {
  viewer: { login: string };
  mine: { nodes: PullRequestNode[] };
  reviews: { nodes: PullRequestNode[] };
  mentions: { nodes: MentionNode[] };
  assigned: { nodes: IssueNode[] };
  commented: { nodes: IssueNode[] };
  merged: { nodes: MergedNode[] };
}

// "owner/name#number" -> commits the head is behind its base.
export type BehindCounts = Record<string, number>;
