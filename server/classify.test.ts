import { describe, expect, it } from "vitest";
import { InboxConfig } from "../shared/config";
import type { Item } from "../shared/inbox";
import { classify, classifyHistory } from "./classify";
import { alice, bob, bot, builders, fixture, me, REPO } from "./fixture";
import { HISTORY_SEARCHES, LIVE_SEARCHES, searchQuery, searchVariables } from "./queries";

const NOW = new Date("2026-10-28T12:00:00Z"); // a Wednesday
const config = InboxConfig.parse({ orgs: ["acme"] });
const { daysAgo, commit, thread, pr, comment, mention, issue, pickable, search } = builders(NOW);
const key = (n: number) => `${REPO}#${n}`;
const chips = (item: { chips: { text: string }[] }) => item.chips.map((chip) => chip.text);
const sections = (items: Item[]) => items.map((item) => [item.number, item.section]);

function run(parts: Parameters<typeof search>[0], behind: Record<string, number> = {}, options: { config?: InboxConfig; fieldOptions?: Record<string, string[]> } = {}) {
  return classify({ data: search(parts), details: { behind, fieldOptions: options.fieldOptions ?? {} }, config: options.config ?? config, now: NOW });
}
const doing = (inbox: ReturnType<typeof run>) => inbox.items.filter((item) => !item.section.startsWith("wait_"));

describe("doing", () => {
  it("ATT-02: puts each item once, under its most urgent reason, in section order", () => {
    const changes = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(0.5) }] };
    const inbox = run({
      mine: [pr(1, { reviewDecision: "APPROVED" }), pr(2, {}, "FAILURE"), pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews: changes }, "FAILURE")],
      reviews: [pr(9, { author: alice })],
    });
    // Newest activity by others first within a section.
    expect(sections(inbox.items)).toEqual([[9, "review"], [3, "ci"], [2, "ci"], [1, "ready"]]);
  });

  it("REV-01: lists PRs requesting my review, showing the author", () => {
    const [item] = run({ reviews: [pr(9, { author: alice })] }).items;
    expect(item).toMatchObject({ section: "review", actions: ["review"], person: { login: "alice", avatarUrl: alice.avatarUrl } });
  });

  it("PRS-01: lists my PRs with failing checks with a Fix action", () => {
    const [item] = run({ mine: [pr(2, {}, "ERROR")] }).items;
    expect(item).toMatchObject({ section: "ci", actions: ["fix"] });
    expect(item.chips).toContainEqual({ text: "CI failing", tone: "bad" });
  });

  it("PRS-02: lists unresolved threads waiting on me; a thread I answered waits on the reviewer", () => {
    expect(run({ mine: [pr(3, { reviewThreads: { nodes: [thread(alice, 1)] } })] }).items[0]).toMatchObject({ section: "changes", actions: ["address"] });
    expect(sections(run({ mine: [pr(3, { reviewThreads: { nodes: [thread(me, 1)] } })] }).items)).toEqual([[3, "wait_reviewer"]]);
  });

  it("PRS-02: requested changes followed by a new push wait on that reviewer", () => {
    const latestReviews = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(1.5) }] };
    const [item] = run({ mine: [pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews })] }).items;
    expect(item).toMatchObject({ section: "wait_reviewer", person: { login: "alice" } });
  });
});

