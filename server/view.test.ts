import { describe, expect, it } from "vitest";
import { type AgentSummary, type Attention, checkoutPr, type Item, liftActive, type NextUpIssue, type WaitingOn } from "../shared/attention";
import { AttentionConfig } from "../shared/config";
import { renderPrompt } from "../shared/prompts";
import { applyPending, buildView, doneItem, isPending, type Pending, SETTLE_MS, waitingGroups } from "./view";

const config = AttentionConfig.parse({});
const feed = { fetchedAt: null, refreshing: false, error: null };
const meta = { feeds: { live: feed, history: feed }, scopes: [], sources: [], projectFilter: [], historyFilter: [], config, pending: 0 };

function item(key: string, section: Item["section"], othersActivityAt: string): Item {
  return {
    key,
    section,
    kind: "pr",
    repo: "o/r",
    number: 1,
    title: key,
    url: "https://x",
    draft: false,
    chips: [],
    actions: [],
    children: [],
    target: { kind: "pr", repo: "o/r", number: 1, title: key, url: "https://x" },
    othersActivityAt,
  };
}

const attention = (items: Item[]): Attention => ({ login: "me", items, assigned: [], unclaimed: [] });

describe("dismiss", () => {
  it("ATT-08: hides a dismissed item until someone else acts on it or its reason changes", () => {
    const dismissed = { a: { at: "2026-10-01T00:00:00Z", section: "reply" as const } };
    const hidden = buildView(attention([item("a", "reply", "2026-10-01T00:00:00Z")]), [], dismissed, meta);
    expect(hidden).toMatchObject({ count: 0, dismissedCount: 1, doing: [] });

    const newActivity = buildView(attention([item("a", "reply", "2026-10-02T00:00:00Z")]), [], dismissed, meta);
    expect(newActivity.count).toBe(1);

    const newReason = buildView(attention([item("a", "ci", "2026-10-01T00:00:00Z")]), [], dismissed, meta);
    expect(newReason.doing.map((section) => section.id)).toEqual(["ci"]);
  });

  it("ATT-09: counts what is visible in Doing; other tabs get their own lists", () => {
    const view = buildView(attention([item("a", "reply", "x"), item("b", "drafts", "x"), item("c", "wait_ci", "x")]), [item("d", "done", "x")], {}, meta);
    expect(view.count).toBe(2);
    expect(view.doing.map((section) => section.title)).toEqual(["Waiting for your reply", "My drafts"]);
    expect(view.waiting.map((group) => group.items.map((i) => i.key))).toEqual([["c"]]);
    expect(view.history.map((h) => h.key)).toEqual(["d"]);
  });
});

