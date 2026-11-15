import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { archiveSessions, type ArchiveSession, gitUnsaved } from "./archive";

type Paseo = PluginHandlerContext["paseo"];

function session(fields: Partial<ArchiveSession> = {}): ArchiveSession {
  return { agentId: "a1", workspaceId: "w1", title: "Fix CI", dirty: false, ahead: 0, ...fields };
}

interface FakeWorkspace {
  id: string;
  workspaceKind: string;
  workspaceDirectory?: string;
  gitRuntime?: { isDirty: boolean | null; aheadOfOrigin: number | null; currentBranch: string };
}

// Paseo's agents, workspaces and terminals, as far as archiving uses them, recording what it archived.
// Terminals are "id" in w1, or "id@w2" in another workspace.
function paseoFor(agents: { id: string; workspaceId?: string; status?: string; title?: string }[], workspaces: FakeWorkspace[], terminals: string[] = []) {
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
    terminals: {
      list: async ({ workspaceId }: { workspaceId: string }) => ({
        entries: terminals
          .map((spec) => ({ id: spec.split("@")[0], workspaceId: spec.split("@")[1] ?? "w1" }))
          .filter((terminal) => terminal.workspaceId === workspaceId)
          .map(({ id }) => ({ id, workspaceId, cwd: "/tmp", name: `${id} shell` })),
        requestId: "r",
      }),
    },
  };
  // Opens a terminal, as if from Paseo, between calls.
  const open = (id: string) => terminals.push(id);
  return { paseo: api as unknown as Paseo, archivedAgents, archivedWorkspaces, open };
}

