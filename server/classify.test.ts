import { describe, expect, it } from "vitest";
import { type Item, itemSessions, SECTIONS } from "../shared/attention";
import { linkedSessions } from "../shared/linked-sessions";
import { AttentionConfig, nextUpSources } from "../shared/config";
import { classify, classifyHistory } from "./classify";
import { alice, bob, bot, builders, fixture, me, REPO } from "./fixture";
import type { Details } from "./github-types";
import { detailsQuery, HISTORY_SEARCHES, LIVE_SEARCHES, mergeStateQuery, mergeUnclaimed, requiredChecks, searchQuery, searchVariables, unclaimedSearches } from "./queries";

const NOW = new Date("2026-10-28T12:00:00Z"); // a Wednesday
const config = AttentionConfig.parse({ orgs: ["acme"] });
const { daysAgo, commit, thread, pr, comment, mention, issue, pickable, search } = builders(NOW);
const key = (n: number) => `${REPO}#${n}`;
const chips = (item: { chips: { text: string }[] }) => item.chips.map((chip) => chip.text);
const sections = (items: Item[]) => items.map((item) => [item.number, item.section]);

function run(
  parts: Parameters<typeof search>[0],
  behind: Record<string, number> = {},
  options: { config?: AttentionConfig; fieldOptions?: Record<string, string[]>; issues?: Details["issues"]; checks?: Details["checks"]; mergeState?: Details["mergeState"] } = {},
) {
  const details = { behind, fieldOptions: options.fieldOptions ?? {}, issues: options.issues ?? {}, checks: options.checks ?? {}, mergeState: options.mergeState ?? {} };
  return classify({ data: search(parts), details, config: options.config ?? config, now: NOW });
}
const asked = { nodes: [{ requestedReviewer: bob }] };
const follow = AttentionConfig.parse({ orgs: ["acme"], followThreads: true });
const doing = (attention: ReturnType<typeof run>) => attention.items.filter((item) => SECTIONS[item.section].tab === "doing");

describe("doing", () => {
  it("ATT-02: puts each item once, under its most urgent reason, in section order", () => {
    const changes = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(0.5) }] };
    const attention = run({
      mine: [pr(1, { reviewDecision: "APPROVED" }), pr(2, {}, "FAILURE"), pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews: changes }, "FAILURE")],
      reviews: [pr(9, { author: alice })],
    });
    // Newest activity by others first within a section.
    expect(sections(attention.items)).toEqual([[9, "review"], [3, "ci"], [2, "ci"], [1, "ready"]]);
  });

  it("REV-01: lists PRs requesting my review, showing the author", () => {
    const [item] = run({ reviews: [pr(9, { author: alice })] }).items;
    expect(item).toMatchObject({ section: "review", actions: ["review"], person: { login: "alice", avatarUrl: alice.avatarUrl } });
  });

  it("PRS-01, PRS-09: lists my PRs with failing checks with Fix, and Rerun beside it", () => {
    const [item] = run({ mine: [pr(2, {}, "ERROR")] }).items;
    expect(item).toMatchObject({ section: "ci", actions: ["fix", "rerun"] });
    expect(item.chips).toContainEqual({ text: "CI failing", tone: "bad" });
  });

  it("PRS-02: lists unresolved threads waiting on me; a thread I answered waits on the reviewer I asked again", () => {
    expect(run({ mine: [pr(3, { reviewThreads: { nodes: [thread(alice, 1)] } })] }).items[0]).toMatchObject({ section: "changes", actions: ["address"] });
    const reviewed = { nodes: [{ author: alice, state: "COMMENTED", submittedAt: daysAgo(1.5) }] };
    const answered = { latestReviews: reviewed, reviewThreads: { nodes: [thread(me, 1)] } };
    expect(sections(run({ mine: [pr(3, { ...answered, reviewRequests: { nodes: [{ requestedReviewer: alice }] } })] }).items)).toEqual([[3, "wait_reviewer"]]);
  });

  it("PRS-02: requested changes followed by a new push wait on that reviewer", () => {
    const latestReviews = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(1.5) }] };
    const [item] = run({ mine: [pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews })] }).items;
    expect(item).toMatchObject({ section: "wait_reviewer", person: undefined, waitingOn: [{ login: "alice", team: false }] });
  });
});

