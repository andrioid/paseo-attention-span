import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { busyWords, isIdle, subAgentBusy } from "../shared/attention";
import { type ArchiveResult, type KeptWorktree, type UnsavedSession, unsavedOf } from "../shared/archive";
import { subAgentsOf } from "../shared/linked-sessions";
import { listAll } from "./archived";

// Archiving finished work's sessions, safely [ATT-22]. Paseo's SDK has no restore, so an archive has no Undo here; instead
// nothing with unsaved work or open terminals leaves without a confirmation. A session's sub-agents go with it. A worktree
// goes only when no other session lives in it, through Paseo's own workspace archive, which archives everything in it; so
// every check here runs first. Which sessions to archive, and what that acknowledges, is the service's business.

const run = promisify(execFile);

// A session as Paseo's snapshot describes it; null where Paseo couldn't say. A worktree tried again on its own stands in as
// a session of its own, with no agent to archive.
export interface ArchiveSession {
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  branch?: string;
  dirty: boolean | null;
  ahead: number | null;
  worktreeOnly?: true;
}

type Paseo = PluginHandlerContext["paseo"];
type ListedAgent = Awaited<ReturnType<Paseo["agents"]["list"]>>["entries"][number]["agent"];
type ListedWorkspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];

const base = (session: ArchiveSession): UnsavedSession => ({ agentId: session.agentId, title: session.title, ...(session.branch ? { branch: session.branch } : {}) });

// A workspace as Paseo's sidebar names it [ATT-22].
const nameOf = (workspace: ListedWorkspace | undefined): string => workspace?.title ?? workspace?.gitRuntime?.currentBranch ?? workspace?.name ?? "its worktree";

// How many files are uncommitted, with the lines added and deleted, and commits unpushed, from git itself, since Paseo's
// snapshot counts neither and can lag. Commits are those ahead of the upstream, or, with no upstream, those no remote has.
// Clean needs both answers: one git couldn't give makes the whole answer unknown, never zero [ATT-22].
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
  // "2 files changed, 12 insertions(+), 3 deletions(-)"; only a nicety, so a failure just leaves the lines out.
  const lines = files
    ? await git(["diff", "--shortstat", "HEAD"])
        .then((stdout) => ({ added: Number(/(\d+) insertion/.exec(stdout)?.[1] ?? 0), deleted: Number(/(\d+) deletion/.exec(stdout)?.[1] ?? 0) }))
        .catch(() => null)
    : null;
  const known = {
    ...(files ? { files } : {}),
    ...(lines && (lines.added || lines.deleted) ? lines : {}),
    ...(commits ? { commits } : {}),
  };
  return files === undefined || commits === undefined ? { ...base(session), unknown: true, ...known } : { ...base(session), ...known };
}

// What archiving would lose in a session: git's answer where there's a directory to ask, else Paseo's. Null when clean.
async function unsavedWork(session: ArchiveSession, workspace: ListedWorkspace | undefined): Promise<UnsavedSession | null> {
  const directory = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
  if (!directory) return unsavedOf(session, session);
  const found = await gitUnsaved(session, directory);
  return found.unknown || found.files || found.commits ? found : null;
}

