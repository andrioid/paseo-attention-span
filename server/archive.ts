import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Archiving finished work's sessions, safely [ATT-22]. Paseo's SDK has no restore, so an archive has no Undo here; instead
// nothing with unsaved work leaves without a confirmation. A worktree goes only when nothing else lives in it.

const run = promisify(execFile);

export interface ArchiveSession {
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  branch?: string;
  // null when Paseo couldn't say; the caller treats that as dirty too.
  dirty: boolean | null;
  ahead: number | null;
  // A worktree Paseo made, which may be archived; a local checkout never is.
  ownedWorktree: boolean;
}

export interface UnsavedSession {
  agentId: string;
  title: string | null;
  branch?: string;
  files?: number;
  commits?: number;
  // Paseo and git both couldn't say.
  unknown?: true;
}

// What an archive request from the screen names: the item, the keys whose events it acknowledges, and its sessions.
export interface ArchiveTarget {
  itemKey: string;
  agentIds: string[];
  // The item and its children, so a change on any part of a group is acknowledged.
  keys: string[];
}

export type ArchiveAnswer =
  // `warning`: the sessions were archived, but a worktree that should have gone stayed, and why.
  | { ok: true; warning?: string }
  | { ok: false; reason: "working"; message: string }
  | { ok: false; reason: "unsaved"; sessions: UnsavedSession[] };

type Paseo = PluginHandlerContext["paseo"];

const isIdle = (status: string, requiresAttention: boolean | undefined) =>
  !requiresAttention && status !== "running" && status !== "initializing";

// What archiving would lose, with the counts git can give; Paseo's own answer is the fallback [ATT-22].
// Clean only when Paseo says both: nothing uncommitted and nothing ahead. Either one unknown is unknown [ATT-22].
export async function unsaved(session: ArchiveSession): Promise<UnsavedSession | null> {
  if (session.dirty === false && session.ahead === 0) return null;
  const base: UnsavedSession = {
    agentId: session.agentId,
    title: session.title,
    ...(session.branch ? { branch: session.branch } : {}),
  };
  if (session.dirty === null || session.ahead === null) return { ...base, unknown: true };
  return { ...base, ...(session.ahead ? { commits: session.ahead } : {}) };
}

// How many files are uncommitted and commits unpushed, from git itself, since Paseo's workspace snapshot counts neither.
// A worktree whose upstream is gone keeps the commits Paseo knows about.
export async function gitUnsaved(session: ArchiveSession, directory: string | undefined): Promise<UnsavedSession> {
  const base: UnsavedSession = { agentId: session.agentId, title: session.title, ...(session.branch ? { branch: session.branch } : {}) };
  let files: number | undefined;
  let commits: number | undefined;
  if (directory) {
    files = await run("git", ["-C", directory, "status", "--porcelain"], { timeout: 5000 })
      .then(({ stdout }) => stdout.split("\n").filter((line) => line.trim()).length)
      .catch(() => undefined);
    const count = (args: string[]) =>
      run("git", ["-C", directory, "rev-list", "--count", ...args], { timeout: 5000 }).then(({ stdout }) => {
        const n = Number(stdout.trim());
        if (!Number.isInteger(n)) throw new Error("not a count");
        return n;
      });
    // Ahead of its upstream; with none, the commits no remote has.
    commits = await count(["@{upstream}..HEAD"])
      .catch(() => count(["HEAD", "--not", "--remotes"]))
      .catch(() => undefined);
  }
  // Clean needs both answers; one that git couldn't give makes the whole answer unknown, never zero [ATT-22].
  if (files === undefined || commits === undefined) return { ...base, unknown: true, ...(files ? { files } : {}), ...(commits ? { commits } : {}) };
  return { ...base, ...(files ? { files } : {}), ...(commits ? { commits } : {}) };
}

interface ListedAgent {
  id: string;
  status: string;
  requiresAttention?: boolean;
  archivedAt?: string | null;
  title?: string | null;
  workspaceId?: string | null;
}

interface ListedWorkspace {
  id: string;
  workspaceKind: string;
  workspaceDirectory?: string;
  projectRootPath?: string;
  gitRuntime?: {
    currentBranch?: string | null;
    isDirty?: boolean | null;
    aheadOfOrigin?: number | null;
    isPaseoOwnedWorktree?: boolean | null;
  } | null;
}

