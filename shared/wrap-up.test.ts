import { describe, expect, it } from "vitest";
import { type AgentSummary, isIdle, type Item, type Section, type WrapItem } from "./attention";
import { acknowledged, cleanSingle, doingCount, EMPTY_WATCH, rememberGroups, sessionCleanliness, unreadChanges, unsavedText, watchArchives, wrapItems } from "./wrap-up";

const now = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

function item(key: string, section: Item["section"], hours: number, children: Item["children"] = []): Item {
  return {
    key,
    section,
    kind: "pr",
    draft: false,
    repo: "acme/shop",
    number: Number(key.split("#")[1] ?? 1),
    title: key,
    url: `https://github.com/${key.replace("#", "/pull/")}`,
    chips: [],
    actions: [],
    children,
    target: { kind: "pr", repo: "acme/shop", number: 1, title: key, url: "u" },
    othersActivityAt: hoursAgo(hours),
    closedAt: hoursAgo(hours),
  };
}

function session(id: string, itemKey: string, overrides: Partial<AgentSummary> = {}, workspace: AgentSummary["workspace"] = { kind: "worktree", name: "wt", dirty: false, ahead: 0 }): AgentSummary {
  return { id, itemKey, status: "idle", requiresAttention: false, title: id, workspaceId: `ws-${id}`, lastActivityAt: hoursAgo(1), workspace, ...overrides };
}

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
    const handover = { ...item("acme/shop#186", "handed_off", 5), change: { id: "h", kind: "took_over" as const, subjectId: "P186", subject: "pr" as const, key: "acme/shop#186", repo: "acme/shop", number: 186, title: "Split", url: "u", actor: "phil", to: "phil", at: hoursAgo(5) } };
    expect(wrapItems(view([handover]), [session("a", "acme/shop#186")], now)[0].wrap?.finish).toBe("phil took over 5h ago");
  });

  it("ATT-22: a reopened PR isn't cleanup", () => {
    const reopened = { ...item("acme/shop#181", "changed", 1), change: { id: "r", kind: "reopened" as const, subjectId: "P181", subject: "pr" as const, key: "acme/shop#181", repo: "acme/shop", number: 181, title: "Paginate", url: "u", actor: "bob", at: hoursAgo(1) } };
    expect(wrapItems(view([reopened]), [session("a", "acme/shop#181")], now)).toEqual([]);
  });
});

describe("unsaved work", () => {
  it("ATT-22: clean, dirty and unknown worktrees read as they are", () => {
    expect(sessionCleanliness(session("a", "x"))).toBe("clean");
    expect(sessionCleanliness(session("a", "x", {}, { kind: "worktree", name: "wt", dirty: true, ahead: 0 }))).toBe("dirty");
    expect(sessionCleanliness(session("a", "x", {}, { kind: "worktree", name: "wt", dirty: true, ahead: 2 }))).toBe("dirty");
    expect(sessionCleanliness(session("a", "x", {}, { kind: "worktree", name: "wt" }))).toBe("unknown");
    expect(sessionCleanliness(session("a", "x", { workspace: undefined }))).toBe("unknown");
    expect(unsavedText(session("a", "x", {}, { kind: "worktree", name: "wt", dirty: true, ahead: 1, branch: "split-invoice-pdf" }))).toBe(
      "uncommitted changes and 1 unpushed commit on split-invoice-pdf",
    );
    expect(unsavedText(session("a", "x", { workspace: undefined }))).toBe("Couldn't check for unsaved changes");
  });

  it("ATT-22: only one clean session makes a row ready for Archive all clean", () => {
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1")]))).toBe(true);
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1"), session("b", "acme/shop#1")]))).toBe(false);
    expect(cleanSingle(wrapRow("acme/shop#1", [session("a", "acme/shop#1", {}, { kind: "worktree", name: "wt", dirty: true, ahead: 0 })]))).toBe(false);
    // Paseo saying nothing about commits ahead isn't clean.
    expect(sessionCleanliness(session("a", "x", {}, { kind: "worktree", name: "wt", dirty: false }))).toBe("unknown");
  });
});

describe("unread changes", () => {
  it("HIS-07: a note about work in Wrap up waits there; busy work and reopened PRs stay unread", () => {
    const note = (key: string) => ({ ...item(key, "changed", 1), change: { id: key, kind: "merged" as const, subjectId: key, subject: "pr" as const, key, repo: "acme/shop", number: 1, title: key, url: "u", at: hoursAgo(1) } });
    const wrap = [wrapRow("acme/shop#183", [session("a", "acme/shop#183")])];
    const notes = [note("acme/shop#183"), note("acme/shop#188")];
    expect(unreadChanges(notes, wrap).map((item) => item.key)).toEqual(["acme/shop#188"]);
  });
});

describe("sessions archived in Paseo itself", () => {
  const row = wrapRow("acme/shop#1", [session("a", "acme/shop#1"), session("b", "acme/shop#1")]);

  it("HIS-07, ATT-22: a row that goes because all its sessions are gone is pending until acknowledged", () => {
    const seen = watchArchives(EMPTY_WATCH, [row], [{ id: "a" }, { id: "b" }]);
    expect(seen.pending).toEqual({});
    // One session left: the row went for another reason, so nothing to acknowledge.
    expect(watchArchives(seen, [], [{ id: "b" }]).pending).toEqual({});
    const gone = watchArchives(seen, [], []);
    expect(gone.pending).toEqual({ [row.key]: ["acme/shop#1"] });
    // A failed request leaves it pending through later polls, until the server says done.
    const later = watchArchives(gone, [], []);
    expect(later.pending).toEqual({ [row.key]: ["acme/shop#1"] });
    expect(acknowledged(later, row.key).pending).toEqual({});
  });

  it("HIS-07, ATT-22: a row still shown is never pending", () => {
    expect(watchArchives(watchArchives(EMPTY_WATCH, [row], [{ id: "a" }]), [row], []).pending).toEqual({});
  });
});