// Archives the given sessions with their sub-agents, and the worktree behind each when no other session lives in it
// [ATT-22]. `worktrees` are kept worktrees tried again on their own. `confirm` is the sheet that named unsaved work and open
// terminals; `seen` are the terminals it named, the only ones archiving may close.
export async function archiveSessions(paseo: Paseo, agentIds: string[], confirm: boolean, seen: string[] = [], worktrees: string[] = []): Promise<ArchiveResult> {
  // Every agent, archived ones too, on every page: a sub-agent under an archived one, or a session on a later page, counts.
  const everyAgent = () => listAll(paseo, { filter: { includeArchived: true } });
  const [agentList, workspaceList] = await Promise.all([everyAgent(), paseo.workspaces.list()]);
  const agents = new Map(agentList.map((agent) => [agent.id, agent]));
  const workspaces = new Map<string, ListedWorkspace>(workspaceList.entries.map((workspace) => [workspace.id, workspace]));
  const wanted = [...new Set(agentIds)];
  const sessionOf = (workspace: ListedWorkspace, fields: Pick<ArchiveSession, "agentId" | "title"> & { worktreeOnly?: true }): ArchiveSession => {
    const git = workspace.gitRuntime;
    return {
      ...fields,
      workspaceId: workspace.id,
      ...(git?.currentBranch ? { branch: git.currentBranch } : {}),
      dirty: git?.isDirty ?? null,
      ahead: git?.aheadOfOrigin ?? null,
    };
  };
  const sessions: ArchiveSession[] = [
    ...wanted.flatMap((id) => {
      const agent = agents.get(id);
      if (!agent) return [];
      const workspace = agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined;
      const fields = { agentId: id, title: agent.title ?? null };
      return [workspace ? sessionOf(workspace, fields) : { ...fields, workspaceId: agent.workspaceId ?? null, dirty: null, ahead: null }];
    }),
    ...worktrees.flatMap((id) => {
      const workspace = workspaces.get(id);
      // One that's also a session's own is checked as that session's.
      const own = wanted.some((agentId) => agents.get(agentId)?.workspaceId === id);
      return workspace && !own ? [sessionOf(workspace, { agentId: `worktree:${id}`, title: nameOf(workspace), worktreeOnly: true })] : [];
    }),
  ];
  // A session, or one of its sub-agents, still busy stops the archive. A session that needs me counts as busy; a sub-agent
  // while it runs or needs me, not once it's finished or failed (subAgentBusy).
  const working = (all: ListedAgent[]) =>
    all.find((agent) => wanted.includes(agent.id) && !agent.archivedAt && !isIdle(agent)) ?? subAgentsOf(all, wanted).find((agent) => !agent.archivedAt && subAgentBusy(agent));
  const busy = working(agentList);
  if (busy) return { ok: false, reason: "working", message: busyWords(busy) };
  const unsaved = async () => {
    const dirty = new Map<string, UnsavedSession>();
    for (const session of sessions) {
      const found = await unsavedWork(session, session.workspaceId ? workspaces.get(session.workspaceId) : undefined);
      if (found) dirty.set(session.agentId, found);
    }
    return dirty;
  };
  const dirty = confirm ? new Map<string, UnsavedSession>() : await unsaved();

  // The checks above can take a while: look again right before archiving, so a session that started working, or a session
  // that moved into one of these worktrees meanwhile, is seen [ATT-22].
  const latest = await everyAgent();
  const resumed = working(latest);
  if (resumed) return { ok: false, reason: "working", message: busyWords(resumed, true) };
  const subAgents = subAgentsOf(latest, wanted);
  const ours = new Set([...wanted, ...subAgents.map((agent) => agent.id)]);

  // Which worktrees go: Paseo's, with no unarchived session in them but these and their sub-agents. One that holds another
  // session stays, saying which one kept it.
  // Paseo closes a worktree's terminals when it goes, so the sheet names them first. Terminals that can't be listed don't
  // keep it: Paseo would close them all the same.
  const terminalsOf = (workspaceId: string) =>
    paseo.terminals
      .list({ workspaceId })
      .then((result) => result.entries.map(({ id, name }) => ({ id, name })))
      .catch(() => []);
  const leaving: { workspace: ListedWorkspace; session: ArchiveSession; terminals: { id: string; name: string }[] }[] = [];
  const kept: KeptWorktree[] = [];
  const keep = (workspace: ListedWorkspace, fields: Omit<KeptWorktree, "workspaceId" | "name" | "sessionIds">) =>
    kept.push({ workspaceId: workspace.id, name: nameOf(workspace), ...fields, sessionIds: wanted.filter((id) => agents.get(id)?.workspaceId === workspace.id) });
  for (const workspaceId of new Set(sessions.flatMap((session) => (session.workspaceId ? [session.workspaceId] : [])))) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.workspaceKind !== "worktree") continue;
    const other = latest.find((agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !ours.has(agent.id));
    if (other) {
      keep(workspace, { reason: "session", detail: other.title ?? "another session", agentId: other.id });
      continue;
    }
    leaving.push({ workspace, session: sessions.find((session) => session.workspaceId === workspaceId)!, terminals: await terminalsOf(workspaceId) });
  }

  // Unsaved work, or a terminal the sheet didn't name, asks first; a terminal that opened after the sheet asks again, with
  // whatever else is unsaved by then [ATT-22].
  const unseen = leaving.some(({ terminals }) => terminals.some((terminal) => !seen.includes(terminal.id)));
  if (dirty.size || unseen) {
    const found = confirm ? await unsaved() : dirty;
    for (const { session, terminals } of leaving) {
      if (!terminals.length) continue;
      found.set(session.agentId, { ...(found.get(session.agentId) ?? base(session)), terminals: terminals.map(({ name }) => name) });
    }
    return {
      ok: false,
      reason: "unsaved",
      sessions: sessions.flatMap((session) => found.get(session.agentId) ?? []),
      terminals: leaving.flatMap(({ terminals }) => terminals.map(({ id }) => id)),
      leaving: leaving.map(({ workspace }) => nameOf(workspace)),
    };
  }

  // Archive the sub-agents, deepest first, then the sessions; an already archived one counts as done. A sub-agent that
  // wouldn't go and is still open stops the archive before its session goes, so nothing is acknowledged with it left open.
  const failed: { agent: ListedAgent; message: string }[] = [];
  for (const agent of [...subAgents].reverse()) {
    await paseo.agents
      .ref(agent.id)
      .archive()
      .catch((error: Error) => failed.push({ agent, message: error.message }));
  }
  if (failed.length) {
    const open = new Set((await everyAgent()).filter((agent) => !agent.archivedAt).map((agent) => agent.id));
    const stuck = failed.find(({ agent }) => open.has(agent.id));
    if (stuck) throw new Error(`Couldn't archive ${stuck.agent.title ?? "a sub-agent"}: ${stuck.message}`);
  }
  for (const session of sessions) {
    if (session.worktreeOnly || agents.get(session.agentId)?.archivedAt) continue;
    await paseo.agents.ref(session.agentId).archive();
  }
  // What's archived now, said back so the screen shows it gone at once [FRESH-04]: the sub-agents (one that failed and
  // stayed open stopped the archive above) and the sessions, archived here or before.
  const archivedAgents = [...subAgents.map((agent) => agent.id), ...sessions.flatMap((session) => (session.worktreeOnly ? [] : [session.agentId]))];
  const archivedWorkspaces: string[] = [];
  // The sessions are put away either way; a worktree that wouldn't go stays, saying why. Its terminals are listed once more
  // right before it goes: one that opened while the sessions were archived wasn't on the sheet, so the worktree stays.
  for (const { workspace } of leaving) {
    const late = (await terminalsOf(workspace.id)).filter((terminal) => !seen.includes(terminal.id));
    if (late.length) {
      keep(workspace, { reason: "terminal", detail: late.map(({ name }) => name).join(", ") });
      continue;
    }
    const failed = await paseo.workspaces
      .archive(workspace.id)
      .then((result) => (result.error ? String(result.error) : null))
      .catch((error: Error) => error.message);
    if (failed) keep(workspace, { reason: "refused", detail: failed });
    else archivedWorkspaces.push(workspace.id);
  }
  return { ok: true, kept, archivedAgents, archivedWorkspaces };
}

