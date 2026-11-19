import { describe, expect, it } from "vitest";
import { type Attention, type Item, liftActive, type NextUpIssue, type WaitingOn } from "../shared/attention";
import { AttentionConfig } from "../shared/config";
import { agent, issue, item, viewMeta } from "../shared/test-builders";
import { applyPending, buildView, doneItem, isPending, type Pending, SETTLE_MS } from "./view";

const meta = viewMeta({ feed: { fetchedAt: null, refreshing: false, error: null } });

const attention = (items: Item[]): Attention => ({ login: "me", items, assigned: [], unclaimed: [] });

describe("dismiss", () => {
  it("ATT-08: hides a dismissed item until someone else acts on it or its reason changes", () => {
    const dismissed = { a: { at: "2026-10-01T00:00:00Z", section: "reply" as const } };
    const hidden = buildView(attention([item("a", "reply", { othersActivityAt: "2026-10-01T00:00:00Z" })]), [], dismissed, meta);
    expect(hidden).toMatchObject({ count: 0, dismissedCount: 1, doing: [] });

    const newActivity = buildView(attention([item("a", "reply", { othersActivityAt: "2026-10-02T00:00:00Z" })]), [], dismissed, meta);
    expect(newActivity.count).toBe(1);

    const newReason = buildView(attention([item("a", "ci", { othersActivityAt: "2026-10-01T00:00:00Z" })]), [], dismissed, meta);
    expect(newReason.doing.map((section) => section.id)).toEqual(["ci"]);
  });

  it("ATT-09: counts what is visible in Doing; other tabs get their own lists", () => {
    const view = buildView(attention([item("a", "reply"), item("b", "drafts"), item("c", "wait_ci")]), [item("d", "done")], {}, meta);
    expect(view.count).toBe(2);
    expect(view.doing.map((section) => section.title)).toEqual(["Waiting for your reply", "In progress"]);
    expect(view.waiting.map((group) => group.items.map((i) => i.key))).toEqual([["c"]]);
    expect(view.history.map((h) => h.key)).toEqual(["d"]);
  });
});