// Archives every target's sessions, and the worktree behind each when nothing else lives in it [ATT-22]. Only this item's
// agents are archived; a workspace shared with anything else stays. `confirm` is the sheet that named unsaved work.
export async function archiveSessions(paseo: Paseo, targets: ArchiveTarget[], confirm: boolean): Promise<ArchiveAnswer> {
  const [agentList, workspaceList] = await Promise.all([paseo.agents.list(), paseo.workspaces.list()]);
  const listedIdle = (entries: typeof agentList.entries) => (id: string) => {
    const agent = entries.find(({ agent: listed }) => listed.id === id)?.agent as ListedAgent | undefined;
    return !agent || !!agent.archivedAt || isIdle(agent.status, agent.requiresAttention);
  };
  const agents = new Map<string, ListedAgent>(agentList.entries.map(({ agent }) => [agent.id, agent as ListedAgent]));
  const workspaces = new Map<string, ListedWorkspace>(workspaceList.entries.map((workspace) => [workspace.id, workspace as ListedWorkspace]));
  const wanted = [...new Set(targets.flatMap((target) => target.agentIds))];
  const sessions: ArchiveSession[] = wanted.flatMap((id) => {
    const agent = agents.get(id);
    if (!agent) return [];
    const workspace = agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined;
    const git = workspace?.gitRuntime;
    return [
      {
        agentId: id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.title ?? null,
        ...(git?.currentBranch ? { branch: git.currentBranch } : {}),
        dirty: git ? (git.isDirty ?? null) : null,
        ahead: git ? (git.aheadOfOrigin ?? null) : null,
        ownedWorktree: workspace?.workspaceKind === "worktree",
      },
    ];
  });
  const busy = sessions.find((session) => {
    const agent = agents.get(session.agentId);
    return agent && !agent.archivedAt && !isIdle(agent.status, agent.requiresAttention);
  });
  if (busy) return { ok: false, reason: "working", message: `${busy.title ?? "A session"} is still working` };
  if (!confirm) {
    const dirty: UnsavedSession[] = [];
    for (const session of sessions) {
      const info = await unsaved(session);
      const workspace = session.workspaceId ? workspaces.get(session.workspaceId) : undefined;
      const directory = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
      // Paseo's snapshot can lag behind a last-minute edit, so ask git too when there is a directory to ask.
      const detail = directory ? await gitUnsaved(session, directory) : null;
      const gitClean = !!detail && !detail.unknown && !detail.files && !detail.commits;
      // Clean when git says so, or, without a directory to ask, when Paseo says both are clean.
      if (detail ? gitClean : !info) continue;
      // Git is the better answer; when it can't say, Paseo's still counts as unsaved.
      const answer: UnsavedSession = !info ? (detail ?? { agentId: session.agentId, title: session.title, unknown: true }) : detail?.unknown ? { ...info, files: undefined } : (detail ?? info);
      dirty.push(answer);
    }
    if (dirty.length) return { ok: false, reason: "unsaved", sessions: dirty };
  }

  // The checks above can take a while: look again right before archiving, so a session that started working, or a session
  // that moved into one of these worktrees meanwhile, is seen [ATT-22].
  const latest = await paseo.agents.list();
  const nowIdle = listedIdle(latest.entries);
  const resumed = sessions.find((session) => !nowIdle(session.agentId));
  if (resumed) return { ok: false, reason: "working", message: `${resumed.title ?? "A session"} is working again` };

  // Archive this item's agents; an already archived one counts as done.
  for (const session of sessions) {
    const agent = agents.get(session.agentId);
    if (!agent || agent.archivedAt) continue;
    await paseo.agents.ref(session.agentId).archive();
  }
  // A worktree goes only when it's Paseo's, every unarchived agent in it was one of this item's sessions, and it has no
  // terminal of its own. If the terminals can't be read, it stays: better a leftover worktree than somebody's shell.
  const warnings: string[] = [];
  for (const workspaceId of new Set(sessions.map((session) => session.workspaceId).filter((id): id is string => !!id))) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.workspaceKind !== "worktree") continue;
    const left = latest.entries.filter(({ agent }) => agent.workspaceId === workspaceId && !agent.archivedAt && !wanted.includes(agent.id));
    if (left.length > 0) continue;
    const terminals = typeof paseo.terminals?.list === "function" ? await paseo.terminals.list({ workspaceId }).catch(() => null) : null;
    if (!terminals || terminals.entries.length > 0) continue;
    // The sessions are put away either way; a worktree that wouldn't go is said, not swallowed.
    const failed = await paseo.workspaces
      .archive(workspaceId)
      .then((result) => (result && "error" in result && result.error ? String(result.error) : null))
      .catch((error: Error) => error.message);
    if (failed) warnings.push(`${workspace.gitRuntime?.currentBranch ?? "its worktree"}: ${failed}`);
  }
  return warnings.length ? { ok: true, warning: `Archived, but couldn't remove ${warnings.join("; ")}` } : { ok: true };
}