describe("ready to merge and behind base", () => {
  it("PRS-03, PRS-04: offers Merge only when CI passed against the current base", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, { [key(1)]: 0 }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["merge"], target: { mergeMethod: "squash" } });
    expect(chips(item)).toEqual(["approved", "CI passed"]);
  });

  it("UPS-03, PRS-04: a ready PR behind its base offers Update instead of Merge", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, { [key(1)]: 1 }).items;
    expect(item.actions).toEqual(["update"]);
    expect(item.chips).toEqual([{ text: "approved", tone: "good" }, { text: "1 behind main", tone: "neutral" }]);
  });

  it("UPS-07: the behind chip stays neutral however far behind; only conflicts are flagged", () => {
    const [item] = run({ mine: [pr(1, { mergeable: "CONFLICTING" })] }, { [key(1)]: 2307 }).items;
    expect(item.chips).toEqual([{ text: "conflicts", tone: "bad" }, { text: "2307 behind main", tone: "neutral" }]);
  });

  it("UPS-07: being behind alone never puts a PR in Doing", () => {
    expect(sections(run({ mine: [pr(1)] }, { [key(1)]: 400 }).items)).toEqual([[1, "wait_review"]]);
  });

  it("UPS-01: a PR that conflicts with its base needs upstream, with Rebase", () => {
    const [item] = run({ mine: [pr(1, { mergeable: "CONFLICTING" })] }, { [key(1)]: 139 }).items;
    expect(item).toMatchObject({ section: "upstream", actions: ["rebase"] });
    expect(chips(item)).toEqual(["conflicts", "139 behind main"]);
  });

  it("PRS-04: uses the merge method from config, else the first the repo allows", () => {
    const noSquash = pr(1, { reviewDecision: "APPROVED", repository: { nameWithOwner: REPO, squashMergeAllowed: false, mergeCommitAllowed: true } });
    expect(run({ mine: [noSquash] }).items[0].target.mergeMethod).toBe("merge");
    const configured = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, {}, { config: InboxConfig.parse({ mergeMethods: { [REPO]: "rebase" } }) });
    expect(configured.items[0].target.mergeMethod).toBe("rebase");
  });
});

describe("stacks", () => {
  const bottom = pr(10, { headRefName: "a" });
  const middle = pr(11, { baseRefName: "a", headRefName: "b", isDraft: true, reviewDecision: "APPROVED" });
  const top = pr(12, { baseRefName: "b", headRefName: "c", isDraft: true });

  it("ATT-04: shows a stack as one item led by its bottom PR", () => {
    const inbox = run({ mine: [top, bottom, middle] }, { [key(11)]: 279 });
    expect(inbox.items).toHaveLength(1);
    const [item] = inbox.items;
    expect(item.number).toBe(10);
    expect(item.children.map((child) => [child.number, child.draft, chips(child)])).toEqual([
      [11, true, ["2/3", "approved", "279 behind #10"]],
      [12, true, ["3/3"]],
    ]);
    // Only the child behind its parent needs attention when the stack is collapsed.
    expect(item.children.map((child) => child.attention)).toEqual([true, false]);
    expect(item.target.stack).toEqual([
      { number: 10, head: "a", base: "main" },
      { number: 11, head: "b", base: "a" },
      { number: 12, head: "c", base: "b" },
    ]);
  });

  it("UPS-02, UPS-04: a stacked PR behind its parent puts the stack under Needs upstream with Rebase", () => {
    const [item] = run({ mine: [bottom, middle, top] }, { [key(11)]: 3 }).items;
    expect(item).toMatchObject({ section: "upstream", actions: ["rebase"] });
    expect(chips(item)).toContain("stack of 3");
  });

  it("UPS-03: a stacked ready PR behind its base gets Rebase, not Update", () => {
    const [item] = run({ mine: [pr(10, { headRefName: "a", reviewDecision: "APPROVED" }), middle] }, { [key(10)]: 2 }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["rebase"] });
  });
});

describe("drafts", () => {
  it("PRS-05: lists my drafts after everything that isn't a draft", () => {
    expect(run({ mine: [pr(1, { isDraft: true }), pr(2, {}, "FAILURE")] }).items.map((item) => item.section)).toEqual(["ci", "drafts"]);
  });

  it("PRS-06: other people's drafts are not work items", () => {
    expect(run({ mentions: [mention(90, [comment(alice, "wip", 1)], { __typename: "PullRequest" })] }).items).toEqual([]);
  });

  it("PRS-07: a draft untouched for 30 days offers Refresh and Close", () => {
    const [item] = run({ mine: [pr(1, { isDraft: true, updatedAt: daysAgo(60), mergeable: "CONFLICTING" })] }).items;
    expect(item).toMatchObject({ draft: true, actions: ["refresh", "close"] });
    expect(chips(item)).toContain("untouched 2 months");
  });

  it("PRS-08: leaves out my PRs assigned to someone else", () => {
    const handedOver = pr(1, { isDraft: true, assignees: { nodes: [{ login: "alice" }] } });
    const shared = pr(2, { isDraft: true, assignees: { nodes: [{ login: "alice" }, { login: "me" }] } });
    expect(run({ mine: [handedOver, shared] }).items.map((item) => item.number)).toEqual([2]);
  });
});