// Throwaway git repos: a bare "origin" and a clone tracking it, so ahead and uncommitted are real git answers.
const root = mkdtempSync(join(tmpdir(), "attention-span-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();
let repos = 0;
function clone(): string {
  const name = `r${repos++}`;
  const origin = join(root, `${name}.git`);
  const work = join(root, name);
  git(root, "init", "--bare", origin);
  git(root, "clone", origin, work);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "first");
  git(work, "push", "-u", "origin", "HEAD");
  return work;
}
const commit = (work: string, file: string) => (writeFileSync(join(work, file), file), git(work, "add", "."), git(work, "commit", "-m", file));

describe("what git says archiving would lose", () => {
  it("ATT-22: a clean clone is clean", async () => {
    expect(await gitUnsaved(session(), clone())).toEqual({ agentId: "a1", title: "Fix CI" });
  });

  it("ATT-22: uncommitted files and unpushed commits are counted", async () => {
    const work = clone();
    commit(work, "d.txt");
    writeFileSync(join(work, "b.txt"), "b\n");
    writeFileSync(join(work, "a.txt"), "changed\n");
    expect(await gitUnsaved(session(), work)).toMatchObject({ files: 2, commits: 1 });
    expect(await gitUnsaved(session(), work)).not.toHaveProperty("unknown");
  });

  it("ATT-22: with no upstream, commits no remote has are counted, and none is clean", async () => {
    const work = clone();
    git(work, "switch", "-c", "local-only");
    expect(await gitUnsaved(session(), work)).toEqual({ agentId: "a1", title: "Fix CI" });
    commit(work, "e.txt");
    expect(await gitUnsaved(session(), work)).toMatchObject({ commits: 1 });
  });

  it("ATT-22: a directory git can't read is unknown, never clean", async () => {
    expect(await gitUnsaved(session(), join(root, "missing"))).toMatchObject({ unknown: true });
  });
});

describe("archive safety", () => {
  it("ATT-22: a clean single session archives its agent and its own worktree", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: clone() }]);
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: git beats a snapshot that says clean: unsaved work asks first, and archives only once confirmed", async () => {
    const work = clone();
    writeFileSync(join(work, "late.txt"), "edited after Paseo looked\n");
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: work }]);
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ ok: false, reason: "unsaved", sessions: [{ agentId: "a1", files: 1 }] });
    expect(archivedAgents).toEqual([]);
    expect(await archiveSessions(paseo, ["a1"], true)).toEqual({ ok: true });
    expect(archivedAgents).toEqual(["a1"]);
  });

  it("ATT-22: without a directory, Paseo's snapshot decides, and an unknown ahead count asks first", async () => {
    const unknownAhead = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", gitRuntime: { isDirty: false, aheadOfOrigin: null, currentBranch: "b" } }]);
    expect(await archiveSessions(unknownAhead.paseo, ["a1"], false)).toMatchObject({ ok: false, reason: "unsaved", sessions: [{ unknown: true }] });
    expect(unknownAhead.archivedAgents).toEqual([]);
  });

  it("ATT-22: a local checkout's workspace is never archived", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "local_checkout" }]);
    await archiveSessions(paseo, ["a1"], false);
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: a worktree another session lives in stays, and says which session kept it", async () => {
    const shared = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w1", title: "Fix flaky test" },
      ],
      [{ id: "w1", workspaceKind: "worktree" }],
    );
    expect(await archiveSessions(shared.paseo, ["a1"], false)).toEqual({ ok: true, note: "Archived; kept b: Fix flaky test is still in it" });
    expect(shared.archivedAgents).toEqual(["a1"]);
    expect(shared.archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: open terminals are named first, and close with the worktree once confirmed", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: clone() }], ["t1", "t2"]);
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({
      ok: false,
      reason: "unsaved",
      sessions: [{ agentId: "a1", title: "Session", branch: "b", terminals: ["t1 shell", "t2 shell"] }],
      terminals: ["t1", "t2"],
    });
    expect(archivedAgents).toEqual([]);
    expect(await archiveSessions(paseo, ["a1"], true, ["t1", "t2"])).toEqual({ ok: true });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: unsaved work and open terminals share one sheet", async () => {
    const work = clone();
    writeFileSync(join(work, "late.txt"), "late\n");
    const { paseo } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: work }], ["t1"]);
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ reason: "unsaved", sessions: [{ agentId: "a1", files: 1, terminals: ["t1 shell"] }], terminals: ["t1"] });
  });

  it("ATT-22: a terminal opened after the sheet asks again, still naming the unsaved work", async () => {
    const work = clone();
    writeFileSync(join(work, "late.txt"), "late\n");
    const { paseo, archivedAgents, open } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: work }], ["t1"]);
    await archiveSessions(paseo, ["a1"], false);
    open("t2");
    expect(await archiveSessions(paseo, ["a1"], true, ["t1"])).toMatchObject({
      reason: "unsaved",
      sessions: [{ files: 1, terminals: ["t1 shell", "t2 shell"] }],
      terminals: ["t1", "t2"],
    });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a terminal opened while the sessions were archived keeps its worktree, and says so", async () => {
    const { paseo, archivedAgents, archivedWorkspaces, open } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: clone() }], ["t1"]);
    const ref = paseo.agents.ref;
    paseo.agents.ref = ((id: string) => (open("t2"), ref(id))) as typeof ref;
    expect(await archiveSessions(paseo, ["a1"], true, ["t1"])).toEqual({ ok: true, note: "Archived; kept b: t2 shell opened meanwhile" });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: only a worktree's own terminals are named, and a kept worktree is said beside one that wouldn't go", async () => {
    const { paseo } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w2" },
        { id: "a3", workspaceId: "w2", title: "Fix flaky test" },
      ],
      [
        { id: "w1", workspaceKind: "worktree" },
        { id: "w2", workspaceKind: "worktree" },
      ],
      ["t1@w2"],
    );
    expect(await archiveSessions(paseo, ["a1", "a2"], false)).toMatchObject({ ok: true });
    paseo.workspaces.archive = (async () => {
      throw new Error("busy");
    }) as typeof paseo.workspaces.archive;
    expect(await archiveSessions(paseo, ["a1", "a2"], false)).toEqual({
      ok: true,
      warning: "Archived, but couldn't remove b: busy",
      note: "Archived; kept b: Fix flaky test is still in it",
    });
  });

  it("ATT-22: terminals that can't be listed don't keep the worktree", async () => {
    const { paseo, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: clone() }]);
    paseo.terminals.list = (async () => {
      throw new Error("no terminals");
    }) as typeof paseo.terminals.list;
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true });
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: a worktree that stays names no terminals", async () => {
    const { paseo } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w1" },
      ],
      [{ id: "w1", workspaceKind: "worktree", workspaceDirectory: clone() }],
      ["t1"],
    );
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ ok: true, note: expect.any(String) });
  });

  it("ATT-22: a session that is working never archives", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1", status: "running" }], [{ id: "w1", workspaceKind: "worktree" }]);
    expect(await archiveSessions(paseo, ["a1"], true)).toMatchObject({ ok: false, reason: "working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a session that started working during the checks isn't archived", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }]);
    const list = paseo.agents.list;
    let calls = 0;
    paseo.agents.list = (async (...args: Parameters<typeof list>) => {
      const result = await list(...args);
      calls += 1;
      return calls > 1 ? { ...result, entries: result.entries.map(({ agent }) => ({ agent: { ...agent, status: "running" } })) } : result;
    }) as typeof list;
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ ok: false, reason: "working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a worktree that won't go is said, after the sessions are put away", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "worktree" }]);
    paseo.workspaces.archive = (async () => {
      throw new Error("busy");
    }) as typeof paseo.workspaces.archive;
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, warning: "Archived, but couldn't remove b: busy" });
    expect(archivedAgents).toEqual(["a1"]);
  });
});