describe("ready to merge and behind base", () => {
  it("PRS-03, PRS-04: offers Merge only when CI passed against the current base", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, { [key(1)]: 0 }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["merge"], target: { mergeMethod: "squash" } });
    expect(chips(item)).toEqual(["approved", "CI passed"]);
  });

  it("PRS-10: an approved PR waiting on CI offers Auto-merge where the repo allows it", () => {
    const allowed = { nameWithOwner: REPO, autoMergeAllowed: true };
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED", repository: allowed }, "PENDING")] }).items[0]).toMatchObject({ section: "ready", actions: ["automerge"] });
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED" }, "PENDING")] }).items[0]).toMatchObject({ section: "ready", actions: [] });
  });

  it("PRS-10: with auto-merge on, a PR waiting on CI waits in CI running", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED", autoMergeRequest: { enabledAt: daysAgo(0.1) } }, "PENDING")] }).items;
    expect(item.section).toBe("wait_ci");
    expect(chips(item)).toContain("auto-merge on");
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
    expect(sections(run({ mine: [pr(1, { reviewRequests: asked })] }, { [key(1)]: 400 }).items)).toEqual([[1, "wait_review"]]);
  });

  it("UPS-01: a PR that conflicts with its base needs upstream, with Rebase", () => {
    const [item] = run({ mine: [pr(1, { mergeable: "CONFLICTING" })] }, { [key(1)]: 139 }).items;
    expect(item).toMatchObject({ section: "upstream", actions: ["rebase"] });
    expect(chips(item)).toEqual(["conflicts", "139 behind main"]);
  });

  it("PRS-13: approved and green but blocked by a repo rule, it waits for review without Merge or a person", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" })] }).items;
    expect(item).toMatchObject({ section: "wait_review", actions: [], person: undefined, waitingOn: undefined, wait: { reason: undefined, since: daysAgo(1) } });
    expect(chips(item)).toEqual(["approved", "blocked by repo rules"]);
  });

  it("PRS-13: blocked by a rule never counts as waiting too long, even after I replied", () => {
    const old = { reviewDecision: "APPROVED" as const, mergeStateStatus: "BLOCKED" as const, commits: commit("SUCCESS", 30), reviewThreads: { nodes: [thread(me, 20)] } };
    expect(sections(run({ mine: [pr(1, old)] }).items)).toEqual([[1, "wait_review"]]);
  });

  it("PRS-13: what we already know explains a block, so it doesn't count as a rule", () => {
    const blocked = { reviewDecision: "APPROVED" as const, mergeStateStatus: "BLOCKED" as const };
    expect(run({ mine: [pr(1, blocked, "PENDING")] }).items[0]).toMatchObject({ section: "ready" });
    expect(run({ mine: [pr(1, { ...blocked, reviewDecision: "REVIEW_REQUIRED", reviewRequests: asked })] }).items[0].chips.map((c) => c.text)).not.toContain("blocked by repo rules");
  });

  it("PRS-13: the merge state asked a few PRs at a time beats search's, which says BLOCKED for all once there are more", () => {
    const approved = pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" });
    expect(run({ mine: [approved] }, {}, { mergeState: { [key(1)]: "CLEAN" } }).items[0]).toMatchObject({ section: "ready", actions: ["merge"] });
    expect(run({ mine: [pr(1, { mergeStateStatus: "CLEAN" })] }, {}, { mergeState: { [key(1)]: "BLOCKED" } }).items[0].actions).toEqual(["request_review"]);
    const { query, keys } = mergeStateQuery([pr(7), pr(8)]);
    expect(query).toContain('m1: repository(owner: "acme", name: "shop") { pullRequest(number: 8) { mergeStateStatus } }');
    expect(keys).toEqual({ m0: key(7), m1: key(8) });
  });

  it("PRS-13: UNKNOWN or missing merge state decides nothing", () => {
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "UNKNOWN" })] }).items[0]).toMatchObject({ section: "ready", actions: ["merge"] });
  });

  it("PRS-12, PRS-13: where nobody reviews, Merge is offered only when the rules allow it", () => {
    expect(run({ mine: [pr(1, { mergeStateStatus: "CLEAN" })] }).items[0].actions).toEqual(["request_review", "merge"]);
    expect(run({ mine: [pr(1, { mergeStateStatus: "BLOCKED" })] }).items[0].actions).toEqual(["request_review"]);
  });

  it("PRS-14: with required checks passing, failing optional ones leave it ready", () => {
    const checks = { [key(1)]: { required: 2, failing: 0, pending: 0 } };
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" }, "FAILURE")] }, {}, { checks }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["merge"] });
    expect(chips(item)).toEqual(["approved", "optional checks failing"]);
  });

  it("PRS-14: with required checks passing, optional ones still running don't hold up Merge", () => {
    const checks = { [key(1)]: { required: 1, failing: 0, pending: 0 } };
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" }, "PENDING")] }, {}, { checks }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["merge"] });
    expect(chips(item)).toEqual(["approved", "required checks passed"]);
  });

  it("PRS-14: a failing or running required check counts as before", () => {
    const failing = { [key(1)]: { required: 2, failing: 1, pending: 0 } };
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED" }, "FAILURE")] }, {}, { checks: failing }).items[0].section).toBe("ci");
    const running = { [key(1)]: { required: 2, failing: 0, pending: 1 } };
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED" }, "PENDING")] }, {}, { checks: running }).items[0]).toMatchObject({ section: "ready", actions: [] });
  });

  it("PRS-14: a required check that hasn't reported yet shows as GitHub blocking while CI runs", () => {
    const checks = { [key(1)]: { required: 1, failing: 0, pending: 0 } };
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" }, "PENDING")] }, {}, { checks }).items;
    expect(item).toMatchObject({ section: "ready", actions: [] });
    expect(chips(item)).toContain("CI running");
  });

  it("PRS-14: where the repo requires no checks, every check counts", () => {
    const checks = { [key(1)]: { required: 0, failing: 0, pending: 0 } };
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" }, "FAILURE")] }, {}, { checks }).items[0].section).toBe("ci");
    expect(run({ mine: [pr(1, { reviewDecision: "APPROVED", mergeStateStatus: "UNSTABLE" }, "FAILURE")] }).items[0].section).toBe("ci");
  });

  it("PRS-14: counts only required checks; a check run passes as success, neutral or skipped", () => {
    const contexts = [
      { status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
      { status: "COMPLETED", conclusion: "SKIPPED", isRequired: true },
      { status: "COMPLETED", conclusion: "CANCELLED", isRequired: true },
      { status: "IN_PROGRESS", conclusion: null, isRequired: true },
      { state: "ERROR", isRequired: true },
      { state: "EXPECTED", isRequired: true },
      { status: "COMPLETED", conclusion: "FAILURE", isRequired: false },
      { state: "PENDING", isRequired: false },
    ];
    expect(requiredChecks(contexts)).toEqual({ required: 6, failing: 2, pending: 2 });
  });

  it("PRS-14: asks which checks are required apart from the compare", () => {
    const { query, compares } = detailsQuery([pr(7)], []);
    expect(query).toContain("isRequired(pullRequestNumber: 7)");
    expect(compares).toEqual({ c0: key(7), r0: key(7) });
  });

  it("PRS-04: uses the merge method from config, else the first the repo allows", () => {
    const noSquash = pr(1, { reviewDecision: "APPROVED", repository: { nameWithOwner: REPO, squashMergeAllowed: false, mergeCommitAllowed: true } });
    expect(run({ mine: [noSquash] }).items[0].target.mergeMethod).toBe("merge");
    const configured = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, {}, { config: AttentionConfig.parse({ mergeMethods: { [REPO]: "rebase" } }) });
    expect(configured.items[0].target.mergeMethod).toBe("rebase");
  });
});

