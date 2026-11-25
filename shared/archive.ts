import { z } from "zod";
import type { AttentionView, Item, WrapItem } from "./attention";

// Archiving a Wrap up row's sessions [ATT-22]. The screen names the row; the server checks, archives and acknowledges. The
// confirm sheet is shaped like Paseo's own "Archive workspace" one, so the two read alike.

// A session with work archiving could lose, as the confirm sheet names it. `unknown` when git and Paseo couldn't both say;
// the sheet says so instead.
export interface UnsavedSession {
  agentId: string;
  title: string | null;
  branch?: string;
  // Uncommitted files, counted where git or a preview could count them; else just that there are some.
  files?: number;
  uncommitted?: true;
  // Lines added and deleted in tracked files, as Paseo's sheet counts them; untracked files count as files only.
  added?: number;
  deleted?: number;
  commits?: number;
  unknown?: true;
  // The terminals of a worktree archiving removes, by name: Paseo closes them with it.
  terminals?: string[];
}

// Paseo's own reading of a session's worktree, for when git can't be asked: null or missing where it couldn't tell. Previews
// add the counts and terminals Paseo can't give them.
export interface WorktreeReading {
  dirty?: boolean | null;
  ahead?: number | null;
  branch?: string;
  files?: number;
  lines?: { added: number; deleted: number };
  terminals?: string[];
}

// What archiving a session would lose, from Paseo's reading: null when it says both that nothing is uncommitted and that
// nothing is ahead. Clean needs both answers; either one missing makes it unknown [ATT-22]. A preview's terminals come along.
export function unsavedOf(session: Pick<UnsavedSession, "agentId" | "title">, reading: WorktreeReading | undefined): UnsavedSession | null {
  const dirty = reading?.dirty ?? null;
  const ahead = reading?.ahead ?? null;
  const terminals = reading?.terminals ?? [];
  if (dirty === false && ahead === 0) return null;
  return {
    agentId: session.agentId,
    title: session.title,
    ...(reading?.branch ? { branch: reading.branch } : {}),
    ...(reading?.files ? { files: reading.files } : dirty ? { uncommitted: true as const } : {}),
    ...(dirty && reading?.lines ? { added: reading.lines.added, deleted: reading.lines.deleted } : {}),
    ...(ahead ? { commits: ahead } : {}),
    ...(dirty === null || ahead === null ? { unknown: true as const } : {}),
    ...(terminals.length ? { terminals } : {}),
  };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

// "2 uncommitted files and 1 unpushed commit on split-invoice-pdf": what's known to be unsaved, in one line, as the multi
// sheet's session list says it.
export function unsavedWords(unsaved: UnsavedSession): string {
  const parts = [
    ...(unsaved.files ? [count(unsaved.files, "uncommitted file")] : unsaved.uncommitted ? ["uncommitted changes"] : []),
    ...(unsaved.commits ? [count(unsaved.commits, "unpushed commit")] : []),
  ];
  const what = parts.join(" and ") || "unsaved changes";
  return unsaved.branch ? `${what} on ${unsaved.branch}` : what;
}

// A session's lines on the confirm sheet, in Paseo's words: "Uncommitted changes: 2 files (+12 −3)", "1 unpushed commit",
// then the terminals archiving closes [ATT-22].
export function sheetLines(unsaved: UnsavedSession): string[] {
  const { files, added, deleted, commits, terminals = [] } = unsaved;
  const lines = added || deleted ? ` (+${added ?? 0} −${deleted ?? 0})` : "";
  return [
    ...(unsaved.unknown ? ["Couldn't check for unsaved changes"] : []),
    ...(files ? [`Uncommitted changes: ${count(files, "file")}${lines}`] : unsaved.uncommitted ? [`Uncommitted changes${lines}`] : []),
    ...(commits ? [count(commits, "unpushed commit")] : []),
    ...(terminals.length ? [`Closes ${terminals.length === 1 ? "terminal" : "terminals"}: ${terminals.join(", ")}`] : []),
  ];
}

// What an archive request names: the row's item, its sessions, and the keys whose changes success acknowledges. The item's
// place and title, so a row that lingers with its worktree can still say what it was.
export const ArchiveTarget = z.object({
  itemKey: z.string(),
  agentIds: z.array(z.string()),
  keys: z.array(z.string()),
  title: z.string(),
  repo: z.string(),
  number: z.number(),
  kind: z.enum(["pr", "issue"]),
});
export type ArchiveTarget = z.infer<typeof ArchiveTarget>;

export const archiveTarget = (item: WrapItem): ArchiveTarget => ({
  itemKey: item.wrap.itemKey,
  agentIds: item.wrap.sessions.map((session) => session.id),
  keys: item.wrap.keys,
  title: item.title,
  repo: item.repo,
  number: item.number,
  kind: item.kind,
});

// Why a worktree stayed after its sessions were archived [ATT-22]: another item's session still lives in it, a terminal
// opened while archiving, or Paseo wouldn't remove it.
export type KeptReason = "session" | "terminal" | "refused";

export interface KeptWorktree {
  workspaceId: string;
  // As Paseo's sidebar names it: the workspace's title, else its branch.
  name: string;
  reason: KeptReason;
  // The session's title, the terminals' names, or Paseo's error.
  detail: string;
  // The session that kept it, for Open session.
  agentId?: string;
  // The row's sessions that lived in it, so the server knows which row it was.
  sessionIds: string[];
}

// A kept worktree as Wrap up shows it, with the row it came from; in state.json until the worktree goes or it's dismissed.
export type KeptRow = Omit<KeptWorktree, "sessionIds"> & Pick<Item, "repo" | "number" | "title" | "kind"> & { itemKey: string; at: string };

// Why it stayed, short: the archive mark and the row's button say the rest. "Fix flaky test still in it" [ATT-22].
export function keptText(kept: Pick<KeptWorktree, "reason" | "detail">): string {
  if (kept.reason === "session") return `${kept.detail} still in it`;
  if (kept.reason === "terminal") return `${kept.detail} opened meanwhile`;
  return `Paseo: ${kept.detail}`;
}

// What archiving answers. A refusal keeps the row and says why, or names the unsaved work and open terminals to confirm,
// with the terminals' ids for the confirm to send back and the worktrees that would go, by name, for the sheet's title.
// Success says which worktrees stayed, and why, and which agents and workspaces it archived, for the screen to write as
// gone [FRESH-04].
export type ArchiveResult =
  | { ok: true; kept: KeptWorktree[]; archivedAgents: string[]; archivedWorkspaces: string[] }
  | { ok: false; reason: "working"; message: string }
  | { ok: false; reason: "unsaved"; sessions: UnsavedSession[]; terminals: string[]; leaving: string[] };

// The answer the screen gets: the result, with the list after it.
export type ArchiveOutcome = ArchiveResult & { view: AttentionView };
