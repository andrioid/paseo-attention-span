import { describe, expect, it } from "vitest";
import type { AgentSummary, Item } from "./attention";
import { sessionsFrom, type SessionWorkspaceEntry } from "./item-sessions";
import type { PaseoAgentEntry } from "./linked-sessions";
import { closedBranches } from "./linked-sessions";
import { item } from "./test-builders";

const agent = (id: string, workspaceId: string | null, extra: Partial<PaseoAgentEntry> = {}): PaseoAgentEntry => ({ id, workspaceId, status: "idle", ...extra });
const started = (id: string, itemKey: string, workspaceId: string, extra: Partial<PaseoAgentEntry> = {}) =>
  agent(id, workspaceId, { labels: { "attention-span": "1", "attention-span-item": itemKey, "attention-span-kind": "fix" }, ...extra });
const sub = (id: string, parent: string, extra: Partial<PaseoAgentEntry> = {}) => agent(id, "w1", { labels: { "paseo.parent-agent-id": parent }, ...extra });
const worktree = (id: string, branch: string, extra: Partial<SessionWorkspaceEntry> = {}): SessionWorkspaceEntry => ({
  id,
  workspaceKind: "worktree",
  name: id,
  gitRuntime: { currentBranch: branch, remoteUrl: "git@github.com:acme/shop.git", isDirty: false, aheadOfOrigin: 0 },
  ...extra,
});
// My PR merged from `branch` at `at`.
const merged = (key: string, branch: string, at: string, fields: Partial<Item> = {}) => {
  const base = item(key, "done", { closedAt: at, ...fields });
  return { ...base, target: { ...base.target, headRefName: branch } };
};
const keys = (agents: AgentSummary[]) => agents.map((a) => `${a.id}:${a.itemKey}`);