describe("stacks", () => {
  const bottom = pr(10, { headRefName: "a" });
  const middle = pr(11, { baseRefName: "a", headRefName: "b", isDraft: true, reviewDecision: "APPROVED" });
  const top = pr(12, { baseRefName: "b", headRefName: "c", isDraft: true });

  it("ATT-04: shows a stack as one item led by its bottom PR", () => {
    const attention = run({ mine: [top, bottom, middle] }, { [key(11)]: 279 });
    expect(attention.items).toHaveLength(1);
    const [item] = attention.items;
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

describe("stacks whoever opened them", () => {
  // Alice's stack asking for my review, and my PR on top of her top one.
  const hers = pr(20, { author: alice, headRefName: "x" });
  const hersTop = pr(21, { author: alice, baseRefName: "x", headRefName: "y" });
  const minesOnHers = pr(22, { baseRefName: "y", headRefName: "z" }, "FAILURE");

  it("ATT-04, REV-01: a stack asking for my review is one item with one Review for all of it", () => {
    const attention = run({ reviews: [hersTop, hers] });
    expect(attention.items).toHaveLength(1);
    const [item] = attention.items;
    expect(item).toMatchObject({ key: key(20), number: 20, section: "review", actions: ["review"], person: { login: "alice" }, target: { number: 20 } });
    expect(item.children.map((child) => [child.number, chips(child)])).toEqual([[21, ["2/2"]]]);
    expect(chips(item)).toEqual(["stack of 2"]);
    expect(item.target.stack).toEqual([
      { number: 20, head: "x", base: "main", review: true },
      { number: 21, head: "y", base: "x", review: true },
    ]);
  });

  it("ATT-04: shows CI failing on a stack asking for my review when any PR in it fails", () => {
    expect(chips(run({ reviews: [hers, pr(21, { author: alice, baseRefName: "x" }, "FAILURE")] }).items[0])).toEqual(["CI failing", "stack of 2"]);
  });

  it("ATT-04, MEN-01: a mention on an upper PR of the stack makes the whole stack a reply", () => {
    const mentioned = mention(21, [comment(bob, "@me can you look at this one first?", 0.5)], { __typename: "PullRequest" });
    const attention = run({ reviews: [hers, hersTop], mentions: [mentioned] });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({ number: 20, section: "reply", actions: ["reply", "acknowledge", "review"], person: { login: "bob" } });
  });

  it("ATT-04: my PR on someone else's asking for my review is one item: Review first, then my actions on my PR", () => {
    const attention = run({ mine: [minesOnHers], reviews: [hers, hersTop] });
    expect(attention.items).toHaveLength(1);
    const [item] = attention.items;
    // Led by the stack's bottom; GitHub actions act on my PR.
    expect(item).toMatchObject({ number: 20, section: "review", actions: ["review", "fix", "rerun"], target: { number: 22, headRefName: "z" } });
    expect(item.children.map((child) => child.number)).toEqual([21, 22]);
    expect(item.target.stack?.map((p) => [p.number, !!p.review])).toEqual([[20, true], [21, true], [22, false]]);
    expect(chips(item)).toEqual(["stack of 3"]);
  });

  it("ATT-04: someone else's PR on mine is one item, the more urgent part leading", () => {
    const mine = pr(30, { headRefName: "m" }, "FAILURE");
    const theirs = pr(31, { author: alice, baseRefName: "m" });
    const [item, ...rest] = run({ mine: [mine], reviews: [theirs] }).items;
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ number: 30, section: "review", actions: ["review", "fix", "rerun"], target: { number: 30 } });
    // A mention on my PR outranks the review.
    const mentioned = mention(30, [comment(bob, "@me ping", 0.5)], { __typename: "PullRequest" });
    expect(run({ mine: [mine], reviews: [theirs], mentions: [mentioned] }).items[0]).toMatchObject({ section: "reply", actions: ["reply", "acknowledge", "review"] });
  });

  it("ATT-04, UPS-02: my PR behind the PR of someone else's it builds on says so", () => {
    const [item] = run({ mine: [minesOnHers], reviews: [hers, hersTop] }, { [key(22)]: 2 }).items;
    expect(item.children.find((child) => child.number === 22)).toMatchObject({ attention: true });
    expect(chips(item.children.find((child) => child.number === 22)!)).toContain("2 behind #21");
  });

  it("ATT-04: a PR from a fork never parents another, whatever its branch is called", () => {
    const fork = pr(40, { author: alice, headRefName: "main-fix", isCrossRepository: true });
    const other = pr(41, { author: bob, baseRefName: "main-fix" });
    expect(run({ reviews: [fork, other] }).items.map((item) => item.number).sort()).toEqual([40, 41]);
  });

  it("REV-01: a stack only asking for my review stays a pull request, even if it closes an issue", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } }] };
    expect(run({ reviews: [pr(20, { author: alice, closingIssuesReferences: closes })] }).items[0]).toMatchObject({ kind: "pr", number: 20 });
  });

  it("SES-03, SES-08: a session on any PR in the stack shows on its item", () => {
    const [item] = run({ reviews: [hers, hersTop] }).items;
    // Started from Paseo on the top PR, outside Attention Span.
    const linked = linkedSessions([], [{ id: "a", status: "running", workspaceId: "w" }], [{ id: "w", workspaceKind: "worktree", githubRuntime: { pullRequest: { url: hersTop.url } } }]);
    expect(itemSessions(linked, item).map((agent) => agent.id)).toEqual(["a"]);
  });
});

describe("drafts", () => {
  it("PRS-05: lists my drafts after everything that isn't a draft", () => {
    expect(run({ mine: [pr(1, { isDraft: true }), pr(2, {}, "FAILURE")] }).items.map((item) => item.section)).toEqual(["ci", "drafts"]);
  });

  it("PRS-06: other people's drafts are not work items", () => {
    expect(run({ mentions: [mention(90, [comment(alice, "wip", 1)], { __typename: "PullRequest" })] }).items).toEqual([]);
  });

  it("PRS-11: a healthy draft offers Ready for review; a failing one, Fix and Rerun", () => {
    expect(run({ mine: [pr(1, { isDraft: true })] }).items[0].actions).toEqual(["ready"]);
    expect(run({ mine: [pr(1, { isDraft: true }, "PENDING")] }).items[0].actions).toEqual(["ready"]);
    expect(run({ mine: [pr(1, { isDraft: true }, "FAILURE")] }).items[0].actions).toEqual(["fix", "rerun"]);
    expect(run({ mine: [pr(1, { isDraft: true, mergeable: "CONFLICTING" })] }).items[0].actions).toEqual(["rebase"]);
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
    const attention = run({ mine: [pr(1, { closingIssuesReferences: closes })], mentions: [mention(50, [comment(bob, "@me weekends too?", 0.5)])] });
    expect(attention.items[0]).toMatchObject({ kind: "issue", number: 50, section: "reply", person: { login: "bob" } });
    expect(chips(attention.items[0])).toEqual(["PR #1"]);
  });

  it("ATT-03: groups PRs under the issue they close, led by the issue", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } }] };
    const attention = run({
      mine: [pr(1, { closingIssuesReferences: closes }, "FAILURE"), pr(2, { closingIssuesReferences: closes, reviewDecision: "APPROVED" })],
      assigned: [pickable(50, {})],
    });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({ kind: "issue", number: 50, section: "ci", actions: ["fix", "rerun"], target: { number: 1 } });
    expect(attention.items[0].children.map((child) => child.number)).toEqual([1, 2]);
    expect(attention.assigned).toEqual([]); // already in progress
  });

  describe("a stack GitHub links to no issue", () => {
    const issues = { [key(50)]: { number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } } };
    const bottom = (body: string) => pr(10, { headRefName: "a", body });
    const top = (body: string) => pr(11, { baseRefName: "a", body });

    it("ATT-03: groups it under the issue its top PR closes", () => {
      const [item, ...rest] = run({ mine: [bottom("First of two"), top("Closes #50")], assigned: [pickable(50, {})] }, {}, { issues }).items;
      expect(rest).toEqual([]);
      expect(item).toMatchObject({ kind: "issue", number: 50, title: "Issue 50", target: { number: 10 } });
      expect(item.children.map((child) => child.number)).toEqual([10, 11]);
    });

    it("ATT-03: groups it under the one issue its bottom PR mentions", () => {
      expect(run({ mine: [bottom("First of two stacked PRs for #50."), top("")] }, {}, { issues }).items[0]).toMatchObject({ kind: "issue", number: 50 });
    });

    it("ATT-03: leaves it alone when the reference isn't an open issue, or there are several", () => {
      expect(run({ mine: [bottom("for #50"), top("")] }).items[0]).toMatchObject({ kind: "pr", number: 10 });
      const more = { ...issues, [key(51)]: { ...issues[key(50)], number: 51 } };
      expect(run({ mine: [bottom("for #50 and #51"), top("")] }, {}, { issues: more }).items[0]).toMatchObject({ kind: "pr", number: 10 });
    });

    it("ATT-03: puts PRs that each refer to the issue under one item", () => {
      const attention = run({ mine: [pr(1, { body: "Part 1 of #50" }), pr(2, { body: "Fixes #50" })] }, {}, { issues });
      expect(attention.items.map((item) => [item.number, item.children.map((child) => child.number)])).toEqual([[50, [1, 2]]]);
    });
  });
});