describe("waiting", () => {
  const who = (login: string, team = false): WaitingOn => ({ login, team, since: "x" });
  const waiting = (key: string, section: Item["section"], since: string, people: WaitingOn[] = []): Item => ({
    ...item(key, section, "x"),
    waitingOn: people.length ? people : undefined,
    wait: { reason: "review", since },
  });
  const groups = (items: Item[]) => waitingGroups(items).map((group) => [group.who?.login ?? null, group.items.map((i) => i.key)]);

  it("WAI-01: groups by who it waits on, whoever blocks the most first, ties by longest wait, each one's work oldest first, and the rest last", () => {
    const items = [
      waiting("a", "wait_review", "2026-10-03", [who("bob")]),
      waiting("b", "wait_answer", "2026-10-02", [who("alice"), who("bob")]),
      waiting("c", "wait_ci", "2026-10-01"),
      waiting("d", "wait_review", "2026-10-04", [who("acme/frontend", true)]),
    ];
    expect(groups(items)).toEqual([
      ["bob", ["b", "a"]],
      ["alice", ["b"]],
      ["acme/frontend", ["d"]],
      [null, ["c"]],
    ]);
  });

  it("WAI-03: a login that's a requested bot anywhere is a bot, even where it was only tagged first", () => {
    const tagged = waiting("a", "wait_answer", "2026-10-01", [who("copilot")]);
    const requested = waiting("b", "wait_review", "2026-10-02", [{ ...who("copilot"), bot: true }]);
    expect(waitingGroups([tagged, requested])[0].who).toMatchObject({ login: "copilot", bot: true });
    expect(tagged.waitingOn![0].bot).toBeUndefined();
  });

  it("WAI-01: bots come after people and teams, however much they block, as they can't be nudged", () => {
    const copilot = { ...who("copilot"), bot: true };
    const items = [waiting("a", "wait_review", "2026-10-01", [copilot]), waiting("b", "wait_review", "2026-10-02", [copilot]), waiting("c", "wait_review", "2026-10-03", [who("bob")])];
    expect(groups(items)).toEqual([
      ["bob", ["c"]],
      ["copilot", ["a", "b"]],
    ]);
  });

  it("WAI-01: work with a session that needs me leads, then one that's working; a seen, finished one stays put", () => {
    const agent = (itemKey: string, status: string, requiresAttention: boolean): AgentSummary => ({ id: itemKey, itemKey, status, requiresAttention, title: null, workspaceId: null, lastActivityAt: null });
    const items = ["a", "b", "c", "d"].map((key) => waiting(key, "wait_review", "2026-10-01"));
    const agents = [agent("b", "idle", false), agent("c", "running", false), agent("d", "idle", true)];
    expect(liftActive(items, agents).map((i) => i.key)).toEqual(["d", "c", "a", "b"]);
  });

  it("PRS-15, ATT-08: dismissing my PR in Doing hides it from Waiting too", () => {
    const ready = { ...waiting("a", "ready", "2026-10-01", [who("bob")]), othersActivityAt: "2026-10-01T00:00:00Z" };
    const view = buildView(attention([ready]), [], { a: { at: "2026-10-02T00:00:00Z", section: "ready" } }, meta);
    expect(view.waiting).toEqual([]);
  });

  it("WAI-01: someone tagged by another spelling of their name is one person; a team is apart from a person of its name", () => {
    const items = [waiting("a", "wait_answer", "2026-10-01", [who("Alice")]), waiting("b", "wait_review", "2026-10-02", [who("alice")]), waiting("c", "wait_review", "2026-10-03", [who("alice", true)])];
    expect(groups(items)).toEqual([
      ["Alice", ["a", "b"]],
      ["alice", ["c"]],
    ]);
  });

  it("WAI-01, PRS-15: my PR in Doing that waits on whom I asked is in Waiting too, mixed in by wait, and counts once in Doing", () => {
    const view = buildView(attention([waiting("a", "ready", "2026-10-01", [who("bob")]), waiting("b", "wait_review", "2026-10-05", [who("bob")])]), [], {}, meta);
    expect(view.count).toBe(1);
    expect(view.waiting.map((group) => group.items.map((i) => i.key))).toEqual([["a", "b"]]);
  });

  it("PRS-15: my PR in Doing that waits on nobody stays out of Waiting", () => {
    const view = buildView(attention([{ ...item("a", "ready", "2026-10-01T00:00:00Z") }, { ...waiting("b", "ci", "2026-10-01"), waitingOn: undefined }]), [], {}, meta);
    expect(view.count).toBe(2);
    expect(view.waiting).toEqual([]);
  });
});

