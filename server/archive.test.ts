import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { archiveSessions, type ArchiveSession, gitUnsaved, unsaved } from "./archive";

type Paseo = PluginHandlerContext["paseo"];

function session(fields: Partial<ArchiveSession> = {}): ArchiveSession {
  return { agentId: "a1", workspaceId: "w1", title: "Fix CI", dirty: false, ahead: 0, ownedWorktree: true, ...fields };
}

function paseoFor(agents: { id: string; workspaceId?: string; status?: string }[], workspaces: { id: string; workspaceKind: string; gitRuntime?: { isDirty: boolean; aheadOfOrigin: number; currentBranch: string } }[], terminals: string[] = []) {
  const archivedAgents: string[] = [];
  const archivedWorkspaces: string[] = [];
  const api = {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent: { status: "idle", requiresAttention: false, title: "Session", ...agent } })) }),
      ref: (id: string) => ({ archive: async () => (archivedAgents.push(id), { archivedAt: "now" }) }),
    },
    workspaces: {
      list: async () => ({ entries: workspaces.map((workspace) => ({ gitRuntime: { isDirty: false, aheadOfOrigin: 0, currentBranch: "b" }, ...workspace })) }),
      archive: async (id: string) => (archivedWorkspaces.push(id), { archivedAt: "now", error: null, workspaceId: id, requestId: "r" }),
    },
    terminals: { list: async () => ({ entries: terminals.map((id) => ({ id, workspaceId: "w1", cwd: "/tmp", name: id })), requestId: "r" }) },
  };
  return { paseo: api as unknown as Paseo, archivedAgents, archivedWorkspaces };
}

describe("archive safety", () => {
  it("ATT-22: a clean single session archives its agent and its own worktree", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }]);
    expect(await archiveSessions(paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false)).toEqual({ ok: true });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: a local checkout's workspace is never archived, and a shared worktree's neither", async () => {
    const local = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "local_checkout" }]);
    await archiveSessions(local.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false);
    expect(local.archivedAgents).toEqual(["a1"]);
    expect(local.archivedWorkspaces).toEqual([]);
    const shared = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w1" },
      ],
      [{ id: "w1", workspaceKind: "worktree" }],
    );
    await archiveSessions(shared.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false);
    expect(shared.archivedAgents).toEqual(["a1"]);
    expect(shared.archivedWorkspaces).toEqual([]);
    // A terminal in it is somebody's shell: leave the worktree, still put the agent away.
    const terminal = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }], ["t1"]);
    await archiveSessions(terminal.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false);
    expect(terminal.archivedAgents).toEqual(["a1"]);
    expect(terminal.archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: unsaved work asks first, and unknown counts as unsaved", async () => {
    expect(await unsaved(session())).toBeNull();
    expect(await unsaved(session({ dirty: true, ahead: 1 }))).toMatchObject({ commits: 1 });
    expect(await unsaved(session({ dirty: null, ahead: null }))).toMatchObject({ unknown: true });
    expect(await gitUnsaved(session(), undefined)).toMatchObject({ unknown: true });
    const dirty = paseoFor(
      [{ id: "a1", workspaceId: "w1" }],
      [{ id: "w1", workspaceKind: "worktree", gitRuntime: { isDirty: true, aheadOfOrigin: 1, currentBranch: "b" } }],
    );
    // Paseo says dirty; no directory to ask git, so the refusal keeps the row.
    const refusal = await archiveSessions(dirty.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false);
    expect(refusal).toMatchObject({ ok: false, reason: "unsaved" });
    expect(dirty.archivedAgents).toEqual([]);
    expect(await archiveSessions(dirty.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], true)).toEqual({ ok: true });
    expect(dirty.archivedAgents).toEqual(["a1"]);
  });

  it("ATT-22: clean needs both answers: an unknown ahead count, or a git count that failed, asks first", async () => {
    expect(await unsaved(session({ dirty: false, ahead: null }))).toMatchObject({ unknown: true });
    expect(await unsaved(session({ dirty: null, ahead: 0 }))).toMatchObject({ unknown: true });
    // A directory git can't read: unknown, not zero.
    expect(await gitUnsaved(session(), "/nonexistent/attention-span-test")).toMatchObject({ unknown: true });
    const unknownAhead = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", gitRuntime: { isDirty: false, aheadOfOrigin: null as unknown as number, currentBranch: "b" } }]);
    expect(await archiveSessions(unknownAhead.paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false)).toMatchObject({ ok: false, reason: "unsaved" });
    expect(unknownAhead.archivedAgents).toEqual([]);
  });

  it("ATT-22: a session that started working during the checks isn't archived", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }]);
    let calls = 0;
    const list = paseo.agents.list;
    paseo.agents.list = (async (...args: Parameters<typeof list>) => {
      const result = await list(...args);
      calls += 1;
      return calls > 1 ? { ...result, entries: result.entries.map(({ agent }) => ({ agent: { ...agent, status: "running" } })) } : result;
    }) as typeof list;
    expect(await archiveSessions(paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false)).toMatchObject({ ok: false, reason: "working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a worktree that won't go is said, after the sessions are put away", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }]);
    paseo.workspaces.archive = (async () => {
      throw new Error("busy");
    }) as typeof paseo.workspaces.archive;
    expect(await archiveSessions(paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], false)).toEqual({ ok: true, warning: "Archived, but couldn't remove b: busy" });
    expect(archivedAgents).toEqual(["a1"]);
  });

  it("ATT-22: a session that is still working never archives", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1", status: "running" }], [{ id: "w1", workspaceKind: "worktree" }]);
    expect(await archiveSessions(paseo, [{ itemKey: "k", agentIds: ["a1"], keys: ["k"] }], true)).toMatchObject({ ok: false, reason: "working" });
    expect(archivedAgents).toEqual([]);
  });
});