describe("waiting", () => {
  it("WAI-01: groups my work by what it waits for, with who I'm waiting on", () => {
    const attention = run({
      mine: [pr(1, { reviewRequests: asked }), pr(2, { reviewRequests: asked }, "PENDING")],
      involved: [issue(70, [comment(me, "which shops?", 1)]), issue(72, [comment(alice, "", 1)])],
    });
    expect(sections(attention.items)).toEqual([[1, "wait_review"], [2, "wait_ci"], [70, "wait_answer"]]);
    expect(attention.items[0]).toMatchObject({ waitingOn: [{ login: "bob", avatarUrl: bob.avatarUrl, team: false, since: daysAgo(1) }], chips: [], wait: { reason: "review", since: daysAgo(1) } });
    expect(attention.items[2].wait).toEqual({ reason: "question", since: daysAgo(1), overdue: undefined });
  });

  it("WAI-01: says why each waits: a review, a re-review after my reply, or a question", () => {
    const latestReviews = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(2) }] };
    const replied = run({ mine: [pr(1, { reviewDecision: "CHANGES_REQUESTED", latestReviews })] }).items[0];
    expect(replied).toMatchObject({ section: "wait_reviewer", wait: { reason: "re-review" } });
    const unseen = run({ mine: [pr(3, { reviewRequests: { nodes: [{ requestedReviewer: null }] } })] }).items[0];
    expect(unseen.wait?.reason).toBe("review");
  });

  it("WAI-01: while CI runs on an approved PR, CI running says why, not a missing request", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED", autoMergeRequest: { enabledAt: daysAgo(1) } }, "PENDING")] }).items;
    expect(item).toMatchObject({ section: "wait_ci", wait: { reason: undefined } });
    expect(chips(item)).toContain("CI running");
  });

  it("WAI-03: a requested bot is fetched and marked, so there's no list to send it", () => {
    expect(searchQuery(LIVE_SEARCHES)).toContain("... on Bot { ...author }");
    const copilot = { __typename: "Bot", login: "copilot", avatarUrl: "https://avatars/c" };
    const [item] = run({ mine: [pr(1, { reviewRequests: { nodes: [{ requestedReviewer: copilot }] } })] }).items;
    expect(item.waitingOn).toEqual([{ login: "copilot", avatarUrl: "https://avatars/c", team: false, bot: true, since: daysAgo(1) }]);
  });

  it("WAI-02: a PR waits on everyone I asked, while CI runs too, and after my reply on whoever asked for changes", () => {
    const both = { nodes: [{ requestedReviewer: bob }, { requestedReviewer: alice }] };
    const [item] = run({ mine: [pr(1, { reviewRequests: both }, "PENDING")] }).items;
    expect(item.section).toBe("wait_ci");
    expect(item.waitingOn?.map((who) => who.login)).toEqual(["bob", "alice"]);
    const latestReviews = { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(2) }] };
    const replied = run({ mine: [pr(2, { reviewDecision: "CHANGES_REQUESTED", latestReviews, reviewRequests: asked })] }).items[0];
    expect(replied.section).toBe("wait_reviewer");
    expect(replied.waitingOn?.map((who) => who.login)).toEqual(["alice", "bob"]);
    const ci = run({ mine: [pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews, reviewRequests: asked }, "PENDING")] }).items[0];
    expect(ci.section).toBe("wait_ci");
    expect(ci.waitingOn?.map((who) => who.login)).toEqual(["bob"]);
  });

  it("WAI-02: a question waits on who my comments tag since the last answer, outside quotes, from their first tag", () => {
    const tag = (login: string) => `<a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/${login}">@${login}</a>`;
    const team = '<a class="team-mention js-team-mention notranslate" data-hovercard-type="team" href="https://github.com/orgs/acme/teams/frontend">@acme/frontend</a>';
    const html = (body: string) => ({ bodyHTML: body });
    const thread = issue(70, [
      comment(me, "", 5, html(`<p>${tag("carol")} first round</p>`)),
      comment(alice, "", 4),
      comment(me, "> @alice said so\n\n@bob @acme/frontend which shops?", 3, html(`<blockquote><p>${tag("alice")} said so</p></blockquote><p>${tag("bob")} ${team} which shops?</p>`)),
      comment(bot, "labelled", 2.5),
      comment(me, "", 2, html(`<p>${tag("Bob")} ${tag("me")} also ${tag("dave")}?</p>`)),
    ]);
    const [item] = run({ involved: [thread] }).items;
    expect(item.section).toBe("wait_answer");
    expect(item.waitingOn).toEqual([
      { login: "bob", team: false, avatarUrl: "https://github.com/bob.png?size=64", since: daysAgo(3) },
      { login: "acme/frontend", team: true, avatarUrl: undefined, since: daysAgo(3) },
      { login: "dave", team: false, avatarUrl: "https://github.com/dave.png?size=64", since: daysAgo(2) },
    ]);
    expect(item.person).toBeUndefined();
  });

  it("WAI-01: a statement waits on nobody, even one that tags someone; a question in an earlier comment of mine still counts", () => {
    const tag = (login: string) => `<a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/${login}">@${login}</a>`;
    const stated = issue(70, [comment(me, "@bob deployed to staging", 1, { bodyHTML: `<p>${tag("bob")} deployed to staging</p>` })]);
    expect(run({ involved: [stated] }).items).toEqual([]);
    const both = issue(71, [comment(me, "@bob which shops?", 2, { bodyHTML: `<p>${tag("bob")} which shops?</p>` }), comment(me, "found the logs", 1)]);
    expect(run({ involved: [both] }).items[0]).toMatchObject({ section: "wait_answer", waitingOn: [{ login: "bob" }] });
  });

  it("WAI-02: a question that tags nobody waits on nobody", () => {
    const [item] = run({ involved: [issue(70, [comment(me, "@bob which shops?", 1, { bodyHTML: "<p>@bob which shops?</p>" })])] }).items;
    expect(item).toMatchObject({ section: "wait_answer", waitingOn: undefined });
  });

  it("ATT-11: after 3 days it moves to Doing as Waiting too long", () => {
    const attention = run({ mine: [pr(1, { reviewRequests: asked, commits: commit("SUCCESS", 4) })], involved: [issue(71, [comment(me, "any news?", 5)])] });
    expect(sections(attention.items)).toEqual([[1, "too_long"], [71, "too_long"]]);
    expect(attention.items[0].wait).toEqual({ reason: "review", since: daysAgo(4), overdue: "waiting for review" });
    expect(attention.items[0].waitingOn?.map((who) => who.login)).toEqual(["bob"]);
  });
});

