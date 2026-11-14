import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIdle } from "../shared/attention";
import type { ArchiveResult, UnsavedSession } from "../shared/archive";

// Archiving finished work's sessions, safely [ATT-22]. Paseo's SDK has no restore, so an archive has no Undo here; instead
// nothing with unsaved work leaves without a confirmation. A worktree goes only when nothing else lives in it. Which
// sessions to archive, and what that acknowledges, is the service's business; this only archives what it's given.

const run = promisify(execFile);

// A session as Paseo's snapshot describes it; null where Paseo couldn't say.
export interface ArchiveSession {
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  branch?: string;
  dirty: boolean | null;
  ahead: number | null;
}

type Paseo = PluginHandlerContext["paseo"];
type ListedAgent = Awaited<ReturnType<Paseo["agents"]["list"]>>["entries"][number]["agent"];
type ListedWorkspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];

const base = (session: ArchiveSession): UnsavedSession => ({ agentId: session.agentId, title: session.title, ...(session.branch ? { branch: session.branch } : {}) });

// What Paseo's snapshot says archiving would lose: clean only when it says both that nothing is uncommitted and that nothing
// is ahead; either one unknown is unknown [ATT-22]. The fallback when there's no directory to ask git.
export function unsaved(session: ArchiveSession): UnsavedSession | null {
  if (session.dirty === false && session.ahead === 0) return null;
  if (session.dirty === null || session.ahead === null) return { ...base(session), unknown: true };
  return { ...base(session), ...(session.ahead ? { commits: session.ahead } : {}) };
}

// How many files are uncommitted and commits unpushed, from git itself, since Paseo's snapshot counts neither and can lag.
// Commits are those ahead of the upstream, or, with no upstream, those no remote has. Clean needs both answers: one git
// couldn't give makes the whole answer unknown, never zero [ATT-22].
export async function gitUnsaved(session: ArchiveSession, directory: string): Promise<UnsavedSession> {
  const git = (args: string[]) => run("git", ["-C", directory, ...args], { timeout: 5000 }).then(({ stdout }) => stdout);
  const count = (args: string[]) =>
    git(["rev-list", "--count", ...args]).then((stdout) => {
      const n = Number(stdout.trim());
      if (!Number.isInteger(n)) throw new Error("not a count");
      return n;
    });
  const files = await git(["status", "--porcelain"])
    .then((stdout) => stdout.split("\n").filter((line) => line.trim()).length)
    .catch(() => undefined);
  const commits = await count(["@{upstream}..HEAD"])
    .catch(() => count(["HEAD", "--not", "--remotes"]))
    .catch(() => undefined);
  const known = { ...(files ? { files } : {}), ...(commits ? { commits } : {}) };
  return files === undefined || commits === undefined ? { ...base(session), unknown: true, ...known } : { ...base(session), ...known };
}

// What archiving would lose in a session: git's answer where there's a directory to ask, else Paseo's. Null when clean.
async function unsavedWork(session: ArchiveSession, workspace: ListedWorkspace | undefined): Promise<UnsavedSession | null> {
  const directory = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
  if (!directory) return unsaved(session);
  const found = await gitUnsaved(session, directory);
  return found.unknown || found.files || found.commits ? found : null;
}

// Archives the given sessions, and the worktree behind each when nothing else lives in it [ATT-22]. A workspace shared with
// anything else stays, and a local checkout always does. `confirm` is the sheet that named unsaved work.
export async function archiveSessions(paseo: Paseo, agentIds: string[], confirm: boolean): Promise<ArchiveResult> {
  const [agentList, workspaceList] = await Promise.all([paseo.agents.list(), paseo.workspaces.list()]);
  const agents = new Map<string, ListedAgent>(agentList.entries.map(({ agent }) => [agent.id, agent]));
  const workspaces = new Map<string, ListedWorkspace>(workspaceList.entries.map((workspace) => [workspace.id, workspace]));
  const wanted = [...new Set(agentIds)];
  const sessions: ArchiveSession[] = wanted.flatMap((id) => {
    const agent = agents.get(id);
    if (!agent) return [];
    const git = agent.workspaceId ? workspaces.get(agent.workspaceId)?.gitRuntime : undefined;
    return [
      {
        agentId: id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.title ?? null,
        ...(git?.currentBranch ? { branch: git.currentBranch } : {}),
        dirty: git?.isDirty ?? null,
        ahead: git?.aheadOfOrigin ?? null,
      },
    ];
  });
  const working = (entries: typeof agentList.entries) =>
    sessions.find((session) => {
      const agent = entries.find((entry) => entry.agent.id === session.agentId)?.agent;
      return agent && !agent.archivedAt && !isIdle(agent);
    });
  const busy = working(agentList.entries);
  if (busy) return { ok: false, reason: "working", message: `${busy.title ?? "A session"} is still working` };
  if (!confirm) {
    const dirty: UnsavedSession[] = [];
    for (const session of sessions) {
      const found = await unsavedWork(session, session.workspaceId ? workspaces.get(session.workspaceId) : undefined);
      if (found) dirty.push(found);
    }
    if (dirty.length) return { ok: false, reason: "unsaved", sessions: dirty };
  }

  // The checks above can take a while: look again right before archiving, so a session that started working, or a session
  // that moved into one of these worktrees meanwhile, is seen [ATT-22].
  const latest = await paseo.agents.list();
  const resumed = working(latest.entries);
  if (resumed) return { ok: false, reason: "working", message: `${resumed.title ?? "A session"} is working again` };

  // Archive the sessions; an already archived one counts as done.
  for (const session of sessions) {
    if (agents.get(session.agentId)?.archivedAt) continue;
    await paseo.agents.ref(session.agentId).archive();
  }
  // A worktree goes only when it's Paseo's, every unarchived agent in it was one of these sessions, and it has no terminal of
  // its own. If the terminals can't be read, it stays: better a leftover worktree than somebody's shell.
  const warnings: string[] = [];
  for (const workspaceId of new Set(sessions.flatMap((session) => (session.workspaceId ? [session.workspaceId] : [])))) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.workspaceKind !== "worktree") continue;
    if (latest.entries.some(({ agent }) => agent.workspaceId === workspaceId && !agent.archivedAt && !wanted.includes(agent.id))) continue;
    const terminals = await paseo.terminals.list({ workspaceId }).catch(() => null);
    if (!terminals || terminals.entries.length > 0) continue;
    // The sessions are put away either way; a worktree that wouldn't go is said, not swallowed.
    const failed = await paseo.workspaces
      .archive(workspaceId)
      .then((result) => (result.error ? String(result.error) : null))
      .catch((error: Error) => error.message);
    if (failed) warnings.push(`${workspace.gitRuntime?.currentBranch ?? "its worktree"}: ${failed}`);
  }
  return warnings.length ? { ok: true, warning: `Archived, but couldn't remove ${warnings.join("; ")}` } : { ok: true };
}
