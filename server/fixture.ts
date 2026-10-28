import type { AgentSummary, ItemDetails, Target } from "../shared/inbox";
import type { Actor, Comment, Details, IssueNode, MentionNode, PickableNode, PullRequestNode, SearchResult } from "./github-types";

// Made-up GitHub data for tests and for previews without GitHub (PASEO_GITHUB_ATTENTION_FIXTURE=1).

export const REPO = "acme/shop";
// Issues kept apart from the code, as some orgs do; its code lives in REPO [SES-07].
export const ISSUES_REPO = "acme/issues";
const repository = { nameWithOwner: REPO, squashMergeAllowed: true, defaultBranchRef: { name: "main" } };
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

export const me: Actor = { __typename: "User", login: "me" };
export const alice: Actor = { __typename: "User", login: "alice", avatarUrl: avatar(1) };
export const bob: Actor = { __typename: "User", login: "bob", avatarUrl: avatar(2) };
export const bot: Actor = { __typename: "Bot", login: "reviewbot" };

export function builders(now: Date) {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const commit = (ci: string | null, days = 1) => ({ nodes: [{ commit: { committedDate: daysAgo(days), statusCheckRollup: ci ? { state: ci } : null } }] });
  const thread = (author: Actor, days: number, isResolved = false) => ({ isResolved, comments: { nodes: [comment(author, "", days)] } });
  let comments = 0;

  function pr(number: number, overrides: Partial<PullRequestNode> = {}, ci: string | null = "SUCCESS"): PullRequestNode {
    return {
      id: `PR_${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${REPO}/pull/${number}`,
      isDraft: false,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(1),
      author: me,
      repository,
      baseRefName: "main",
      headRefName: `branch-${number}`,
      headRefOid: `oid${number}`,
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      assignees: { nodes: [] },
      closingIssuesReferences: { nodes: [] },
      commits: commit(ci),
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      ...overrides,
    };
  }

  function comment(author: Actor, body: string, days: number, extra: Partial<Comment> = {}): Comment {
    comments += 1;
    return { id: `IC_${comments}`, author, body, createdAt: daysAgo(days), url: `https://github.com/${REPO}/issues/1#c${comments}`, reactionGroups: [], ...extra };
  }

  function mention(number: number, comments: Comment[], overrides: Partial<MentionNode> = {}): MentionNode {
    return {
      __typename: "Issue",
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${REPO}/issues/${number}`,
      createdAt: daysAgo(5),
      author: alice,
      body: "no mention here",
      repository,
      comments: { nodes: comments },
      ...overrides,
    };
  }

  function issue(number: number, comments: Comment[] = [], title = `Issue ${number}`): IssueNode {
    return { number, title, url: `https://github.com/${REPO}/issues/${number}`, repository, comments: { nodes: comments } };
  }

  function pickable(number: number, fields: Record<string, string>, createdDaysAgo = 10, type = "Bug", title = `Issue ${number}`, repo = REPO): PickableNode {
    return {
      number,
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      createdAt: daysAgo(createdDaysAgo),
      repository: repo === REPO ? repository : { nameWithOwner: repo, defaultBranchRef: { name: "main" } },
      issueType: { name: type },
      issueFieldValues: { nodes: Object.entries(fields).map(([field, name]) => ({ name, field: { name: field } })) },
    };
  }

  function search(parts: Partial<{ [K in Exclude<keyof SearchResult, "viewer">]: SearchResult[K]["nodes"] }>): SearchResult {
    const nodes = <K extends keyof typeof parts>(key: K) => ({ nodes: parts[key] ?? [] });
    return {
      viewer: { login: "me", id: "U_me" },
      mine: nodes("mine") as SearchResult["mine"],
      reviews: nodes("reviews") as SearchResult["reviews"],
      mentions: nodes("mentions") as SearchResult["mentions"],
      commented: nodes("commented") as SearchResult["commented"],
      assigned: nodes("assigned") as SearchResult["assigned"],
      unclaimed: nodes("unclaimed") as SearchResult["unclaimed"],
      merged: nodes("merged") as SearchResult["merged"],
      reviewed: nodes("reviewed") as SearchResult["reviewed"],
      closed: nodes("closed") as SearchResult["closed"],
    };
  }

  return { daysAgo, commit, thread, pr, comment, mention, issue, pickable, search };
}

// One of everything the screen can show.
export function fixture(now: Date): { data: SearchResult; details: Details } {
  const { daysAgo, commit, thread, pr, comment, mention, issue, pickable, search } = builders(now);
  const key = (n: number) => `${REPO}#${n}`;
  const closes = (number: number, title: string) => ({ nodes: [{ number, title, url: `https://github.com/${REPO}/issues/${number}`, repository }] });
  const fields = (priority: string, effort: string, scope: string) => ({ Priority: priority, Effort: effort, Scope: scope });
  const merged = (number: number, title: string, days: number, closesIssue?: number) => ({
    number,
    title,
    url: `https://github.com/${REPO}/pull/${number}`,
    mergedAt: daysAgo(days),
    repository,
    closingIssuesReferences: { nodes: closesIssue ? [{ number: closesIssue, repository }] : [] },
  });
  const closed = (number: number, title: string, days: number, stateReason = "COMPLETED") => ({
    number,
    title,
    url: `https://github.com/${REPO}/issues/${number}`,
    closedAt: daysAgo(days),
    stateReason,
    repository,
  });

  const data = search({
    mine: [
      pr(101, { title: "Show delivery dates on the order page" }, "FAILURE"),
      pr(102, { title: "Retry webhook deliveries with backoff", reviewThreads: { nodes: [thread(alice, 1), thread(bot, 2)] } }),
      pr(103, { title: "Fetch supplier price files nightly", reviewDecision: "APPROVED", closingIssuesReferences: closes(90, "Supplier prices are a week out of date") }),
      pr(104, { title: "Move price-file login into a service", isDraft: true, baseRefName: "branch-103", headRefName: "branch-104" }),
      pr(105, { title: "Dialog focus returns to the trigger", reviewDecision: "APPROVED", headRefName: "a11y-1" }),
      pr(106, { title: "Keyboard navigation for calendar cards", isDraft: true, baseRefName: "a11y-1", headRefName: "a11y-2", reviewDecision: "APPROVED" }),
      pr(107, { title: "Calendar: jump between weeks with keys", isDraft: true, baseRefName: "a11y-2", headRefName: "a11y-3" }, "FAILURE"),
      pr(108, { title: "Company-scoped database layer", mergeable: "CONFLICTING" }),
      pr(109, { title: "Store uploads locally in development", commits: commit("SUCCESS", 6) }),
      pr(110, { title: "requirements.yaml for the shop", isDraft: true, updatedAt: daysAgo(64) }),
      pr(111, { title: "Faster product search", reviewRequests: { nodes: [{ requestedReviewer: bob }] }, commits: commit("SUCCESS", 0.3) }),
      pr(112, { title: "Translate the checkout emails", reviewDecision: "CHANGES_REQUESTED", latestReviews: { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(2) }] }, commits: commit("SUCCESS", 1) }),
      pr(113, { title: "Upgrade the payment SDK" }, "PENDING"),
      pr(114, { title: "Cache exchange rates daily", reviewDecision: "APPROVED" }),
      pr(115, { title: "Split the settings page into tabs", isDraft: true, mergeable: "CONFLICTING" }),
      pr(116, { title: "Try a faster PDF renderer", isDraft: true }, "FAILURE"),
      pr(117, { title: "Harden the upload endpoint", reviewThreads: { nodes: [thread(bot, 1)] } }),
      pr(118, { title: "Send reminders for unpaid invoices", closingIssuesReferences: closes(95, "Customers forget unpaid invoices") }),
      pr(119, { title: "Show stock levels on product cards", isDraft: true }),
      pr(122, { title: "Round VAT per line, not per invoice", reviewDecision: "APPROVED", repository: { ...repository, autoMergeAllowed: true } }, "PENDING"),
      pr(123, { title: "Archive offers older than a year", reviewDecision: "APPROVED", autoMergeRequest: { enabledAt: daysAgo(0.1) } }, "PENDING"),
    ],
    reviews: [pr(120, { title: "Add a status page", author: bob }), pr(121, { title: "Rework the cart totals", author: alice })],
    mentions: [
      mention(95, [comment(bob, "@me should reminders go out on weekends too, or only on workdays?", 0.5)], { title: "Customers forget unpaid invoices", author: bob }),
      mention(121, [comment(alice, "@me could you look at the rounding in `totals.ts` first? That's the **risky** part.", 0.2)], { __typename: "PullRequest", title: "Rework the cart totals" }),
      mention(
        130,
        [
          comment(alice, "Can we make it easy to get in touch? @me do you see anything harmful here?", 3),
          comment(
            bob,
            "@me also, should the contact be the shared `security@` inbox or a person? I'd rather not put a personal address in a public file.\n\n- shared inbox: nobody owns it\n- a person: leaves with them\n\nSee [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116).",
            2,
          ),
        ],
        { __typename: "PullRequest", title: "Publish security.txt" },
      ),
      mention(131, [], {
        __typename: "PullRequest",
        title: "Close two privilege escalations",
        reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [comment(bot, "@me this endpoint leaks the API key in its response", 1)] } }] },
      }),
    ],
    commented: [issue(140, [comment(alice, "", 9), comment(me, "Which customers see this?", 1)], "Invoice totals round wrong"), issue(141, [comment(me, "Is this still needed?", 12)], "Rotate the analytics token")],
    assigned: [
      pickable(150, fields("🏔 P1 High", "🐇 Small (0.5-2d)", "🔙 Backend"), 20, "Bug", "Orders export times out for big shops"),
      pickable(151, fields("🏕P2 Medium", "🐟 Tiny (< 4h)", "🔙 Backend"), 5, "Bug", "Price list import skips quoted rows", ISSUES_REPO),
    ],
    unclaimed: [
      pickable(160, fields("🏕P2 Medium", "🐂 Medium (2-5d)", "🕵 Full-stack"), 40, "Feature", "Follow-up emails for unanswered offers"),
      pickable(161, fields("🏝 P3 Low", "🐟 Tiny (< 4h)", "🔙 Backend"), 15, "Bug", "Deleted employee still shows in the calendar"),
      pickable(162, fields("🏝 P3 Low", "🐇 Small (0.5-2d)", "🔙 Backend"), 30, "Debt", "Merge the two import commands"),
      pickable(163, fields("🏝 P3 Low", "🐇 Small (0.5-2d)", "🖌 Frontend"), 8, "Bug", "Moving a task in the calendar loses its colour"),
      pickable(164, fields("🏝 P3 Low", "🦑 Large (1-2w)", "📱 Mobile app"), 60, "Feature", "Offline mode for time tracking"),
      pickable(165, {}, 3, "Task", "Devcontainers for pull requests"),
    ],
    merged: [merged(170, "Nightly backup check", 1, 171), merged(172, "Fix VAT on credit notes", 3), merged(173, "Speed up the order list", 9, 174), merged(175, "Remove the old importer", 16)],
    reviewed: [
      { number: 180, title: "New onboarding checklist", url: `https://github.com/${REPO}/pull/180`, mergedAt: daysAgo(2), repository, author: alice },
      { number: 181, title: "Bump dependencies", url: `https://github.com/${REPO}/pull/181`, mergedAt: daysAgo(4), repository, author: bob },
      { number: 182, title: "Sentry release tracking", url: `https://github.com/${REPO}/pull/182`, mergedAt: daysAgo(11), repository, author: alice },
    ],
    closed: [closed(171, "Backups are never verified", 1), closed(174, "Order list takes 8 seconds", 9), closed(176, "Dark mode for the admin", 10, "NOT_PLANNED")],
  });
  return { data, details: { behind: { [key(103)]: 1, [key(106)]: 12, [key(108)]: 139, [key(110)]: 2307, [key(114)]: 3, [key(115)]: 40 }, fieldOptions: { Priority: ["🌋 P0 Urgent", "🏔 P1 High", "🏕P2 Medium", "🏝 P3 Low"] } } };
}