describe("answered", () => {
  it("ATT-16: a recent comment after mine on my issue, without a mention, is mine, with Reply and 👍", () => {
    const [item] = run({ involved: [issue(70, [comment(me, "which shops?", 2), comment(alice, "Only **the Danish** one", 0.5)], "Mine", { author: me })] }).items;
    expect(item).toMatchObject({ section: "answered", actions: ["reply", "acknowledge"], person: { login: "alice", snippet: "Only the Danish one", since: daysAgo(0.5) }, chips: [] });
    expect(item.person?.comments?.map((c) => c.body)).toEqual(["Only **the Danish** one"]);
    expect(item.othersActivityAt).toBe(daysAgo(0.5));
  });

  it("ATT-16, MEN-02, WAI-01: replying with a question makes it wait again, a statement doesn't; a 👍 on the answer clears it", () => {
    const replied = issue(70, [comment(me, "which shops?", 2), comment(alice, "Danish", 1), comment(me, "thanks, which version?", 0.5)]);
    expect(sections(run({ involved: [replied] }).items)).toEqual([[70, "wait_answer"]]);
    const stated = issue(72, [comment(me, "which shops?", 2), comment(alice, "Danish", 1), comment(me, "thanks, looking", 0.5)]);
    expect(run({ involved: [stated] }).items).toEqual([]);
    const reacted = issue(71, [comment(me, "which shops?", 2), comment(alice, "Danish", 1, { reactionGroups: [{ viewerHasReacted: true }] })]);
    expect(run({ involved: [reacted] }).items).toEqual([]);
  });

  it("ATT-16, MEN-05: a bot commenting after my question doesn't answer it", () => {
    expect(sections(run({ involved: [issue(70, [comment(me, "?", 1), comment(bot, "labelled", 0.5)])] }).items)).toEqual([[70, "wait_answer"]]);
  });

  it("ATT-17: replies on someone else's thread that don't tag me are left out, unless I allow it", () => {
    const thread = issue(70, [comment(me, "which shops?", 2), comment(alice, "Danish", 0.5)]);
    expect(run({ involved: [thread] }).items).toEqual([]);
    expect(run({ involved: [thread] }, {}, { config: follow }).items[0]).toMatchObject({ section: "answered", person: { login: "alice" } });
  });

  it("ATT-16, ATT-17: even when allowed, only comments from the last mentionDays count", () => {
    expect(run({ involved: [issue(70, [comment(me, "same here", 400), comment(alice, "+1", 300), comment(bob, "+1", 40)])] }, {}, { config: follow }).items).toEqual([]);
    const [item] = run({ involved: [issue(70, [comment(me, "same here", 400), comment(alice, "+1", 300), comment(bob, "fixed in 2.4?", 2)])] }, {}, { config: follow }).items;
    expect(item).toMatchObject({ section: "answered", person: { login: "bob" } });
    expect(item.person?.comments?.map((c) => c.author)).toEqual(["bob"]);
  });

  it("ATT-16: on my own issue, any recent comment is an update, even if I never commented", () => {
    const mine = issue(70, [comment(alice, "can't reproduce", 1)], "Mine", { author: me });
    expect(run({ involved: [mine] }).items[0]).toMatchObject({ section: "answered", person: { login: "alice" } });
    expect(run({ involved: [{ ...mine, comments: { nodes: [comment(alice, "old", 60)] } }] }).items).toEqual([]);
  });

  it("ATT-16: a conversation comment on my PR leads it, with Reply and 👍", () => {
    const thread = issue(1, [comment(bob, "could you split this?", 0.2)], "PR 1", { __typename: "PullRequest", author: me });
    const [item] = run({ mine: [pr(1, { reviewRequests: asked })], involved: [thread] }).items;
    expect(item).toMatchObject({ section: "answered", actions: ["reply", "acknowledge"], person: { login: "bob" } });
  });

  it("PRS-08: a PR I handed over stays out, even with comments after mine", () => {
    const thread = issue(1, [comment(bob, "?", 0.2)], "PR 1", { __typename: "PullRequest", author: me });
    expect(run({ mine: [pr(1, { assignees: { nodes: [{ login: "bob" }] } })], involved: [thread] }).items).toEqual([]);
  });

  it("ATT-11: a question on my own issue stays however old; on someone else's, only while fresh", () => {
    const [item] = run({ asked: [issue(70, [comment(me, "still needed?", 45)], "Mine", { author: me })] }).items;
    expect(item).toMatchObject({ section: "too_long" });
    expect(item.wait).toEqual({ reason: "question", since: daysAgo(45), overdue: "waiting for an answer" });
    expect(run({ involved: [issue(71, [comment(me, "still needed?", 45)])] }).items).toEqual([]);
    expect(searchVariables(config, NOW).asked).not.toContain("updated:");
    expect(searchVariables(config, NOW).involved).toContain("involves:@me updated:>=");
  });

  it("ATT-16: once my comment is out of the last ones on someone else's thread, the conversation has moved on", () => {
    expect(run({ involved: [issue(70, [comment(alice, "", 3), comment(bob, "", 2)])] }).items).toEqual([]);
  });

  it("ATT-16: a thread both searches found is listed once", () => {
    const mine = issue(70, [comment(me, "still needed?", 5)], "Mine", { author: me });
    expect(sections(run({ involved: [mine], asked: [mine] }).items)).toEqual([[70, "too_long"]]);
  });

  it("ATT-03, ATT-16: an answer on an issue my PR closes leads its item", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "u", repository: { nameWithOwner: REPO } }] };
    const attention = run({
      mine: [pr(1, { closingIssuesReferences: closes, reviewRequests: asked })],
      involved: [issue(50, [comment(me, "which shops?", 2), comment(alice, "Danish", 1)], "Issue 50", { author: me })],
    });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({ kind: "issue", section: "answered", person: { login: "alice" }, actions: ["reply", "acknowledge"] });
  });
});