describe("pending changes", () => {
  const at = "2026-10-30T12:00:00.000Z";
  const time = new Date(at).getTime();
  const after = (ms: number) => new Date(time + ms).toISOString();
  const issue = (key: string): NextUpIssue => ({ key, repo: "o/r", number: 2, title: key, url: "https://x/2", createdAt: at, sources: [], openPrs: [] });
  const pending = (effect: Pending["effect"]): Pending => ({ at, effect });
  const lists = (items: Item[], assigned: NextUpIssue[] = [], unclaimed: NextUpIssue[] = []): Attention => ({ login: "me", items, assigned, unclaimed });

  it("FRESH-02: a merged PR leaves Doing and shows in History at once", () => {
    const pr = item("a", "ready", "x");
    const { attention, history } = applyPending(lists([pr, item("b", "ci", "x")]), [item("old", "done", "x")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(attention!.items.map((i) => i.key)).toEqual(["b"]);
    expect(history.map((i) => [i.key, i.section, i.closedAt])).toEqual([["a", "done", at], ["old", "done", undefined]]);
  });

  it("FRESH-02: once History has it, the prediction isn't shown twice", () => {
    const pr = item("a", "ready", "x");
    const { history } = applyPending(lists([]), [item("a", "done", "x")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(history).toHaveLength(1);
  });

  it("FRESH-02: an issue closed as not planned says so in History", () => {
    expect(doneItem(issue("i"), at, true)).toMatchObject({ kind: "issue", section: "done", chips: [{ text: "not planned" }] });
  });

  it("FRESH-02, HIS-04: until History is fetched, the issue type or title prefix tells the kind of work", () => {
    expect(doneItem({ ...issue("i"), type: "Bug" }, at)).toMatchObject({ work: "bug", chips: [{ text: "bug" }] });
    expect(doneItem({ ...item("a", "ready", "x"), title: "feat: export" }, at)).toMatchObject({ work: "feature", chips: [{ text: "feature" }] });
    expect(doneItem(issue("i"), at, true)).toMatchObject({ notPlanned: true });
    expect(doneItem(item("a", "ready", "x"), at).work).toBeUndefined();
  });

  it("FRESH-02: a merged PR History already lists under its issue isn't shown twice", () => {
    const pr = item("a", "ready", "x");
    const issueDone = { ...item("i", "done", "x"), kind: "issue" as const, children: [{ key: "a", number: 1, title: "a", url: "u", draft: false, chips: [], attention: false }] };
    const { history } = applyPending(lists([]), [issueDone], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(history.map((i) => i.key)).toEqual(["i"]);
  });

  it("FRESH-02: a closed item leaves every list; claim and unclaim move the issue", () => {
    const shown = applyPending(lists([item("pr", "drafts", "x")], [issue("mine"), issue("back")], [issue("take"), issue("shut")]), [], {
      pr: pending({ kind: "gone" }),
      take: pending({ kind: "claimed" }),
      back: pending({ kind: "unclaimed" }),
      shut: pending({ kind: "gone" }),
    }).attention!;
    expect(shown.items).toEqual([]);
    expect(shown.assigned.map((i) => i.key)).toEqual(["mine", "take"]);
    expect(shown.unclaimed.map((i) => i.key)).toEqual(["back"]);
  });

  it("FRESH-02: a change whose outcome is uncertain keeps the card in place, with a chip", () => {
    const chip = { text: "rerunning", tone: "neutral" as const };
    const shown = applyPending(lists([item("a", "ci", "x")]), [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(shown.items[0]).toMatchObject({ section: "ci", chips: [chip] });
    const again = applyPending(shown, [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(again.items[0].chips).toHaveLength(1);
  });

  it("FRESH-02: shown until a fetch begun after GitHub caught up, or ten minutes at most", () => {
    const gone = pending({ kind: "gone" });
    expect(isPending(gone, { live: after(1_000), history: null }, time + 5_000)).toBe(true);
    expect(isPending(gone, { live: after(SETTLE_MS), history: null }, time + SETTLE_MS + 5_000)).toBe(false);
    expect(isPending(gone, { live: null, history: null }, time + 10 * 60_000)).toBe(false);
    const done = pending({ kind: "done", item: doneItem(item("a", "ready", "x"), at) });
    expect(isPending(done, { live: after(SETTLE_MS), history: after(1_000) }, time + SETTLE_MS + 5_000)).toBe(true);
    expect(isPending(done, { live: after(SETTLE_MS), history: after(SETTLE_MS) }, time + SETTLE_MS + 5_000)).toBe(false);
  });
});

describe("prompts", () => {
  const target = { kind: "pr" as const, repo: "o/r", number: 7, title: "T", url: "https://x/7", headRefName: "feature", baseRefName: "main", stack: [{ number: 7, head: "feature", base: "main" }, { number: 8, head: "next", base: "feature" }] };

  it("SES-04: fills a built-in template with the item and its context", () => {
    const prompt = renderPrompt("rebase", target, "Branches: feature", config);
    expect(prompt).toContain("o/r#7");
    expect(prompt).toContain("#7 → #8");
    expect(prompt).toContain("--update-refs");
    expect(prompt).toContain('reply "push"'); // UPS-05: stops for approval after resolving conflicts
    expect(prompt).toMatch(/no conflicts, push .*--force-with-lease/); // UPS-06: a clean rebase pushes by itself
    expect(prompt).toContain("Branches: feature");
  });

  it("SES-04: review sweeps the browser only if equipped and reports a verdict; address applies only trivial fixes", () => {
    const review = renderPrompt("review", target, "", config);
    expect(review).toMatch(/Browser sweep, only if you're equipped/);
    expect(review).toContain("Verdict");
    expect(review).toContain("Do not post anything to GitHub.");
    const address = renderPrompt("address", target, "", config);
    expect(address).toContain("Trivial means no behavior change");
    expect(address).toContain("Commit, but don't push.");
    expect(address).toContain("Do not reply on GitHub.");
  });

  it("ATT-04: review of a stack checks out its top and reviews only the PRs asking for it; Rebase lists only my branches", () => {
    const mixed = { ...target, stack: [{ number: 6, head: "theirs", base: "main", review: true as const }, ...target.stack] };
    const review = renderPrompt("review", mixed, "", config);
    expect(review).toContain("Review the pull requests #6 in o/r, part of the stack #6 → #7 → #8");
    expect(review).toContain("checkout of the top branch, next");
    expect(review).toContain("Review only those");
    expect(renderPrompt("rebase", mixed, "", config)).toContain("Stack, bottom first: #7 → #8");
    expect(checkoutPr("review", mixed)).toEqual({ number: 8, head: "next" });
    expect(checkoutPr("rebase", mixed)).toEqual({ number: 7, head: "feature" });
    expect(checkoutPr("review", { ...target, stack: [target.stack[0]] })).toEqual({ number: 7, head: "feature" });
  });

  it("SES-04: a template in config.json replaces the built-in one", () => {
    const custom = AttentionConfig.parse({ prompts: { fix: "Fix {{repo}}#{{number}} on {{head}}: {{context}}" } });
    expect(renderPrompt("fix", target, "log", custom)).toBe("Fix o/r#7 on feature: log");
  });
});