// Sessions the preview shows as started from items: working, needs me, failed, idle.
const agent = (id: string, status: string, requiresAttention = false): AgentSummary => ({ id, status, requiresAttention, title: `Fixture session ${id}`, workspaceId: null });
export const FIXTURE_AGENTS: Record<string, AgentSummary> = {
  [`${REPO}#101`]: agent("agent-101", "running"),
  [`${REPO}#102`]: agent("agent-102", "idle", true),
  [`${REPO}#108`]: agent("agent-108", "error"),
  [`${REPO}#150`]: agent("agent-150", "idle"),
};

export const FIXTURE_CONTEXT = "Context from GitHub would go here (fixture mode).";

// What a sheet shows, made up: a size, the linked issue, and failing checks for Rerun.
export function fixtureDetails(subject: { kind: "pr" | "issue"; repo: string; number: number }, target: Target | undefined, checks: boolean): ItemDetails {
  const pr = target?.kind === "pr" ? target : undefined;
  return {
    size: pr ? { additions: 84 + (pr.number % 7) * 13, deletions: 12 + (pr.number % 5), files: 2 + (pr.number % 4) } : undefined,
    linked: subject.number === 120 ? [{ number: 200, title: "Customers can't tell when the shop is down", url: `https://github.com/${REPO}/issues/200`, state: "OPEN" }] : [],
    failing: checks && pr ? [{ pr: pr.number, checks: [{ name: "lint", rerunnable: true }, { name: "e2e (chromium)", rerunnable: true }], runs: [{ id: 9001, attempt: 1 }] }] : [],
  };
}
