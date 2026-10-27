import type { InboxConfig } from "../shared/config";
import type { PullRequestNode } from "./github-types";

// One query with search aliases covers everything the inbox shows [GH-01].
export const SEARCH_QUERY = `
query Inbox(
  $mine: String!, $reviews: String!, $mentions: String!, $assigned: String!, $commented: String!,
  $unclaimed: String!, $merged: String!, $reviewed: String!, $closed: String!
) {
  viewer { login id }
  mine: search(type: ISSUE, query: $mine, first: 50) { nodes { ...pr } }
  reviews: search(type: ISSUE, query: $reviews, first: 30) { nodes { ...pr } }
  mentions: search(type: ISSUE, query: $mentions, first: 30) {
    nodes {
      __typename
      ... on Issue { number title url createdAt body author { ...author } repository { nameWithOwner } comments(last: 30) { nodes { ...comment } } }
      ... on PullRequest {
        number title url createdAt body author { ...author } repository { nameWithOwner } comments(last: 30) { nodes { ...comment } }
        reviews(last: 20) { nodes { author { login } submittedAt } }
        reviewThreads(last: 30) { nodes { isResolved comments(first: 20) { nodes { ...comment } } } }
      }
    }
  }
  commented: search(type: ISSUE, query: $commented, first: 30) {
    nodes { ... on Issue { number title url repository { nameWithOwner } comments(last: 1) { nodes { author { login } createdAt } } } }
  }
  assigned: search(type: ISSUE, query: $assigned, first: 50) { nodes { ...pickable } }
  unclaimed: search(type: ISSUE, query: $unclaimed, first: 100) { nodes { ...pickable } }
  merged: search(type: ISSUE, query: $merged, first: 100) {
    nodes { ... on PullRequest { number title url mergedAt repository { nameWithOwner } closingIssuesReferences(first: 3) { nodes { number repository { nameWithOwner } } } } }
  }
  reviewed: search(type: ISSUE, query: $reviewed, first: 100) {
    nodes { ... on PullRequest { number title url mergedAt repository { nameWithOwner } author { ...author } } }
  }
  closed: search(type: ISSUE, query: $closed, first: 100) {
    nodes { ... on Issue { number title url closedAt stateReason repository { nameWithOwner } } }
  }
}
fragment author on Actor { __typename login avatarUrl(size: 64) }
fragment comment on Comment {
  body createdAt
  author { ...author }
  ... on IssueComment { url reactionGroups { viewerHasReacted } }
  ... on PullRequestReviewComment { url reactionGroups { viewerHasReacted } }
}
fragment pickable on Issue {
  number title url createdAt
  repository { nameWithOwner defaultBranchRef { name } }
  issueType { name }
  issueFieldValues(first: 20) { nodes { ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldCommon { name } } } } }
}
fragment pr on PullRequest {
  id number title url isDraft createdAt updatedAt
  author { ...author }
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed defaultBranchRef { name } }
  baseRefName headRefName headRefOid isCrossRepository mergeable reviewDecision
  assignees(first: 10) { nodes { login } }
  closingIssuesReferences(first: 5) { nodes { number title url repository { nameWithOwner } } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 5) { nodes { requestedReviewer { ... on User { ...author } } } }
  latestReviews(first: 10) { nodes { author { ...author } state submittedAt } }
  reviewThreads(last: 30) {
    nodes {
      isResolved
      opener: comments(first: 1) { nodes { author { __typename login } } }
      comments(last: 1) { nodes { author { login } createdAt } }
    }
  }
  comments(last: 10) { nodes { author { login } createdAt } }
}`;

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

export function searchVariables(config: InboxConfig, now: Date): Record<string, string> {
  const scope = where(config.orgs, config.repos);
  const since = isoDate(new Date(now.getTime() - config.mentionDays * 86_400_000));
  // Whole weeks, from a Monday, so the oldest week isn't cut short.
  const history = isoDate(new Date(startOfWeek(now).getTime() - (config.historyWeeks - 1) * 7 * 86_400_000));
  return {
    mine: `is:pr is:open author:@me ${scope}`,
    // By name only, not via a team [REV-01].
    reviews: `is:pr is:open user-review-requested:@me ${scope}`,
    mentions: `is:open mentions:@me updated:>=${since} ${scope}`,
    assigned: `is:issue is:open assignee:@me ${scope}`,
    commented: `is:issue is:open commenter:@me updated:>=${since} ${scope}`,
    // [NXT-01, NXT-04]
    unclaimed: `is:issue is:open no:assignee ${config.nextUp.repos ? where([], config.nextUp.repos) : scope}`,
    // History [HIS-01, HIS-02]
    merged: `is:pr is:merged author:@me merged:>=${history} ${scope}`,
    reviewed: `is:pr is:merged reviewed-by:@me -author:@me merged:>=${history} ${scope}`,
    closed: `is:issue is:closed assignee:@me closed:>=${history} ${scope}`,
  };
}

export function prKey(node: { repository: { nameWithOwner: string }; number: number }): string {
  return `${node.repository.nameWithOwner}#${node.number}`;
}

// Second request: how far my PRs are behind their bases, and the option order of org issue fields [GH-01].
export function detailsQuery(prs: PullRequestNode[], orgs: string[]): { query: string; compares: Record<string, string> } {
  const compares: Record<string, string> = {};
  const fields = prs.map((pr, index) => {
    compares[`c${index}`] = prKey(pr);
    const [owner, name] = pr.repository.nameWithOwner.split("/");
    return `c${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      ref(qualifiedName: ${JSON.stringify(`refs/heads/${pr.baseRefName}`)}) { compare(headRef: ${JSON.stringify(pr.headRefName)}) { behindBy } }
    }`;
  });
  orgs.forEach((org, index) =>
    fields.push(`o${index}: organization(login: ${JSON.stringify(org)}) {
      issueFields(first: 50) { nodes { ... on IssueFieldSingleSelect { name options { name } } } }
    }`),
  );
  return { query: `query Details {\n${fields.join("\n")}\n}`, compares };
}