describe("issues", () => {
  it("ATT-03: a mention on the issue makes it a reply, without the waiting PR's duration chip", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } }] };
    const inbox = run({ mine: [pr(1, { closingIssuesReferences: closes })], mentions: [mention(50, [comment(bob, "@me weekends too?", 0.5)])] });
    expect(inbox.items[0]).toMatchObject({ kind: "issue", number: 50, section: "reply", person: { login: "bob" } });
    expect(chips(inbox.items[0])).toEqual(["PR #1"]);
  });

  it("ATT-03: groups PRs under the issue they close, led by the issue", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } }] };
    const inbox = run({
      mine: [pr(1, { closingIssuesReferences: closes }, "FAILURE"), pr(2, { closingIssuesReferences: closes, reviewDecision: "APPROVED" })],
      assigned: [pickable(50, {})],
    });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ kind: "issue", number: 50, section: "ci", actions: ["fix"], target: { number: 1 } });
    expect(inbox.items[0].children.map((child) => child.number)).toEqual([1, 2]);
    expect(inbox.assigned).toEqual([]); // already in progress
  });
});

describe("waiting", () => {
  it("WAI-01: groups my work by what it waits for, with who I'm waiting on", () => {
    const inbox = run({
      mine: [pr(1, { reviewRequests: { nodes: [{ requestedReviewer: bob }] } }), pr(2, {}, "PENDING")],
      commented: [issue(70, [comment(me, "", 1)]), issue(72, [comment(alice, "", 1)])],
    });
    expect(sections(inbox.items)).toEqual([[1, "wait_review"], [2, "wait_ci"], [70, "wait_answer"]]);
    expect(inbox.items[0]).toMatchObject({ person: { login: "bob", avatarUrl: bob.avatarUrl }, chips: [{ text: "1d" }] });
  });

  it("ATT-11: after 3 days it moves to Doing as Waiting too long", () => {
    const inbox = run({ mine: [pr(1, { commits: commit("SUCCESS", 4) })], commented: [issue(71, [comment(me, "", 5)])] });
    expect(sections(inbox.items)).toEqual([[1, "too_long"], [71, "too_long"]]);
    expect(chips(inbox.items[0])).toEqual(["waiting for review · 4d"]);
  });
});

describe("history", () => {
  it("HIS-01: lists closed issues with the PRs that closed them, and lone merged PRs", () => {
    const items = classifyHistory(search({
      closed: [{ number: 60, title: "Backups", url: "u", closedAt: daysAgo(1), stateReason: "COMPLETED", repository: { nameWithOwner: REPO } }],
      merged: [
        { number: 61, title: "Verify backups", url: "u", mergedAt: daysAgo(1), repository: { nameWithOwner: REPO }, closingIssuesReferences: { nodes: [{ number: 60, repository: { nameWithOwner: REPO } }] } },
        { number: 62, title: "Fix VAT", url: "u", mergedAt: daysAgo(2), repository: { nameWithOwner: REPO }, closingIssuesReferences: { nodes: [] } },
      ],
    }));
    expect(items.map((item) => [item.number, item.section, item.closedAt, item.children.map((c) => c.number)])).toEqual([
      [60, "done", daysAgo(1), [61]],
      [62, "done", daysAgo(2), []],
    ]);
  });

  it("HIS-02: lists PRs I reviewed apart from my own work, with their author", () => {
    const [item] = classifyHistory(search({ reviewed: [{ number: 63, title: "Onboarding", url: "u", mergedAt: daysAgo(3), repository: { nameWithOwner: REPO }, author: alice }] }));
    expect(item).toMatchObject({ section: "reviewed", person: { login: "alice" } });
  });

  it("HIS-01: searches whole weeks back from Monday", () => {
    expect(searchVariables(config, NOW).merged).toContain("merged:>=2026-10-05"); // 4 weeks: Oct 5, 12, 19, 26
  });
});