describe("waiting", () => {
  const who = (login: string, team = false): WaitingOn => ({ login, team, since: "x" });
  const waiting = (key: string, section: Item["section"], since: string, people: WaitingOn[] = []): Item => ({
    ...item(key, section),
    waitingOn: people.length ? people : undefined,
    wait: { reason: "review", since },
  });
  const waitingOf = (items: Item[]) => buildView(attention(items), [], {}, meta).waiting;
  const groups = (items: Item[]) => waitingOf(items).map((group) => [group.who?.login ?? null, group.items.map((i) => i.key)]);

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
    expect(waitingOf([tagged, requested])[0].who).toMatchObject({ login: "copilot", bot: true });
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
    const items = ["a", "b", "c", "d"].map((key) => waiting(key, "wait_review", "2026-10-01"));
    const agents = [agent("b", "b"), agent("c", "c", { status: "running" }), agent("d", "d", { requiresAttention: true })];
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
    const view = buildView(attention([{ ...item("a", "ready", { othersActivityAt: "2026-10-01T00:00:00Z" }) }, { ...waiting("b", "ci", "2026-10-01"), waitingOn: undefined }]), [], {}, meta);
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
    const pr = item("a", "ready");
    const { attention, history } = applyPending(lists([pr, item("b", "ci")]), [item("old", "done")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(attention!.items.map((i) => i.key)).toEqual(["b"]);
    expect(history.map((i) => [i.key, i.section, i.closedAt])).toEqual([["a", "done", at], ["old", "done", undefined]]);
  });

  it("FRESH-02: once History has it, the prediction isn't shown twice", () => {
    const pr = item("a", "ready");
    const { history } = applyPending(lists([]), [item("a", "done")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(history).toHaveLength(1);
  });

  it("FRESH-02: an issue closed as not planned says so in History", () => {
    expect(doneItem(issue("i"), at, true)).toMatchObject({ kind: "issue", section: "done", chips: [{ text: "not planned" }] });
  });

  it("FRESH-02, HIS-04: until History is fetched, the issue type or title prefix tells the kind of work", () => {
    expect(doneItem({ ...issue("i"), type: "Bug" }, at)).toMatchObject({ work: "bug", chips: [{ text: "bug" }] });
    expect(doneItem({ ...item("a", "ready"), title: "feat: export" }, at)).toMatchObject({ work: "feature", chips: [{ text: "feature" }] });
    expect(doneItem(issue("i"), at, true)).toMatchObject({ notPlanned: true });
    expect(doneItem(item("a", "ready"), at).work).toBeUndefined();
  });

  it("FRESH-02: a merged PR History already lists under its issue isn't shown twice", () => {
    const pr = item("a", "ready");
    const issueDone = { ...item("i", "done"), kind: "issue" as const, children: [{ key: "a", number: 1, title: "a", url: "u", draft: false, chips: [], attention: false }] };
    const { history } = applyPending(lists([]), [issueDone], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(history.map((i) => i.key)).toEqual(["i"]);
  });

  it("FRESH-02: a closed item leaves every list; claim and unclaim move the issue", () => {
    const shown = applyPending(lists([item("pr", "drafts")], [issue("mine"), issue("back")], [issue("take"), issue("shut")]), [], {
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
    const shown = applyPending(lists([item("a", "ci")]), [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(shown.items[0]).toMatchObject({ section: "ci", chips: [chip] });
    const again = applyPending(shown, [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(again.items[0].chips).toHaveLength(1);
  });

  it("FRESH-02: shown until a fetch begun after GitHub caught up, or ten minutes at most", () => {
    const gone = pending({ kind: "gone" });
    expect(isPending(gone, { live: after(1_000), history: null }, time + 5_000)).toBe(true);
    expect(isPending(gone, { live: after(SETTLE_MS), history: null }, time + SETTLE_MS + 5_000)).toBe(false);
    expect(isPending(gone, { live: null, history: null }, time + 10 * 60_000)).toBe(false);
    const done = pending({ kind: "done", item: doneItem(item("a", "ready"), at) });
    expect(isPending(done, { live: after(SETTLE_MS), history: after(1_000) }, time + SETTLE_MS + 5_000)).toBe(true);
    expect(isPending(done, { live: after(SETTLE_MS), history: after(SETTLE_MS) }, time + SETTLE_MS + 5_000)).toBe(false);
  });
});

describe("History's weeks", () => {
  it("HIS-01: a fetch from before a new week began shows only the weeks it is now, in the device's time zone", () => {
    const now = new Date("2026-11-15T16:00:00Z"); // Monday 01:00 in Tokyo, a new week; still Sunday in UTC
    const view = (timeZone: string) =>
      buildView(null, [item("old", "done", { closedAt: "2026-11-09T02:00:00Z" }), item("new", "done", { closedAt: "2026-11-15T16:00:00Z" })], {}, viewMeta({ config: AttentionConfig.parse({ historyWeeks: 1 }) }), undefined, now, timeZone).history.map((shown) => shown.key);
    expect(view("Asia/Tokyo")).toEqual(["new"]);
    expect(view("UTC")).toEqual(["old", "new"]);
  });
});

describe("asking to close an issue", () => {
  it("ATT-24: doesn't ask while a PR is open for the issue, mine or anyone's, or once the live refresh found it closed; a mention alone doesn't stop it", () => {
    const ask = { key: "acme/shop#12", repo: "acme/shop", number: 12, title: "Export", url: "u", prs: [], mergedAt: "2026-11-01T00:00:00Z" };
    const asks = (live: Attention) => buildView(live, [], {}, { ...meta, closeAsks: [ask] }).closeAsks?.map((a) => a.number);
    const pr = { key: "acme/shop#40", number: 40, title: "Step", url: "u", draft: false, chips: [], attention: false };
    expect(asks(attention([item("ACME/shop#12", "ci", { kind: "issue", children: [pr] })]))).toEqual([]);
    expect(asks({ ...attention([]), unclaimed: [issue("acme/shop#12", { openPrs: [{ number: 41, url: "u", author: "alice" }] })] })).toEqual([]);
    expect(asks({ ...attention([]), askOff: ["acme/shop#12"] })).toEqual([]);
    expect(asks(attention([item("acme/shop#12", "reply", { kind: "issue" })]))).toEqual([12]);
  });

  it("ATT-24, HIS-01: only what merged within History's weeks asks, as History shows it", () => {
    const pr = (number: number, mergedAt: string) => ({ key: `acme/shop#${number}`, number, title: "t", url: "u", draft: false, chips: [], attention: false, mergedAt });
    const ask = (number: number, ...prs: ReturnType<typeof pr>[]) => ({ key: `acme/shop#${number}`, repo: "acme/shop", number, title: "t", url: "u", prs, mergedAt: prs.at(-1)!.mergedAt });
    // Four weeks from Monday 19 October.
    const asks = [ask(12, pr(34, "2026-10-10T00:00:00Z")), ask(13, pr(35, "2026-10-10T00:00:00Z"), pr(36, "2026-11-10T00:00:00Z"))];
    const view = buildView(attention([]), [], {}, { ...meta, closeAsks: asks }, undefined, new Date("2026-11-14T12:00:00Z"));
    expect(view.closeAsks?.map((a) => [a.number, a.prs.map((p) => p.number)])).toEqual([[13, [36]]]);
  });

  it("ATT-24: Next up keeps an issue it asks about, saying its PRs merged", () => {
    const ask = { key: "acme/shop#12", repo: "acme/shop", number: 12, title: "Export", url: "u", prs: [], mergedAt: "2026-11-01T00:00:00Z" };
    const view = buildView({ ...attention([]), assigned: [issue("acme/shop#12"), issue("acme/shop#13")] }, [], {}, { ...meta, closeAsks: [ask] });
    expect(view.assigned.map((next) => [next.key, !!next.prsMerged])).toEqual([["acme/shop#12", true], ["acme/shop#13", false]]);
  });
});