describe("the sessions on items", () => {
  it("SES-03: sessions Attention Span started keep their item and kind; archived ones are gone", () => {
    const labelled = [started("a", "acme/shop#1", "w1"), started("b", "acme/shop#2", "w1", { archivedAt: "2026-11-01" })];
    const [session] = sessionsFrom(labelled, [worktree("w1", "fix-1")]);
    expect(session).toMatchObject({ id: "a", itemKey: "acme/shop#1", kind: "fix", workspace: { kind: "worktree", branch: "fix-1", dirty: false, ahead: 0 } });
    expect(sessionsFrom(labelled, [])).toHaveLength(1);
  });

  it("ATT-22: sub-agents count with their session, and only a busy one keeps its row out", () => {
    const all = [
      agent("me", "w1"),
      sub("review", "me", { requiresAttention: true, attentionReason: "finished" }),
      sub("nested", "review", { status: "idle" }),
    ];
    const linked = [worktree("w1", "fix-1", { githubRuntime: { pullRequest: { url: "https://github.com/acme/shop/pull/5" } } })];
    expect(sessionsFrom(all, linked)).toMatchObject([{ id: "me", subAgents: { count: 2, working: false } }]);
    for (const attentionReason of ["permission", null, "something new"]) {
      const flagged = [...all.slice(0, 2), sub("nested", "review", { requiresAttention: true, attentionReason })];
      expect(sessionsFrom(flagged, linked)).toMatchObject([{ id: "me", subAgents: { count: 2, working: true } }]);
    }
    const failed = [...all.slice(0, 2), sub("nested", "review", { requiresAttention: true, attentionReason: "error" })];
    expect(sessionsFrom(failed, linked)).toMatchObject([{ id: "me", subAgents: { count: 2, working: false } }]);
  });

  it("ATT-22, SES-08: a worktree Paseo no longer links finds my merged or closed PR by its branch, the latest close winning", () => {
    const view = {
      history: [merged("acme/shop#5", "fix-1", "2026-11-01"), merged("acme/shop#9", "fix-1", "2026-11-10"), merged("acme/web#7", "fix-2", "2026-11-02")],
      ownClosed: [merged("acme/shop#8", "spike", "2026-11-03")],
    };
    const branches = closedBranches(view);
    const spaces = [worktree("w1", "fix-1"), worktree("w2", "spike"), worktree("w3", "fix-2"), worktree("w4", "fix-1", { workspaceKind: "local_checkout" })];
    const all = [agent("a", "w1"), agent("b", "w2"), agent("c", "w3"), agent("d", "w4")];
    // fix-2 merged in acme/web, but w3 is a checkout of acme/shop; a local checkout passes nothing on.
    expect(keys(sessionsFrom(all, spaces, branches))).toEqual(["a:acme/shop#9", "b:acme/shop#8"]);
  });

  it("SES-08: Paseo's link, then a shared Attention Span session, win over a branch", () => {
    const branches = closedBranches({ history: [merged("acme/shop#5", "fix-1", "2026-11-01")] });
    const linked = worktree("w1", "fix-1", { githubRuntime: { pullRequest: { url: "https://github.com/acme/shop/pull/12" } } });
    expect(keys(sessionsFrom([agent("a", "w1")], [linked], branches))).toEqual(["a:acme/shop#12"]);
    const labelled = [started("s", "acme/shop#3", "w1")];
    expect(keys(sessionsFrom([...labelled, agent("a", "w1")], [worktree("w1", "fix-1")], branches))).toEqual(["s:acme/shop#3", "a:acme/shop#3"]);
  });

  it("ATT-22, SES-08: a branch an open PR of mine is on maps to nothing, and neither does a worktree two items share", () => {
    const open = item("acme/shop#20", "changes");
    const view = {
      history: [merged("acme/shop#5", "fix-1", "2026-11-01"), merged("acme/shop#6", "fix-3", "2026-11-01")],
      doing: [{ id: "changes" as const, title: "Changes", items: [{ ...open, target: { ...open.target, headRefName: "fix-1" } }] }],
    };
    const branches = closedBranches(view);
    expect(keys(sessionsFrom([agent("a", "w1")], [worktree("w1", "fix-1")], branches))).toEqual([]);
    const two = [started("s", "acme/shop#3", "w2"), started("t", "acme/shop#4", "w2")];
    expect(keys(sessionsFrom([...two, agent("a", "w2")], [worktree("w2", "fix-3")], branches))).toEqual(["s:acme/shop#3", "t:acme/shop#4"]);
  });

  it("ATT-22: the worktree's remote, https or ssh, any case, names the repo; another host names none", () => {
    const branches = closedBranches({ history: [merged("acme/shop#5", "fix-1", "2026-11-01")] });
    const on = (remoteUrl: string) => worktree("w1", "fix-1", { gitRuntime: { currentBranch: "fix-1", remoteUrl } });
    for (const remote of ["https://github.com/Acme/Shop.git", "https://github.com/acme/shop/", "git@github.com:acme/shop"]) {
      expect(keys(sessionsFrom([agent("a", "w1")], [on(remote)], branches))).toEqual(["a:acme/shop#5"]);
    }
    expect(keys(sessionsFrom([agent("a", "w1")], [on("git@gitlab.com:acme/shop.git")], branches))).toEqual([]);
  });

  it("ATT-22: a merged PR under its closed issue is found by its branch too, by its own merge time; others' PRs I reviewed aren't", () => {
    const issue = item("acme/shop#40", "done", {
      kind: "issue",
      closedAt: "2026-11-05",
      children: [{ key: "acme/shop#41", number: 41, title: "PR", url: "u", draft: false, chips: [], attention: false, headRefName: "issue-40", mergedAt: "2026-11-01" }],
    });
    const reviewed = { ...merged("acme/shop#50", "theirs", "2026-11-05"), section: "reviewed" as const };
    // #42 reused the branch and merged on Nov 3: later than #41's merge, though the issue closed after both.
    const branches = closedBranches({ history: [issue, reviewed, merged("acme/shop#42", "issue-40", "2026-11-03")] });
    expect(keys(sessionsFrom([agent("a", "w1"), agent("b", "w2")], [worktree("w1", "issue-40"), worktree("w2", "theirs")], branches))).toEqual(["a:acme/shop#42"]);
  });
});