describe("mentions", () => {
  it("MEN-01: lists a thread where a person mentioned me and is waiting", () => {
    const [item] = run({ mentions: [mention(80, [comment(alice, "hey @me can you check the login flow?", 3)])] }).items;
    expect(item).toMatchObject({ section: "reply", actions: ["reply"], person: { login: "alice", avatarUrl: alice.avatarUrl, bot: false } });
    expect(item.person?.snippet).toContain("@me can you check");
  });

  it("MEN-02: replying, reacting or submitting a review clears a mention", () => {
    const replied = mention(80, [comment(alice, "@me ?", 3), comment(me, "done", 2)]);
    const reacted = mention(81, [comment(alice, "@me ?", 3, { reactionGroups: [{ viewerHasReacted: true }] })]);
    const reviewed = mention(82, [comment(alice, "@me anything harmful here?", 3)], { __typename: "PullRequest", reviews: { nodes: [{ author: me, submittedAt: daysAgo(1) }] } });
    expect(run({ mentions: [replied, reacted, reviewed] }).items).toEqual([]);
  });

  it("MEN-02: a review before the mention doesn't clear it", () => {
    const earlier = mention(83, [comment(alice, "@me one more thing", 1)], { __typename: "PullRequest", reviews: { nodes: [{ author: me, submittedAt: daysAgo(3) }] } });
    expect(run({ mentions: [earlier] }).items).toHaveLength(1);
  });

  it("MEN-03: counts mentions in other people's drafts", () => {
    expect(run({ mentions: [mention(82, [comment(alice, "early look please @me", 1)], { __typename: "PullRequest" })] }).items.map((item) => item.number)).toEqual([82]);
  });

  it("MEN-04: ignores team mentions and quoted mentions", () => {
    expect(run({ mentions: [mention(83, [comment(alice, "@acme/me please look", 1), comment(alice, "> @me said\nok", 1)])] }).items).toEqual([]);
  });

  it("MEN-05, MEN-06: a bot counts only when it opened an unresolved thread, marked as a bot", () => {
    const opened = mention(84, [comment(bot, "@me deploy finished", 1)], {
      __typename: "PullRequest",
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [comment(bot, "@me this leaks a token", 1)] } }] },
    });
    const [item] = run({ mentions: [opened] }).items;
    expect(item).toMatchObject({ number: 84, person: { bot: true, login: "reviewbot" } });
    expect(item.person?.snippet).toContain("leaks a token");
  });

  it("MEN-01: a mention on my own PR makes it a reply", () => {
    const inbox = run({ mine: [pr(1, {}, "FAILURE")], mentions: [mention(1, [comment(alice, "@me why?", 1)], { __typename: "PullRequest" })] });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ section: "reply", actions: ["reply"] });
  });
});

