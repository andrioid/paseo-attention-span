import { describe, expect, it } from "vitest";
import type { AgentSummary, Item, Section, WrapItem } from "./attention";
import { inProgressEntries, withInProgress } from "./in-progress";
import { tabCounts } from "./item-view";
import { agent, clock, issue, item, viewMeta } from "./test-builders";
import { wrapItems } from "./wrap-up";

const { hoursAgo } = clock(new Date("2026-11-19T12:00:00Z"));
const started = (id: string, key: string, fields: Partial<AgentSummary> = {}) => agent(id, key, { kind: "start", lastActivityAt: hoursAgo(1), ...fields });

// What the screen and sidebar read: Doing, Waiting, History and Next up, with these lists.
const view = (fields: { doing?: Section[]; waiting?: { items: Item[] }[]; history?: Item[]; assigned?: ReturnType<typeof issue>[]; unclaimed?: ReturnType<typeof issue>[]; count?: number } = {}) => ({
  ...viewMeta(),
  count: fields.count ?? 0,
  doing: fields.doing ?? [],
  waiting: (fields.waiting ?? []).map((group) => ({ who: null, items: group.items })),
  history: fields.history ?? [],
  assigned: fields.assigned ?? [],
  unclaimed: fields.unclaimed ?? [],
  unclaimedFrom: "own" as const,
  projects: [],
  dismissedCount: 0,
  login: "me",
});
type View = ReturnType<typeof view>;
const project = (v: View, agents: AgentSummary[], wrap: WrapItem[] = []) => withInProgress(v as never, agents, wrap) as unknown as View & ReturnType<typeof withInProgress>;

describe("In progress", () => {
  it("SES-11: an issue I started leaves Next up for In progress, with Next up's issue", () => {
    const shown = project(view({ assigned: [issue("acme/shop#5")], unclaimed: [issue("acme/shop#6")] }), [started("a", "acme/shop#5")]);
    expect(shown.started.map((s) => [s.key, s.assigned, !!s.issue])).toEqual([["acme/shop#5", true, true]]);
    expect(shown.assigned).toEqual([]);
    expect(shown.unclaimed.map((i) => i.key)).toEqual(["acme/shop#6"]);
  });

  it("SES-11: an issue Next up doesn't know still shows, plainly", () => {
    const shown = project(view(), [started("a", "other/repo#9", { title: "Fix it" })]);
    expect(shown.started.map((s) => [s.repo, s.number, s.issue])).toEqual([["other/repo", 9, undefined]]);
  });

  it("SES-11: only sessions started on an issue count, not review or linked ones", () => {
    const shown = project(view({ unclaimed: [issue("acme/shop#5")] }), [agent("r", "acme/shop#5", { kind: "review" }), agent("l", "acme/shop#5")]);
    expect(shown.started).toEqual([]);
    expect(shown.unclaimed).toHaveLength(1);
  });

  it("SES-11, ATT-03: once a card shows the issue, like its PRs under it or a reply on it, it's there instead", () => {
    const grouped = { ...item("acme/shop#5", "needs_reviewer"), kind: "issue" as const };
    expect(project(view({ doing: [{ id: "needs_reviewer", title: "Needs a reviewer", items: [grouped] }] }), [started("a", "Acme/Shop#5")]).started).toEqual([]);
    expect(project(view({ waiting: [{ items: [item("acme/shop#5", "wait_answer")] }] }), [started("a", "acme/shop#5")]).started).toEqual([]);
  });

  it("SES-11, ATT-08: a card I dismissed doesn't come back as In progress", () => {
    expect(project({ ...view(), activeKeys: ["acme/shop#5"] } as View, [started("a", "acme/shop#5")]).started).toEqual([]);
  });

  it("SES-11, ATT-09: a linked session on a started issue is its session too, and counts when it needs me", () => {
    const shown = project(view({ count: 0 }), [started("a", "acme/shop#5"), agent("l", "acme/shop#5", { requiresAttention: true })]);
    expect(shown.started.map((s) => [s.sessions.map((a) => a.id), s.needsMe])).toEqual([[["l", "a"], true]]);
    expect(shown.count).toBe(1);
  });

  it("SES-11, ATT-22: a closed issue goes to Wrap up, not In progress", () => {
    const closed = { ...item("acme/shop#5", "done", { closedAt: hoursAgo(2) }), kind: "issue" as const };
    const v = view({ history: [closed] });
    const agents = [started("a", "acme/shop#5")];
    const wrap = wrapItems(v as never, agents);
    expect(wrap).toHaveLength(1);
    expect(project(v, agents, wrap).started).toEqual([]);
  });

  it("SES-11: a PR that doesn't close the issue leaves both, since one session can make several PRs", () => {
    const pr = item("acme/shop#20", "needs_reviewer");
    const shown = project(view({ doing: [{ id: "needs_reviewer", title: "Needs a reviewer", items: [pr] }] }), [started("a", "acme/shop#5")]);
    expect(shown.started.map((s) => s.key)).toEqual(["acme/shop#5"]);
  });

  it("SES-11, ATT-09: a started issue adds to Doing's count only while a session waits on me", () => {
    const v = view({ count: 2, assigned: [issue("acme/shop#5"), issue("acme/shop#6")] });
    const agents = [started("a", "acme/shop#5", { status: "running" }), started("b", "acme/shop#6"), started("c", "acme/shop#6", { requiresAttention: true })];
    const counts = tabCounts(project(v, agents) as never, []);
    expect(counts.doing).toBe(3);
    expect(counts.next).toBe(0);
  });

  it("PRS-05: drafts and started issues mix, whatever waits on me first, then the latest session; drafts without one keep their order last", () => {
    const drafts = [item("acme/shop#1", "drafts"), item("acme/shop#2", "drafts"), item("acme/shop#3", "drafts")];
    const agents = [agent("d2", "acme/shop#2", { lastActivityAt: hoursAgo(3) }), started("i", "acme/shop#7", { lastActivityAt: hoursAgo(1) }), started("j", "acme/shop#8", { requiresAttention: true, lastActivityAt: hoursAgo(9) })];
    const shown = project(view(), agents);
    const order = inProgressEntries(drafts, shown.started, agents).map((entry) => (entry.kind === "draft" ? entry.item.number : entry.started.number));
    expect(order).toEqual([8, 7, 2, 1, 3]);
  });
});
