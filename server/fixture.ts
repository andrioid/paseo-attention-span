import type { AgentSummary, ItemDetails, Reviewer, ReviewerChoices, Target } from "../shared/attention";
import type { SessionKind } from "../shared/config";
import type { Actor, Comment, Details, IssueNode, MentionNode, PickableNode, PullRequestNode, SearchResult } from "./github-types";

// Made-up GitHub data for tests and for previews without GitHub (PASEO_ATTENTION_SPAN_FIXTURE=1).

export const REPO = "acme/shop";
// Issues kept apart from the code, as some orgs do; its code lives in REPO [SES-07].
export const ISSUES_REPO = "acme/issues";
// What the settings screen can add in previews [SRC-02]; anything else isn't found.
export const FIXTURE_ORGS = ["acme"];
export const FIXTURE_REPOS = [REPO, ISSUES_REPO, "acme/web", "me/tool"];
// The orgs Next up's org picker offers in previews [NXT-04].
export const FIXTURE_MY_ORGS = ["acme", "globex"];
const repository = { nameWithOwner: REPO, squashMergeAllowed: true, defaultBranchRef: { name: "main" } };
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

export const me: Actor = { __typename: "User", login: "me" };
export const alice: Actor = { __typename: "User", login: "alice", avatarUrl: avatar(1) };
export const bob: Actor = { __typename: "User", login: "bob", avatarUrl: avatar(2) };
export const bot: Actor = { __typename: "Bot", login: "reviewbot" };
const frontend = { __typename: "Team", combinedSlug: "acme/frontend", avatarUrl: avatar(9919) };
// A tag as GitHub renders it in a comment [WAI-02].
const tag = (login: string) => `<a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/${login}">@${login}</a>`;

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
    // GitHub renders it too; plain text is enough for made-up comments, which pass their own rendering where it matters.
    const bodyHTML = `<p>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
    return { id: `IC_${comments}`, author, body, bodyHTML, createdAt: daysAgo(days), url: `https://github.com/${REPO}/issues/1#c${comments}`, reactionGroups: [], ...extra };
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

  // Someone else's issue unless `overrides` says otherwise.
  function issue(number: number, comments: Comment[] = [], title = `Issue ${number}`, overrides: Partial<IssueNode> = {}): IssueNode {
    return { __typename: "Issue", number, title, url: `https://github.com/${REPO}/issues/${number}`, createdAt: daysAgo(20), author: alice, repository, comments: { nodes: comments }, ...overrides };
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
      involved: nodes("involved") as SearchResult["involved"],
      asked: nodes("asked") as SearchResult["asked"],
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
  const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
  const merged = (number: number, title: string, days: number, closesIssue?: number, ...names: string[]) => ({
    number,
    title,
    url: `https://github.com/${REPO}/pull/${number}`,
    mergedAt: daysAgo(days),
    repository,
    labels: labels(...names),
    closingIssuesReferences: { nodes: closesIssue ? [{ number: closesIssue, repository }] : [] },
  });
  const closed = (number: number, title: string, days: number, stateReason = "COMPLETED", type?: string, ...names: string[]) => ({
    number,
    title,
    url: `https://github.com/${REPO}/issues/${number}`,
    closedAt: daysAgo(days),
    stateReason,
    repository,
    issueType: type ? { name: type } : null,
    labels: labels(...names),
  });

  const data = search({
    mine: [
      pr(101, { title: "Show delivery dates on the order page" }, "FAILURE"),
      pr(102, { title: "Retry webhook deliveries with backoff", reviewThreads: { nodes: [thread(alice, 1), thread(bot, 2)] } }),
      pr(103, { title: "Fetch supplier price files nightly", reviewDecision: "APPROVED", closingIssuesReferences: closes(90, "Supplier prices are a week out of date") }),
      pr(104, { title: "Move price-file login into a service", isDraft: true, baseRefName: "branch-103", headRefName: "branch-104" }),
      // A stack GitHub links to no issue: its descriptions say which [ATT-03].
      pr(105, { title: "Dialog focus returns to the trigger", body: "First of three stacked PRs for #132.", reviewDecision: "APPROVED", headRefName: "a11y-1" }),
      pr(106, { title: "Keyboard navigation for calendar cards", isDraft: true, baseRefName: "a11y-1", headRefName: "a11y-2", reviewDecision: "APPROVED" }),
      pr(107, { title: "Calendar: jump between weeks with keys", body: "Closes #132", isDraft: true, baseRefName: "a11y-2", headRefName: "a11y-3" }, "FAILURE"),
      pr(108, { title: "Company-scoped database layer", mergeable: "CONFLICTING" }),
      // Asked a team, and nobody has looked for 6 days [ATT-11, PRS-12].
      pr(109, { title: "Store uploads locally in development", reviewRequests: { nodes: [{ requestedReviewer: frontend }] }, commits: commit("SUCCESS", 6) }),
      pr(110, { title: "requirements.yaml for the shop", isDraft: true, updatedAt: daysAgo(64) }),
      pr(111, { title: "Faster product search", reviewRequests: { nodes: [{ requestedReviewer: bob }] }, commits: commit("SUCCESS", 0.3) }),
      pr(112, { title: "Translate the checkout emails", reviewDecision: "CHANGES_REQUESTED", latestReviews: { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(2) }] }, commits: commit("SUCCESS", 1) }),
      pr(113, { title: "Upgrade the payment SDK", reviewRequests: { nodes: [{ requestedReviewer: bob }, { requestedReviewer: alice }] } }, "PENDING"),
      pr(114, { title: "Cache exchange rates daily", reviewDecision: "APPROVED" }),
      pr(115, { title: "Split the settings page into tabs", isDraft: true, mergeable: "CONFLICTING" }),
      pr(116, { title: "Try a faster PDF renderer", isDraft: true }, "FAILURE"),
      pr(117, { title: "Harden the upload endpoint", reviewThreads: { nodes: [thread(bot, 1)] } }),
      pr(118, { title: "Send reminders for unpaid invoices", closingIssuesReferences: closes(95, "Customers forget unpaid invoices") }),
      pr(119, { title: "Show stock levels on product cards", isDraft: true }),
      pr(122, { title: "Round VAT per line, not per invoice", reviewDecision: "APPROVED", repository: { ...repository, autoMergeAllowed: true } }, "PENDING"),
      pr(123, { title: "Archive offers older than a year", reviewDecision: "APPROVED", autoMergeRequest: { enabledAt: daysAgo(0.1) } }, "PENDING"),
      // Nobody asked yet: green, so Merge too; and one still in CI [PRS-12].
      pr(124, { title: "Export invoices as CSV", commits: commit("SUCCESS", 0.5) }),
      pr(125, { title: "Log slow database queries" }, "PENDING"),
      // A review that only commented, and nobody asked again: GitHub says nobody owes a look, so it's mine to re-request [PRS-12].
      pr(126, { title: "Tidy the admin menu", latestReviews: { nodes: [{ author: alice, state: "COMMENTED", submittedAt: daysAgo(0.8) }] } }),
      // Approved and green, yet a repo rule blocks it, so it waits [PRS-13].
      pr(127, { title: "Sign the release artifacts", reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" }),
      // Only checks the repo doesn't require fail, or still run: ready all the same [PRS-14].
      pr(128, { title: "Lazy-load product images", reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" }, "FAILURE"),
      pr(129, { title: "Compress API responses", reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" }, "PENDING"),
    ],
    reviews: [
      pr(120, { title: "Add a status page", author: bob }),
      pr(121, { title: "Rework the cart totals", author: alice }),
      // Bob's stack asking for my review: one item with one Review [ATT-04].
      pr(196, { title: "Price rules: data model", author: bob, headRefName: "rules-1", commits: commit("SUCCESS", 0.4) }),
      pr(197, { title: "Price rules: admin screen", author: bob, baseRefName: "rules-1", headRefName: "rules-2", commits: commit("SUCCESS", 0.3) }),
    ],
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
    involved: [
      // Questions that tag people wait on them: several by picture, one by name [WAI-02].
      issue(
        140,
        [comment(alice, "", 9), comment(me, "@alice @bob which customers see this?", 1, { bodyHTML: `<p>${tag("alice")} ${tag("bob")} which customers see this?</p>` })],
        "Invoice totals round wrong",
      ),
      // Answered on my own issue without mentioning me [ATT-16]; and a bot after my question, which doesn't count [MEN-05].
      issue(142, [comment(me, "Does this happen on every shop, or only some?", 2), comment(alice, "Only the Danish one, as far as I can tell. It started after the **VAT change** on Monday.", 0.4)], "Order confirmation shows the wrong VAT", { author: me }),
      issue(
        143,
        [comment(me, "@bob can we drop the old endpoint yet?", 1, { bodyHTML: `<p>${tag("bob")} can we drop the old endpoint yet?</p>` }), comment(bot, "This issue has been labelled `needs-triage`.", 0.5)],
        "Retire the v1 orders endpoint",
      ),
      // A comment on my PR's conversation [ATT-16].
      issue(111, [comment(bob, "Big change. Could you split the index migration into its own PR?", 0.2)], "Faster product search", { __typename: "PullRequest", author: me, createdAt: daysAgo(2) }),
      // A statement that tags someone isn't a question: nobody owes me an answer, so it's not listed [WAI-01].
      issue(145, [comment(me, "@bob deployed the fix to staging.", 0.5, { bodyHTML: `<p>${tag("bob")} deployed the fix to staging.</p>` })], "Checkout hangs on slow networks"),
      // Someone else's old thread where people kept going after me: not mine to follow [ATT-16].
      issue(144, [comment(me, "Same here on 2.3", 400), comment(bob, "+1", 300)], "Crash on startup"),
    ],
    // My own issue, asked about long ago and never answered [ATT-11].
    asked: [issue(141, [comment(me, "Is this still needed?", 40)], "Rotate the analytics token", { author: me, createdAt: daysAgo(90) })],
    assigned: [
      pickable(150, fields("🏔 P1 High", "🐇 Small (0.5-2d)", "🔙 Backend"), 20, "Bug", "Orders export times out for big shops"),
      pickable(151, fields("🏕P2 Medium", "🐟 Tiny (< 4h)", "🔙 Backend"), 5, "Bug", "Price list import skips quoted rows", ISSUES_REPO),
    ],
    // Found by the preview config's Next up sources [NXT-09].
    unclaimed: [
      { ...pickable(160, fields("🌋 P0 Urgent", "🐂 Medium (2-5d)", "🕵 Full-stack"), 40, "Feature", "Follow-up emails for unanswered offers"), sources: ["org:acme"] },
      // Nobody's assigned, but alice has a PR open for it [NXT-10].
      {
        ...pickable(161, fields("🏝 P3 Low", "🐟 Tiny (< 4h)", "🔙 Backend"), 15, "Bug", "Deleted employee still shows in the calendar"),
        closedByPullRequestsReferences: { nodes: [{ number: 190, url: `https://github.com/${REPO}/pull/190`, state: "OPEN", author: { login: "alice" } }] },
        sources: ["org:acme"],
      },
      { ...pickable(162, fields("🏝 P3 Low", "🐇 Small (0.5-2d)", "🔙 Backend"), 30, "Debt", "Merge the two import commands"), sources: ["org:acme"] },
      { ...pickable(163, fields("🏝 P3 Low", "🐇 Small (0.5-2d)", "🖌 Frontend"), 8, "Bug", "Moving a task in the calendar loses its colour"), sources: ["org:acme"] },
      { ...pickable(164, fields("🏝 P3 Low", "🦑 Large (1-2w)", "📱 Mobile app"), 60, "Feature", "Offline mode for time tracking"), sources: ["org:acme"] },
      { ...pickable(165, {}, 3, "Task", "Devcontainers for pull requests", "me/tool"), sources: ["mine"] },
    ],
    merged: [
      merged(170, "Nightly backup check", 1, 171),
      merged(172, "Fix VAT on credit notes", 3, undefined, "bug"),
      merged(177, "chore: bump the build image", 4),
      merged(178, "Tidy the settings screen", 5),
      merged(173, "Speed up the order list", 9, 174),
      merged(175, "Remove the old importer", 16),
    ],
    reviewed: [
      { number: 180, title: "New onboarding checklist", url: `https://github.com/${REPO}/pull/180`, mergedAt: daysAgo(2), repository, author: alice, labels: labels("feature") },
      { number: 181, title: "Bump dependencies", url: `https://github.com/${REPO}/pull/181`, mergedAt: daysAgo(4), repository, author: bob },
      { number: 182, title: "Sentry release tracking", url: `https://github.com/${REPO}/pull/182`, mergedAt: daysAgo(11), repository, author: alice },
    ],
    closed: [
      closed(171, "Backups are never verified", 1, "COMPLETED", "Feature"),
      closed(174, "Order list takes 8 seconds", 9, "COMPLETED", undefined, "type: bug"),
      closed(176, "Dark mode for the admin", 10, "NOT_PLANNED", undefined, "enhancement"),
    ],
  });
  return {
    data,
    details: {
      behind: { [key(103)]: 1, [key(106)]: 12, [key(108)]: 139, [key(110)]: 2307, [key(114)]: 3, [key(115)]: 40 },
      fieldOptions: { Priority: ["🌋 P0 Urgent", "🏔 P1 High", "🏕P2 Medium", "🏝 P3 Low"] },
      issues: { [key(132)]: { number: 132, title: "The calendar can't be used with a keyboard", url: `https://github.com/${REPO}/issues/132`, repository } },
      checks: { [key(128)]: { required: 2, failing: 0, pending: 0 }, [key(129)]: { required: 1, failing: 0, pending: 0 } },
      mergeState: {},
    },
  };
}

// Sessions the preview shows as started from items: working, needs me, failed, idle.
// Each sits in its action's line in the sheet. Issue 90 has two: an old one with no kind, which leads, and Rebase stack on its PR.
// #113 waits on CI while its Fix CI session works, though Fix CI isn't one of its actions any more.
// #120's was started outside Attention Span, in a workspace Paseo linked to the PR, so it has no kind [SES-08].
// #197's too, so it shows on its stack, led by #196 [ATT-04].
const agent = (id: string, itemKey: string, kind: SessionKind | undefined, status: string, minutesAgo: number, requiresAttention = false): AgentSummary => ({
  id,
  itemKey,
  kind,
  status,
  requiresAttention,
  title: `Fixture session ${id}`,
  workspaceId: null,
  lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});
export const FIXTURE_AGENTS: AgentSummary[] = [
  agent("agent-101", `${REPO}#101`, "fix", "running", 4),
  agent("agent-102", `${REPO}#102`, "address", "idle", 30, true),
  agent("agent-108", `${REPO}#108`, "rebase", "error", 90),
  agent("agent-150", `${REPO}#150`, "start", "idle", 300),
  agent("agent-90", `${REPO}#90`, undefined, "idle", 120, true),
  agent("agent-103", `${REPO}#103`, "rebase", "running", 6),
  agent("agent-113", `${REPO}#113`, "fix", "running", 2),
  agent("agent-120", `${REPO}#120`, undefined, "running", 3),
  agent("agent-197", `${REPO}#197`, undefined, "idle", 15),
];

export const FIXTURE_CONTEXT = "Context from GitHub would go here (fixture mode).";

// What the reviewer picker offers in previews: GitHub's suggestion, who reviewed my other PRs, and a team [PRS-12].
export function fixtureReviewerChoices(recent: Reviewer[]): ReviewerChoices {
  return {
    suggested: [{ login: "carol", avatarUrl: avatar(3), team: false }],
    recent,
    teams: [{ login: "acme/frontend", team: true }, { login: "acme/payments", team: true }],
  };
}

// What a sheet shows, made up: a size, the linked issue, and failing checks for Rerun.
export function fixtureDetails(subject: { kind: "pr" | "issue"; repo: string; number: number }, target: Target | undefined, checks: boolean): ItemDetails {
  const pr = target?.kind === "pr" ? target : undefined;
  return {
    size: pr ? { additions: 84 + (pr.number % 7) * 13, deletions: 12 + (pr.number % 5), files: 2 + (pr.number % 4) } : undefined,
    linked: subject.number === 120 ? [{ number: 200, title: "Customers can't tell when the shop is down", url: `https://github.com/${REPO}/issues/200`, state: "OPEN" }] : [],
    failing: checks && pr ? [{ pr: pr.number, checks: [{ name: "lint", rerunnable: true }, { name: "e2e (chromium)", rerunnable: true }], runs: [{ id: 9001, attempt: 1 }] }] : [],
  };
}
