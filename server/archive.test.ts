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
  title?: string;
  gitRuntime?: { isDirty: boolean | null; aheadOfOrigin: number | null; currentBranch: string };
}

// Paseo's agents, workspaces and terminals, as far as archiving uses them, recording what it archived.
// Terminals are "id" in w1, or "id@w2" in another workspace.
// An agent's `parent` is the session that started it, as Paseo labels it. Lists come `pageSize` agents a page, archived ones
// only when asked for, and an agent archived here is listed as archived from then on.
type FakeAgent = { id: string; workspaceId?: string; status?: string; title?: string; parent?: string; archivedAt?: string; requiresAttention?: boolean };
function paseoFor(agents: FakeAgent[], workspaces: FakeWorkspace[], terminals: string[] = [], pageSize = 100) {
  const archivedAgents: string[] = [];
  const archivedWorkspaces: string[] = [];
  const api = {
    agents: {
      list: async (options?: { filter?: { includeArchived?: boolean }; page?: { cursor?: string } }) => {
        const listed = agents.filter((agent) => options?.filter?.includeArchived || !agent.archivedAt);
        const start = Number(options?.page?.cursor ?? 0);
        const more = start + pageSize < listed.length;
        return {
          entries: listed.slice(start, start + pageSize).map(({ parent, ...agent }) => ({
            agent: { status: "idle", requiresAttention: false, title: "Session", archivedAt: null, ...agent, labels: parent ? { "paseo.parent-agent-id": parent } : {} },
          })),
          pageInfo: { hasMore: more, nextCursor: more ? String(start + pageSize) : null },
        };
      },
      ref: (id: string) => ({
        archive: async () => {
          archivedAgents.push(id);
          const agent = agents.find((other) => other.id === id);
          if (agent) agent.archivedAt = "now";
          return { archivedAt: "now" };
        },
      }),
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
  const worktree = (fields: Partial<FakeWorkspace> = {}): FakeWorkspace => ({ id: "w1", workspaceKind: "worktree", ...fields });

  it("ATT-22: a clean single session archives its agent and its own worktree", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: clone() })]);
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, kept: [] });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: git beats a snapshot that says clean: unsaved work asks first, counting lines, and archives only once confirmed", async () => {
    const work = clone();
    writeFileSync(join(work, "a.txt"), "changed\nand more\n");
    writeFileSync(join(work, "late.txt"), "edited after Paseo looked\n");
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: work, title: "Split invoice PDF" })]);
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({
      ok: false,
      reason: "unsaved",
      sessions: [{ agentId: "a1", files: 2, added: 2, deleted: 1 }],
      leaving: ["Split invoice PDF"],
    });
    expect(archivedAgents).toEqual([]);
    expect(await archiveSessions(paseo, ["a1"], true)).toEqual({ ok: true, kept: [] });
    expect(archivedAgents).toEqual(["a1"]);
  });

  it("ATT-22: without a directory, Paseo's snapshot decides, and an unknown ahead count asks first", async () => {
    const unknownAhead = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ gitRuntime: { isDirty: false, aheadOfOrigin: null, currentBranch: "b" } })]);
    expect(await archiveSessions(unknownAhead.paseo, ["a1"], false)).toMatchObject({ ok: false, reason: "unsaved", sessions: [{ unknown: true }] });
    expect(unknownAhead.archivedAgents).toEqual([]);
  });

  it("ATT-22: a local checkout's workspace is never archived", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [{ id: "w1", workspaceKind: "local_checkout" }]);
    await archiveSessions(paseo, ["a1"], false);
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: a worktree another session lives in stays, naming the workspace and the session that kept it", async () => {
    const shared = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w1", title: "Fix flaky test" },
      ],
      [worktree({ title: "Round prices" })],
    );
    expect(await archiveSessions(shared.paseo, ["a1"], false)).toEqual({
      ok: true,
      kept: [{ workspaceId: "w1", name: "Round prices", reason: "session", detail: "Fix flaky test", agentId: "a2", sessionIds: ["a1"] }],
    });
    expect(shared.archivedAgents).toEqual(["a1"]);
    expect(shared.archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: a session's sub-agents, and theirs, go with it and don't keep its worktree", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "review", workspaceId: "w1", parent: "a1" },
        { id: "nested", workspaceId: "w1", parent: "review" },
        { id: "elsewhere", workspaceId: "w2", parent: "a1" },
      ],
      [worktree({ workspaceDirectory: clone() }), { id: "w2", workspaceKind: "worktree" }],
    );
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, kept: [] });
    expect(archivedAgents.sort()).toEqual(["a1", "elsewhere", "nested", "review"]);
    // A sub-agent in another workspace is archived, and that workspace stays.
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: every page of agents counts: another session on a later page keeps the worktree", async () => {
    const { paseo, archivedWorkspaces } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "x", workspaceId: "w9" },
        { id: "a2", workspaceId: "w1", title: "Fix flaky test" },
      ],
      [worktree()],
      [],
      1,
    );
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ ok: true, kept: [{ reason: "session", agentId: "a2" }] });
    expect(archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: an open sub-agent under an archived one is still found, and still working stops the archive", async () => {
    const { paseo, archivedAgents } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "review", workspaceId: "w1", parent: "a1", archivedAt: "earlier" },
        { id: "check", workspaceId: "w1", parent: "review", status: "running", title: "Run checks" },
      ],
      [worktree()],
    );
    expect(await archiveSessions(paseo, ["a1"], true)).toEqual({ ok: false, reason: "working", message: "Run checks is still working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a sub-agent that won't archive and stays open stops the archive before its session goes", async () => {
    const { paseo, archivedAgents } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "review", workspaceId: "w2", parent: "a1", title: "Review PR 46" },
      ],
      [worktree({ workspaceDirectory: clone() })],
    );
    const ref = paseo.agents.ref;
    paseo.agents.ref = ((id: string) =>
      id === "review"
        ? {
            archive: async () => {
              throw new Error("busy");
            },
          }
        : ref(id)) as typeof ref;
    await expect(archiveSessions(paseo, ["a1"], false)).rejects.toThrow("Couldn't archive Review PR 46: busy");
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a finished sub-agent still flagged for attention doesn't stop the archive", async () => {
    const { paseo, archivedAgents } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "review", workspaceId: "w1", parent: "a1", requiresAttention: true },
      ],
      [worktree({ workspaceDirectory: clone() })],
    );
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, kept: [] });
    expect(archivedAgents.sort()).toEqual(["a1", "review"]);
  });

  it("ATT-22: a sub-agent still working stops the archive, naming it", async () => {
    const { paseo, archivedAgents } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "review", workspaceId: "w1", parent: "a1", status: "running", title: "Review PR 46" },
      ],
      [worktree()],
    );
    expect(await archiveSessions(paseo, ["a1"], true)).toEqual({ ok: false, reason: "working", message: "Review PR 46 is still working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: open terminals are named first, and close with the worktree once confirmed", async () => {
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: clone() })], ["t1", "t2"]);
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({
      ok: false,
      reason: "unsaved",
      sessions: [{ agentId: "a1", title: "Session", branch: "b", terminals: ["t1 shell", "t2 shell"] }],
      terminals: ["t1", "t2"],
      leaving: ["b"],
    });
    expect(archivedAgents).toEqual([]);
    expect(await archiveSessions(paseo, ["a1"], true, ["t1", "t2"])).toEqual({ ok: true, kept: [] });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: unsaved work and open terminals share one sheet", async () => {
    const work = clone();
    writeFileSync(join(work, "late.txt"), "late\n");
    const { paseo } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: work })], ["t1"]);
    expect(await archiveSessions(paseo, ["a1"], false)).toMatchObject({ reason: "unsaved", sessions: [{ agentId: "a1", files: 1, terminals: ["t1 shell"] }], terminals: ["t1"] });
  });

  it("ATT-22: a terminal opened after the sheet asks again, still naming the unsaved work", async () => {
    const work = clone();
    writeFileSync(join(work, "late.txt"), "late\n");
    const { paseo, archivedAgents, open } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: work })], ["t1"]);
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
    const { paseo, archivedAgents, archivedWorkspaces, open } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: clone() })], ["t1"]);
    const ref = paseo.agents.ref;
    paseo.agents.ref = ((id: string) => (open("t2"), ref(id))) as typeof ref;
    expect(await archiveSessions(paseo, ["a1"], true, ["t1"])).toEqual({
      ok: true,
      kept: [{ workspaceId: "w1", name: "b", reason: "terminal", detail: "t2 shell", sessionIds: ["a1"] }],
    });
    expect(archivedAgents).toEqual(["a1"]);
    expect(archivedWorkspaces).toEqual([]);
  });

  it("ATT-22: terminals that can't be listed don't keep the worktree", async () => {
    const { paseo, archivedWorkspaces } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree({ workspaceDirectory: clone() })]);
    paseo.terminals.list = (async () => {
      throw new Error("no terminals");
    }) as typeof paseo.terminals.list;
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, kept: [] });
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: only a worktree's own terminals are named, and one that stays names none", async () => {
    const { paseo } = paseoFor(
      [
        { id: "a1", workspaceId: "w1" },
        { id: "a2", workspaceId: "w2" },
        { id: "a3", workspaceId: "w2", title: "Fix flaky test" },
      ],
      [worktree(), { id: "w2", workspaceKind: "worktree" }],
      ["t1@w2"],
    );
    expect(await archiveSessions(paseo, ["a1", "a2"], false)).toMatchObject({ ok: true, kept: [{ workspaceId: "w2", reason: "session" }] });
  });

  it("ATT-22: a worktree Paseo won't remove stays, with Paseo's reason, after the sessions are put away", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree()]);
    paseo.workspaces.archive = (async () => {
      throw new Error("busy");
    }) as typeof paseo.workspaces.archive;
    expect(await archiveSessions(paseo, ["a1"], false)).toEqual({ ok: true, kept: [{ workspaceId: "w1", name: "b", reason: "refused", detail: "busy", sessionIds: ["a1"] }] });
    expect(archivedAgents).toEqual(["a1"]);
  });

  it("ATT-22: a kept worktree tried again on its own goes through the same checks", async () => {
    const work = clone();
    const { paseo, archivedAgents, archivedWorkspaces } = paseoFor([], [worktree({ workspaceDirectory: work, title: "Cache tax tables" })], ["t1"]);
    expect(await archiveSessions(paseo, [], false, [], ["w1"])).toMatchObject({ ok: false, reason: "unsaved", sessions: [{ title: "Cache tax tables", terminals: ["t1 shell"] }] });
    expect(await archiveSessions(paseo, [], true, ["t1"], ["w1"])).toEqual({ ok: true, kept: [] });
    expect(archivedAgents).toEqual([]);
    expect(archivedWorkspaces).toEqual(["w1"]);
  });

  it("ATT-22: a session that is working never archives", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1", status: "running" }], [worktree()]);
    expect(await archiveSessions(paseo, ["a1"], true)).toMatchObject({ ok: false, reason: "working" });
    expect(archivedAgents).toEqual([]);
  });

  it("ATT-22: a session that started working during the checks isn't archived", async () => {
    const { paseo, archivedAgents } = paseoFor([{ id: "a1", workspaceId: "w1" }], [worktree()]);
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
});