describe("needs a reviewer", () => {
  it("PRS-12: a PR nobody was asked to review is mine, with Merge once CI passed on the current base", () => {
    const [item] = run({ mine: [pr(1)] }).items;
    expect(item).toMatchObject({ section: "needs_reviewer", actions: ["request_review", "merge"], person: undefined });
    expect(run({ mine: [pr(1)] }, { [key(1)]: 2 }).items[0].actions).toEqual(["request_review"]);
  });

  it("PRS-12: stays mine while CI runs, and never waits too long", () => {
    expect(run({ mine: [pr(1, {}, "PENDING")] }).items[0]).toMatchObject({ section: "needs_reviewer", actions: ["request_review"] });
    expect(chips(run({ mine: [pr(1, {}, "PENDING")] }).items[0])).toContain("CI running");
    expect(sections(run({ mine: [pr(1, { commits: commit("SUCCESS", 9) })] }).items)).toEqual([[1, "needs_reviewer"]]);
  });

  it("WAI-01, PRS-12: a request to a team waits for review, showing the team", () => {
    const team = { __typename: "Team", combinedSlug: "acme/frontend", avatarUrl: "https://avatars/t" };
    const [item] = run({ mine: [pr(1, { reviewRequests: { nodes: [{ requestedReviewer: team }] } })] }).items;
    expect(item).toMatchObject({ section: "wait_review", waitingOn: [{ login: "acme/frontend", avatarUrl: "https://avatars/t", team: true }] });
  });

  it("PRS-12: a request I can't see the reviewer of still counts", () => {
    expect(run({ mine: [pr(1, { reviewRequests: { nodes: [{ requestedReviewer: null }] } })] }).items[0].section).toBe("wait_review");
  });

  it("PRS-12: a review that only commented, by a person or a bot, with nobody asked again, is mine to re-request", () => {
    for (const author of [alice, bot]) {
      const latestReviews = { nodes: [{ author, state: "COMMENTED", submittedAt: daysAgo(1) }] };
      expect(run({ mine: [pr(1, { latestReviews, mergeStateStatus: "BLOCKED" })] }).items[0]).toMatchObject({ section: "needs_reviewer", actions: ["request_review"] });
      expect(run({ mine: [pr(1, { latestReviews, mergeStateStatus: "CLEAN" })] }).items[0].actions).toEqual(["request_review", "merge"]);
    }
  });

  it("PRS-12: a bot's approval is an approval, when the repo counts it", () => {
    const latestReviews = { nodes: [{ author: bot, state: "APPROVED", submittedAt: daysAgo(1) }] };
    expect(run({ mine: [pr(1, { latestReviews, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })] }).items[0]).toMatchObject({ section: "ready", actions: ["merge"] });
  });

  it("PRS-12: my own review doesn't count as asking", () => {
    const latestReviews = { nodes: [{ author: me, state: "COMMENTED", submittedAt: daysAgo(1) }] };
    expect(run({ mine: [pr(1, { latestReviews })] }).items[0].section).toBe("needs_reviewer");
  });

  it("ATT-04, PRS-12: the bottom PR decides; a PR above it nobody was asked on says so", () => {
    const top = pr(11, { baseRefName: "branch-10" });
    const [item] = run({ mine: [pr(10, { reviewRequests: asked }), top] }).items;
    expect(item.section).toBe("wait_review");
    expect(chips(item.children[0])).toContain("no reviewer");
  });

  it("PRS-12: offers who reviewed or was asked on my PRs in the repo, latest first, without me or bots", () => {
    const latestReviews = { nodes: [{ author: alice, state: "APPROVED", submittedAt: daysAgo(3) }, { author: me, state: "COMMENTED", submittedAt: daysAgo(1) }, { author: bot, state: "COMMENTED", submittedAt: daysAgo(1) }] };
    const later = { nodes: [{ author: bob, state: "COMMENTED", submittedAt: daysAgo(1) }] };
    const attention = run({ mine: [pr(1, { latestReviews }), pr(2, { latestReviews: later, reviewRequests: { nodes: [{ requestedReviewer: alice }] } })] });
    expect(attention.reviewers?.[REPO]?.map((reviewer) => reviewer.login)).toEqual(["bob", "alice"]);
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

  it("HIS-01, ATT-03: puts a merged PR under the closed issue its description refers to", () => {
    const repository = { nameWithOwner: REPO };
    const merged = (number: number, body: string) => ({ number, title: "Step", url: "u", body, mergedAt: daysAgo(1), repository, closingIssuesReferences: { nodes: [] } });
    const items = classifyHistory(search({
      closed: [{ number: 60, title: "Backups", url: "u", closedAt: daysAgo(1), stateReason: "COMPLETED", repository }],
      merged: [merged(61, "First of two for #60"), merged(62, "Closes #60"), merged(63, "Follow-up to #59")],
    }));
    expect(items.map((item) => [item.number, item.children.map((c) => c.number)])).toEqual([[60, [61, 62]], [63, []]]);
  });

  it("HIS-02: lists PRs I reviewed apart from my own work, with their author", () => {
    const [item] = classifyHistory(search({ reviewed: [{ number: 63, title: "Onboarding", url: "u", mergedAt: daysAgo(3), repository: { nameWithOwner: REPO }, author: alice }] }));
    expect(item).toMatchObject({ section: "reviewed", person: { login: "alice" } });
  });

  it("HIS-04: tells each finished item's kind from its type, labels or title, on a chip", () => {
    const repository = { nameWithOwner: REPO };
    const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
    const items = classifyHistory(search({
      closed: [
        { number: 60, title: "Backups", url: "u", closedAt: daysAgo(1), stateReason: "COMPLETED", repository, issueType: { name: "Bug" }, labels: labels("enhancement") },
        { number: 64, title: "Notes", url: "u", closedAt: daysAgo(5), stateReason: "COMPLETED", repository, issueType: null, labels: labels() },
      ],
      merged: [
        { number: 61, title: "chore: tidy", url: "u", mergedAt: daysAgo(2), repository, labels: labels(), closingIssuesReferences: { nodes: [] } },
        { number: 62, title: "Speed up", url: "u", mergedAt: daysAgo(3), repository, labels: labels("kind/feature"), closingIssuesReferences: { nodes: [] } },
        { number: 63, title: "Tidy", url: "u", mergedAt: daysAgo(4), repository, closingIssuesReferences: { nodes: [] } },
      ],
      reviewed: [{ number: 65, title: "Onboarding", url: "u", mergedAt: daysAgo(3), repository, author: alice, labels: labels("bug") }],
    }));
    expect(items.map((item) => [item.number, item.work, chips(item)])).toEqual([
      [60, "bug", ["🐞 bug"]],
      [61, "task", ["🔧 task"]],
      [62, "feature", ["🚀 feature"]],
      [63, undefined, []],
      [64, undefined, []],
      [65, "bug", ["🐞 bug"]],
    ]);
  });

  it("HIS-03: a not planned issue is marked, and the PRs that referred to it are listed on their own", () => {
    const repository = { nameWithOwner: REPO };
    const items = classifyHistory(search({
      closed: [{ number: 60, title: "Dark mode", url: "u", closedAt: daysAgo(1), stateReason: "NOT_PLANNED", repository }],
      merged: [{ number: 61, title: "Spike dark mode", url: "u", mergedAt: daysAgo(2), repository, closingIssuesReferences: { nodes: [{ number: 60, repository }] } }],
    }));
    expect(items.map((item) => [item.number, item.notPlanned, item.children.length])).toEqual([[60, true, 0], [61, undefined, 0]]);
  });

  it("HIS-04: asks for labels and issue types, bounded, with History's searches", () => {
    const query = searchQuery(HISTORY_SEARCHES);
    expect(query).toContain("issueType { name }");
    expect(query.match(/labels\(first: 20\) \{ nodes \{ name \} \}/g)).toHaveLength(3);
  });

  it("HIS-01: searches whole weeks back from Monday", () => {
    expect(searchVariables(config, NOW).merged).toContain("merged:>=2026-10-05"); // 4 weeks: Oct 5, 12, 19, 26
  });
});

describe("mentions", () => {
  it("MEN-01: lists a thread where a person mentioned me and is waiting", () => {
    const [item] = run({ mentions: [mention(80, [comment(alice, "hey @me can you check the login flow?", 3)])] }).items;
    expect(item).toMatchObject({ section: "reply", actions: ["reply", "acknowledge"], person: { login: "alice", avatarUrl: alice.avatarUrl, bot: false } });
    expect(item.person?.snippet).toContain("@me can you check");
  });

  it("MEN-01, MEN-07: the quote is plain text; the 👍 picker keeps the comment's Markdown", () => {
    const body = "> @me earlier\nhey @me can you check [the login flow](https://x/login)? It's **broken**.";
    const [item] = run({ mentions: [mention(80, [comment(alice, body, 3)])] }).items;
    expect(item.person?.snippet).toBe("hey @me can you check the login flow? It's broken.");
    expect(item.person?.comments?.[0].body).toBe(body);
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
    const attention = run({ mine: [pr(1, {}, "FAILURE")], mentions: [mention(1, [comment(alice, "@me why?", 1)], { __typename: "PullRequest" })] });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({ section: "reply", actions: ["reply", "acknowledge"] });
  });

  it("MEN-07: offers 👍 for every waiting comment, including a description that mentions me", () => {
    const node = mention(85, [comment(alice, "@me first", 2), comment(bob, "@me and this", 1)], { id: "I_85", body: "@me see below", author: bob, createdAt: daysAgo(3) });
    const [item] = run({ mentions: [node] }).items;
    expect(item.actions).toEqual(["reply", "acknowledge"]);
    expect(item.person?.comments?.map((c) => [c.id, c.author])).toEqual([
      ["I_85", "bob"],
      [node.comments.nodes[0].id, "alice"],
      [node.comments.nodes[1].id, "bob"],
    ]);
  });

  it("MEN-02, MEN-07: a 👍 on the description clears it like one on a comment", () => {
    const node = mention(86, [], { id: "I_86", body: "@me please look", reactionGroups: [{ viewerHasReacted: true }] });
    expect(run({ mentions: [node] }).items).toEqual([]);
  });

  it("MEN-07: without comment ids there is nothing to react to, so only Reply", () => {
    const [item] = run({ mentions: [mention(87, [comment(alice, "@me ?", 1, { id: undefined })])] }).items;
    expect(item.actions).toEqual(["reply"]);
  });
});

describe("next up", () => {
  const nextUp = { priority: { field: "Priority" }, effort: { field: "Effort", order: ["Tiny", "Small", "Medium", "Large"] }, scope: { field: "Scope" } };
  const fieldOptions = { Priority: ["🌋 P0 Urgent", "🏔 P1 High", "🏕P2 Medium", "🏝 P3 Low"] };

  it("NXT-01, NXT-02: orders unclaimed issues by priority, then effort, then age", () => {
    const attention = run(
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
      { config: AttentionConfig.parse({ nextUp }), fieldOptions },
    );
    expect(attention.unclaimed.map((issue) => issue.number)).toEqual([4, 3, 2, 1, 5]);
    expect(attention.unclaimed[0]).toMatchObject({ type: "Bug", priority: "🏔 P1 High", effort: "🦑 Large (1-2w)", defaultBranch: "main" });
  });

  it("NXT-10: says which open PRs already close an issue, and where its priority ranks", () => {
    const pr = (number: number, state: string) => ({ number, url: `https://github.com/${REPO}/pull/${number}`, state, author: alice });
    const attention = run(
      { unclaimed: [{ ...pickable(1, { Priority: "🏔 P1 High" }), closedByPullRequestsReferences: { nodes: [pr(9, "OPEN"), pr(8, "CLOSED")] } }, pickable(2, {})] },
      {},
      { config: AttentionConfig.parse({ nextUp }), fieldOptions },
    );
    expect(attention.unclaimed[0]).toMatchObject({ priorityRank: 1, openPrs: [{ number: 9, author: "alice" }] });
    expect(attention.unclaimed[1]).toMatchObject({ priorityRank: undefined, openPrs: [] });
  });

  it("NXT-06: lists issues assigned to me, ranked the same way", () => {
    const attention = run({ assigned: [pickable(7, { Effort: "Large" }), pickable(8, { Effort: "Tiny" })] }, {}, { config: AttentionConfig.parse({ nextUp }) });
    expect(attention.assigned.map((issue) => issue.number)).toEqual([8, 7]);
  });

  it("NXT-04: reads only the configured fields and repositories", () => {
    const attention = run({ unclaimed: [pickable(1, { Scope: "🔙 Backend", Other: "x" })] }, {}, { config: AttentionConfig.parse({ nextUp }) });
    expect(attention.unclaimed[0]).toMatchObject({ scope: "🔙 Backend", priority: undefined });
    const { searches } = unclaimedSearches(AttentionConfig.parse({ orgs: ["acme"], nextUp: { repos: ["acme/shop"] } }), [], null);
    expect(searches).toEqual([{ source: "repo:acme/shop", query: "is:issue is:open no:assignee repo:acme/shop archived:false" }]);
  });

  it("NXT-04: looks in my own repos, whole orgs and single repos, one search each", () => {
    const config = AttentionConfig.parse({ nextUp: { mine: true, orgs: ["acme"], repos: ["other/tool"] } });
    expect(unclaimedSearches(config, [], "me")).toEqual({
      from: "config",
      searches: [
        { source: "mine", query: "is:issue is:open no:assignee user:me archived:false" },
        { source: "org:acme", query: "is:issue is:open no:assignee org:acme archived:false" },
        { source: "repo:other/tool", query: "is:issue is:open no:assignee repo:other/tool archived:false" },
      ],
    });
    expect(nextUpSources(config).map((source) => source.label)).toEqual(["My repos", "acme", "other/tool"]);
    expect(() => unclaimedSearches(config, [], null)).toThrow();
  });

  it("NXT-09: lists an issue found by several sources once, under each, and skips forks for my repos", () => {
    const fork = { ...pickable(2, {}), repository: { nameWithOwner: "me/fork", isFork: true } };
    const merged = mergeUnclaimed([
      { source: "org:acme", nodes: [pickable(1, {})] },
      { source: "repo:acme/shop", nodes: [pickable(1, {}), null] },
      { source: "mine", nodes: [fork] },
    ]);
    expect(merged.map((node) => [node.number, node.sources])).toEqual([[1, ["org:acme", "repo:acme/shop"]]]);
    const attention = run({ unclaimed: merged }, {});
    expect(attention.unclaimed[0].sources).toEqual(["org:acme", "repo:acme/shop"]);
  });

  it("NXT-08: without chosen repos, looks in my Paseo projects' repos, and never in all of GitHub", () => {
    const projects = ["acme/shop", "me/tool"];
    const scope = (config: unknown, repos: string[]) => unclaimedSearches(AttentionConfig.parse(config), repos, null);
    expect(scope({ nextUp: { repos: ["acme/web"] } }, projects).from).toBe("config");
    expect(scope({ orgs: ["acme"] }, projects)).toEqual({ from: "config", searches: [{ source: null, query: "is:issue is:open no:assignee org:acme archived:false" }] });
    expect(scope({}, projects)).toEqual({ from: "projects", searches: [{ source: null, query: "is:issue is:open no:assignee repo:acme/shop repo:me/tool archived:false" }] });
    expect(scope({}, [])).toEqual({ from: "none", searches: [] });
    // No sources of its own: back to the orgs and repos, then the projects.
    expect(scope({ nextUp: { mine: false, orgs: [], repos: [] } }, projects).from).toBe("projects");
    const variables = searchVariables(AttentionConfig.parse({}), NOW);
    expect(variables.mine).toBe("is:pr is:open author:@me archived:false"); // the searches about me stay GitHub-wide
  });
});

describe("GitHub requests", () => {
  it("SRC-01, GH-01: scopes every search to the configured orgs and repos", () => {
    const variables = searchVariables(AttentionConfig.parse({ orgs: ["acme"], repos: ["acme/web"] }), NOW);
    for (const query of Object.values(variables)) expect(query).toContain("org:acme repo:acme/web");
    expect(variables.reviews).toContain("user-review-requested:@me");
  });

  it("GH-01: sends each live search as its own request, and History as one, with only the fragments each uses", () => {
    expect(searchQuery(["mine"], true)).toMatch(/^query Attention\(\$mine: String!\) \{\n  viewer \{ login id \}\n  mine: search/);
    expect(searchQuery(["mine"]).match(/^fragment \w+/gm)).toEqual(["fragment pr", "fragment author"]);
    expect(searchQuery(["involved"]).match(/^fragment \w+/gm)).toEqual(["fragment author", "fragment comment"]);
    expect(searchQuery(HISTORY_SEARCHES).match(/^  \w+: search/gm)).toEqual(["  merged: search", "  reviewed: search", "  closed: search"]);
    expect(Object.keys(searchVariables(config, NOW)).sort()).toEqual([...LIVE_SEARCHES, ...HISTORY_SEARCHES].filter((name) => name !== "unclaimed").sort());
  });

  it("GH-01: refreshes every 15 minutes by default; the screen never forces a fetch", () => {
    expect(config.refreshMinutes).toBe(15);
  });

  it("ATT-08: records the latest activity by others for dismissals", () => {
    const [item] = run({ mine: [pr(1, { reviewThreads: { nodes: [thread(alice, 0.25)] }, comments: { nodes: [comment(me, "", 0.1)] } })] }).items;
    expect(item.othersActivityAt).toBe(daysAgo(0.25));
  });

  it("covers every section with the preview fixture", () => {
    const { data, details } = fixture(NOW);
    const attention = classify({ data, details, config, now: NOW });
    expect(new Set([...attention.items, ...classifyHistory(data)].map((item) => item.section)).size).toBe(16);
    expect(doing(attention).length).toBeGreaterThan(5);
    expect([attention.assigned.length, attention.unclaimed.length]).toEqual([2, 6]);
  });
});

