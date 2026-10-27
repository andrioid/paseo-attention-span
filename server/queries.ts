import type { InboxConfig } from "../shared/config";
import type { PullRequestNode } from "./github-types";

// One query with search aliases covers everything the inbox shows [GH-01].
export const SEARCH_QUERY = `
query Inbox($mine: String!, $reviews: String!, $mentions: String!, $assigned: String!, $commented: String!, $merged: String!) {
  viewer { login }
  mine: search(type: ISSUE, query: $mine, first: 50) { nodes { ...pr } }
  reviews: search(type: ISSUE, query: $reviews, first: 30) { nodes { ...pr } }
  mentions: search(type: ISSUE, query: $mentions, first: 30) {
    nodes {
      __typename
      ... on Issue {
        number title url createdAt updatedAt body
        author { __typename login }
        repository { nameWithOwner }
        comments(last: 30) { nodes { ...comment } }
      }
      ... on PullRequest {
        number title url isDraft createdAt updatedAt body
        author { __typename login }
        repository { nameWithOwner }
        comments(last: 30) { nodes { ...comment } }
        reviewThreads(last: 30) { nodes { isResolved comments(first: 20) { nodes { ...comment } } } }
      }
    }
  }
  assigned: search(type: ISSUE, query: $assigned, first: 50) { nodes { ...issue } }
  commented: search(type: ISSUE, query: $commented, first: 30) { nodes { ...issue } }
  merged: search(type: ISSUE, query: $merged, first: 30) {
    nodes { ... on PullRequest { number title url mergedAt repository { nameWithOwner } } }
  }
}
fragment comment on Comment {
  id body createdAt
  author { __typename login }
  ... on IssueComment { url reactionGroups { viewerHasReacted } }
  ... on PullRequestReviewComment { url reactionGroups { viewerHasReacted } }
}
fragment issue on Issue {
  number title url updatedAt
  repository { nameWithOwner }
  comments(last: 1) { nodes { author { __typename login } createdAt } }
}
fragment pr on PullRequest {
  id number title url isDraft createdAt updatedAt
  author { __typename login }
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed defaultBranchRef { name } }
  baseRefName headRefName headRefOid isCrossRepository
  mergeable reviewDecision
  assignees(first: 10) { nodes { login } }
  closingIssuesReferences(first: 5) { nodes { number title url repository { nameWithOwner } } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestReviews(first: 10) { nodes { author { __typename login } state submittedAt } }
  reviewThreads(last: 30) {
    nodes {
      isResolved
      opener: comments(first: 1) { nodes { author { __typename login } createdAt } }
      comments(last: 1) { nodes { author { __typename login } createdAt } }
    }
  }
  comments(last: 10) { nodes { author { __typename login } createdAt } }
}`;

function scope(config: InboxConfig): string {
  return [...config.orgs.map((org) => `org:${org}`), ...config.repos.map((repo) => `repo:${repo}`)].join(" ");
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(now: Date): Date {
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday;
}

export function searchVariables(config: InboxConfig, now: Date): Record<string, string> {
  const where = `${scope(config)} archived:false`.trim();
  const since = isoDate(new Date(now.getTime() - config.mentionDays * 86_400_000));
  return {
    mine: `is:pr is:open author:@me ${where}`,
    // By name only, not via a team [REV-01].
    reviews: `is:pr is:open user-review-requested:@me ${where}`,
    mentions: `is:open mentions:@me updated:>=${since} ${where}`,
    assigned: `is:issue is:open assignee:@me ${where}`,
    commented: `is:issue is:open commenter:@me updated:>=${since} ${where}`,
    merged: `is:pr is:merged author:@me merged:>=${isoDate(startOfWeek(now))} ${where}`,
  };
}

export function prKey(pr: { repository: { nameWithOwner: string }; number: number }): string {
  return `${pr.repository.nameWithOwner}#${pr.number}`;
}

// One batched query for how far each PR's head is behind its base [GH-01].
export function compareQuery(prs: PullRequestNode[]): { query: string; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};
  const fields = prs.map((pr, index) => {
    const alias = `c${index}`;
    aliases[alias] = prKey(pr);
    const [owner, name] = pr.repository.nameWithOwner.split("/");
    return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      ref(qualifiedName: ${JSON.stringify(`refs/heads/${pr.baseRefName}`)}) {
        compare(headRef: ${JSON.stringify(pr.headRefName)}) { behindBy }
      }
    }`;
  });
  return { query: `query Behind {\n${fields.join("\n")}\n}`, aliases };
}
