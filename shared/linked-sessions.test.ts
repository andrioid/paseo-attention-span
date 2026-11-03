import { describe, expect, it } from "vitest";
import { type AgentSummary, itemSessions, looseSessions } from "./attention";
import { linkedSessions, type PaseoAgentEntry, type PaseoWorkspaceEntry, pullRequestKey } from "./linked-sessions";

const labelled = (id: string, itemKey: string, workspaceId: string): AgentSummary => ({
  id,
  itemKey,
  kind: "start",
  status: "idle",
  requiresAttention: false,
  title: null,
  workspaceId,
  lastActivityAt: "2026-11-01",
});
const agent = (id: string, workspaceId: string, extra: Partial<PaseoAgentEntry> = {}): PaseoAgentEntry => ({
  id,
  workspaceId,
  status: "idle",
  updatedAt: "2026-11-02",
  ...extra,
});
const workspace = (id: string, extra: Partial<PaseoWorkspaceEntry> = {}): PaseoWorkspaceEntry => ({ id, workspaceKind: "worktree", ...extra });
const linkedTo = (number: number) => ({ githubRuntime: { pullRequest: { url: `https://github.com/acme/shop/pull/${number}`, number } } });
const keys = (agents: AgentSummary[]) => agents.map((a) => `${a.id}:${a.itemKey}`);

describe("pullRequestKey", () => {
  it("SES-08: reads the repo and number from a pull request URL", () => {
    expect(pullRequestKey("https://github.com/acme/shop/pull/103")).toBe("acme/shop#103");
    expect(pullRequestKey("https://github.com/acme/shop/pull/103/files")).toBe("acme/shop#103");
  });

  it("SES-08: ignores issues and other hosts", () => {
    expect(pullRequestKey("https://github.com/acme/shop/issues/90")).toBeNull();
    expect(pullRequestKey("https://gitlab.com/acme/shop/pull/1")).toBeNull();
  });
});

describe("linkedSessions", () => {
  it("SES-08: puts an agent on the PR Paseo linked its workspace to, with no kind", () => {
    const [linked] = linkedSessions([], [agent("a", "w1")], [workspace("w1", linkedTo(103))]);
    expect(linked).toMatchObject({ id: "a", itemKey: "acme/shop#103", workspaceId: "w1" });
    expect(linked.kind).toBeUndefined();
  });

  it("SES-08: links any workspace kind to its PR", () => {
    expect(keys(linkedSessions([], [agent("a", "w1")], [workspace("w1", { workspaceKind: "checkout", ...linkedTo(103) })]))).toEqual(["a:acme/shop#103"]);
  });

  it("SES-08: puts a new chat in a session's worktree on that session's item", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1")];
    expect(keys(linkedSessions(sessions, [agent("s", "w1"), agent("a", "w1")], [workspace("w1")]))).toEqual(["a:acme/shop#90"]);
  });

  it("SES-08: prefers the workspace's PR to the item of the session beside it", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1")];
    expect(keys(linkedSessions(sessions, [agent("a", "w1")], [workspace("w1", linkedTo(103))]))).toEqual(["a:acme/shop#103"]);
  });

  it("SES-08: never passes an item on in a main or local checkout", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1"), labelled("t", "acme/shop#91", "w2")];
    const spaces = [workspace("w1", { workspaceKind: "checkout" }), workspace("w2", { workspaceKind: "local_checkout" })];
    expect(linkedSessions(sessions, [agent("a", "w1"), agent("b", "w2")], spaces)).toEqual([]);
  });

  it("SES-08: passes on neither item in a worktree with sessions for two", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1"), labelled("t", "acme/shop#91", "w1")];
    expect(linkedSessions(sessions, [agent("a", "w1")], [workspace("w1")])).toEqual([]);
  });

  it("SES-08: counts the item once whatever the case of its sessions' keys", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1"), labelled("t", "Acme/Shop#90", "w1")];
    expect(keys(linkedSessions(sessions, [agent("a", "w1")], [workspace("w1")]))).toEqual(["a:acme/shop#90"]);
  });

  it("SES-08: leaves out agents in a workspace that belongs to no item", () => {
    expect(linkedSessions([], [agent("a", "w1"), agent("b", "w9")], [workspace("w1")])).toEqual([]);
  });

  it("SES-08: leaves out archived agents, archiving workspaces and agents another agent started", () => {
    const spaces = [workspace("w1", linkedTo(103)), workspace("w2", { ...linkedTo(104), archivingAt: "2026-11-02" })];
    const agents = [agent("a", "w1", { archivedAt: "2026-11-02" }), agent("b", "w2"), agent("c", "w1", { labels: { "paseo.parent-agent-id": "x" } })];
    expect(linkedSessions([], agents, spaces)).toEqual([]);
  });

  it("SES-08: keeps a labelled session on its own item", () => {
    const sessions = [labelled("s", "acme/shop#90", "w1")];
    expect(linkedSessions(sessions, [agent("s", "w1")], [workspace("w1", linkedTo(103))])).toEqual([]);
  });

  it("SES-08: shows a PR's outside session on the issue it sits under, as one with no kind", () => {
    const sessions = linkedSessions([], [agent("a", "w1")], [workspace("w1", linkedTo(103))]);
    const issue = { key: "acme/shop#90", closedAt: undefined, children: [{ key: "acme/shop#103" }] } as Parameters<typeof itemSessions>[1];
    const found = itemSessions(sessions, issue);
    expect(found.map((a) => a.id)).toEqual(["a"]);
    expect(looseSessions(found, ["review"]).map((a) => a.id)).toEqual(["a"]);
  });
});
