import { describe, expect, it } from "vitest";
import { type AgentSummary, isIdle, type Item, type Section, type WrapItem } from "./attention";
import { agent, item as base, change, clock } from "./test-builders";
import { cleanSingle, doingCount, rememberGroups, unreadChanges, wrapItems } from "./wrap-up";

const { now, hoursAgo } = clock(new Date("2026-11-13T12:00:00Z"));
const item = (key: string, section: Item["section"], hours: number, children: Item["children"] = []) =>
  base(key, section, { othersActivityAt: hoursAgo(hours), closedAt: hoursAgo(hours), children });
const clean = { kind: "worktree" as const, name: "wt", dirty: false, ahead: 0 };
const session = (id: string, itemKey: string, fields: Partial<AgentSummary> = {}) =>
  agent(id, itemKey, { title: id, workspaceId: `ws-${id}`, lastActivityAt: hoursAgo(1), workspace: clean, ...fields });

// A Wrap up row on one item, with these sessions.
const wrapRow = (key: string, sessions: AgentSummary[]): WrapItem => ({ ...item(key, "wrap", 2), section: "wrap", wrap: { itemKey: key, keys: [key], finish: "merged 2h ago", sessions } });

const view = (history: Item[], doing: Section[] = [], waiting: { items: Item[] }[] = []) => ({ history, doing, waiting }) as Parameters<typeof wrapItems>[0];

describe("Wrap up membership", () => {
  it("ATT-22, ATT-04: a merged stack member whose open sibling is still active stays out, as remembered from the open stack", () => {
    const groups = rememberGroups({}, [{ key: "acme/shop#1", children: [{ key: "acme/shop#2", number: 2, title: "B", url: "u", draft: false, chips: [], attention: false }] }], now, 35);
    const flat = Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, group.keys]));
    // History lists the merged A alone; B is still open in Doing.
    const doing = [{ id: "drafts" as const, title: "My drafts", items: [item("acme/shop#2", "drafts", 1)] }];
    const stacked = { ...view([item("acme/shop#1", "done", 2)], doing), groups: flat };
    expect(wrapItems(stacked, [session("a", "acme/shop#1")], now)).toEqual([]);
    // Once B is done too, A's session is wrapped up.
    expect(wrapItems({ ...view([item("acme/shop#1", "done", 2)]), groups: flat }, [session("a", "acme/shop#1")], now)).toHaveLength(1);
    // Forgotten after the window.
    expect(rememberGroups(groups, [], new Date(now.getTime() + 40 * 86_400_000), 35)).toEqual({});
  });

  it("ATT-22: my own unmerged close is a row that says so", () => {
    const closed = { ...item("acme/shop#7", "done", 3), closedUnmerged: true as const };
    const rows = wrapItems({ ...view([]), ownClosed: [closed] }, [session("a", "acme/shop#7")], now);
    expect(rows.map((row) => row.wrap?.finish)).toEqual(["closed 3h ago, not merged"]);
  });

  it("ATT-22: a finished item with an idle session is a row, newest finish first", () => {
    const rows = wrapItems(
      view([item("acme/shop#1", "done", 2), item("acme/shop#2", "done", 5)]),
      [session("a", "acme/shop#1"), session("b", "acme/shop#2")],
      now,
    );
    expect(rows.map((row) => row.number)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ section: "wrap", actions: [], wrap: { finish: "merged 2h ago" } });
  });

  it("ATT-22: a busy or attention-needing session keeps its row out until idle", () => {
    const done = [item("acme/shop#1", "done", 2)];
    expect(wrapItems(view(done), [session("a", "acme/shop#1", { status: "running" })], now)).toEqual([]);
    expect(wrapItems(view(done), [session("a", "acme/shop#1", { requiresAttention: true })], now)).toEqual([]);
    expect(isIdle(session("a", "acme/shop#1"))).toBe(true);
  });

  it("ATT-22: a stack or issue group enters once, and only when every session it serves is done", () => {
    const issue = item("acme/shop#40", "done", 3, [{ key: "acme/shop#41", number: 41, title: "PR", url: "u", draft: false, chips: [], attention: false }]);
    const rows = wrapItems(view([issue]), [session("a", "acme/shop#40"), session("b", "acme/shop#41")], now);
    expect(rows).toHaveLength(1);
    expect(rows[0].wrap?.sessions.map((agent) => agent.id)).toEqual(["a", "b"]);
    // One of its PRs is still active: no row, even though the other session is idle.
    const active = [{ id: "drafts" as const, title: "My drafts", items: [item("acme/shop#41", "drafts", 1)] }];
    expect(wrapItems(view([issue], active), [session("a", "acme/shop#40"), session("b", "acme/shop#41")], now)).toEqual([]);
    expect(doingCount({ count: 4 }, rows)).toBe(5);
  });

  it("ATT-22: one session never yields two rows", () => {
    const issue = item("acme/shop#40", "done", 3, [{ key: "acme/shop#41", number: 41, title: "PR", url: "u", draft: false, chips: [], attention: false }]);
    const child = item("acme/shop#41", "done", 2);
    expect(wrapItems(view([issue, child]), [session("a", "acme/shop#41")], now)).toHaveLength(1);
  });

  it("ATT-22: a review session says so, and a change that isn't finished yet can hold a session", () => {
    const review = { ...item("acme/shop#190", "reviewed", 1), kind: "issue" as const };
    const rows = wrapItems(view([review]), [session("a", "acme/shop#190")], now);
    expect(rows[0].wrap?.review).toBe(true);
    const handover = { ...item("acme/shop#186", "handed_off", 5), change: change("took_over", "acme/shop#186", { actor: "phil", to: "phil", at: hoursAgo(5) }) };
    expect(wrapItems(view([handover]), [session("a", "acme/shop#186")], now)[0].wrap?.finish).toBe("phil took over 5h ago");
  });

  it("ATT-22: a reopened PR isn't cleanup", () => {
    const reopened = { ...item("acme/shop#181", "changed", 1), change: change("reopened", "acme/shop#181", { actor: "bob", at: hoursAgo(1) }) };
    expect(wrapItems(view([reopened]), [session("a", "acme/shop#181")], now)).toEqual([]);
  });
});

describe("Archive all clean", () => {
  it("ATT-22: takes a row only with one session that's clean by Paseo's reading", () => {
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1")]))).toBe(true);
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1"), session("b", "acme/shop#1")]))).toBe(false);
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1", { workspace: { ...clean, dirty: true } })]))).toBe(false);
    // Paseo saying nothing about commits ahead isn't clean.
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1", { workspace: { kind: "worktree", name: "wt", dirty: false } })]))).toBe(false);
  });
});

describe("unread changes", () => {
  it("HIS-07: a note about work in Wrap up waits there; busy work and reopened PRs stay unread", () => {
    const note = (key: string) => ({ ...item(key, "changed", 1), change: change("merged", key, { at: hoursAgo(1) }) });
    const wrap = [wrapRow("acme/shop#183", [session("a", "acme/shop#183")])];
    const notes = [note("acme/shop#183"), note("acme/shop#188")];
    expect(unreadChanges(notes, wrap).map((item) => item.key)).toEqual(["acme/shop#188"]);
  });
});