describe("next up", () => {
  const nextUp = { priority: { field: "Priority" }, effort: { field: "Effort", order: ["Tiny", "Small", "Medium", "Large"] }, scope: { field: "Scope", mine: ["Backend"] } };
  const fieldOptions = { Priority: ["🌋 P0 Urgent", "🏔 P1 High", "🏕P2 Medium", "🏝 P3 Low"] };

  it("NXT-01, NXT-02: orders unclaimed issues by priority, then effort, then age", () => {
    const inbox = run(
      {
        unclaimed: [
          pickable(1, { Priority: "🏝 P3 Low", Effort: "🦑 Large (1-2w)" }, 50),
          pickable(2, { Priority: "🏝 P3 Low", Effort: "🐇 Small (0.5-2d)" }, 5),
          pickable(3, { Priority: "🏝 P3 Low", Effort: "🐇 Small (0.5-2d)" }, 20),
          pickable(4, { Priority: "🏔 P1 High", Effort: "🦑 Large (1-2w)" }),
          pickable(5, {}),
        ],
      },
      {},
      { config: InboxConfig.parse({ nextUp }), fieldOptions },
    );
    expect(inbox.unclaimed.map((issue) => issue.number)).toEqual([4, 3, 2, 1, 5]);
    expect(inbox.unclaimed[0]).toMatchObject({ type: "Bug", priority: "🏔 P1 High", effort: "🦑 Large (1-2w)", defaultBranch: "main" });
  });

  it("NXT-06: lists issues assigned to me, ranked the same way", () => {
    const inbox = run({ assigned: [pickable(7, { Effort: "Large" }), pickable(8, { Effort: "Tiny" })] }, {}, { config: InboxConfig.parse({ nextUp }) });
    expect(inbox.assigned.map((issue) => issue.number)).toEqual([8, 7]);
  });

  it("NXT-04: reads only the configured fields and repositories", () => {
    const inbox = run({ unclaimed: [pickable(1, { Scope: "🔙 Backend", Other: "x" })] }, {}, { config: InboxConfig.parse({ nextUp }) });
    expect(inbox.unclaimed[0]).toMatchObject({ scope: "🔙 Backend", priority: undefined });
    const variables = searchVariables(InboxConfig.parse({ orgs: ["acme"], nextUp: { repos: ["acme/shop"] } }), NOW);
    expect(variables.unclaimed).toBe("is:issue is:open no:assignee repo:acme/shop archived:false");
  });
});

describe("GitHub requests", () => {
  it("SRC-01, GH-01: scopes every search to the configured orgs and repos", () => {
    const variables = searchVariables(InboxConfig.parse({ orgs: ["acme"], repos: ["acme/web"] }), NOW);
    for (const [alias, query] of Object.entries(variables)) if (alias !== "unclaimed") expect(query).toContain("org:acme repo:acme/web");
    expect(variables.reviews).toContain("user-review-requested:@me");
  });

  it("GH-01: sends each live search as its own request, and History as one, with only the fragments each uses", () => {
    expect(searchQuery(["mine"], true)).toMatch(/^query Inbox\(\$mine: String!\) \{\n  viewer \{ login id \}\n  mine: search/);
    expect(searchQuery(["mine"]).match(/^fragment \w+/gm)).toEqual(["fragment pr", "fragment author"]);
    expect(searchQuery(["commented"])).not.toContain("fragment");
    expect(searchQuery(HISTORY_SEARCHES).match(/^  \w+: search/gm)).toEqual(["  merged: search", "  reviewed: search", "  closed: search"]);
    expect(Object.keys(searchVariables(config, NOW)).sort()).toEqual([...LIVE_SEARCHES, ...HISTORY_SEARCHES].sort());
  });

  it("GH-01: refreshes hourly by default; the screen never forces a fetch", () => {
    expect(config.refreshMinutes).toBe(60);
  });

  it("ATT-08: records the latest activity by others for dismissals", () => {
    const [item] = run({ mine: [pr(1, { reviewThreads: { nodes: [thread(alice, 0.25)] }, comments: { nodes: [comment(me, "", 0.1)] } })] }).items;
    expect(item.othersActivityAt).toBe(daysAgo(0.25));
  });

  it("covers every section with the preview fixture", () => {
    const { data, details } = fixture(NOW);
    const inbox = classify({ data, details, config, now: NOW });
    expect(new Set([...inbox.items, ...classifyHistory(data)].map((item) => item.section)).size).toBe(14);
    expect(doing(inbox).length).toBeGreaterThan(5);
    expect([inbox.assigned.length, inbox.unclaimed.length]).toEqual([2, 6]);
  });
});

