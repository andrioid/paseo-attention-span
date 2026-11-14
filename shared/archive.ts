import type { AttentionView, WrapItem } from "./attention";

// Archiving a Wrap up row's sessions [ATT-22]. The screen names the row; the server checks, archives and acknowledges.

// A session with work archiving could lose, as the confirm sheet names it: "2 uncommitted files and 1 unpushed commit on
// branch". `unknown` when git and Paseo couldn't both say; the sheet says so instead.
export interface UnsavedSession {
  agentId: string;
  title: string | null;
  branch?: string;
  // Uncommitted files, counted where git or a preview could count them; else just that there are some.
  files?: number;
  uncommitted?: true;
  commits?: number;
  unknown?: true;
}

// Paseo's own reading of a session's worktree, for when git can't be asked: null or missing where it couldn't tell.
export interface WorktreeReading {
  dirty?: boolean | null;
  ahead?: number | null;
  branch?: string;
  files?: number;
}

// What archiving a session would lose, from Paseo's reading: null when it says both that nothing is uncommitted and that
// nothing is ahead. Clean needs both answers; either one missing makes it unknown [ATT-22].
export function unsavedOf(session: Pick<UnsavedSession, "agentId" | "title">, reading: WorktreeReading | undefined): UnsavedSession | null {
  const dirty = reading?.dirty ?? null;
  const ahead = reading?.ahead ?? null;
  if (dirty === false && ahead === 0) return null;
  return {
    agentId: session.agentId,
    title: session.title,
    ...(reading?.branch ? { branch: reading.branch } : {}),
    ...(reading?.files ? { files: reading.files } : dirty ? { uncommitted: true as const } : {}),
    ...(ahead ? { commits: ahead } : {}),
    ...(dirty === null || ahead === null ? { unknown: true as const } : {}),
  };
}

// "2 uncommitted files and 1 unpushed commit on split-invoice-pdf": what's known to be unsaved, as the sheets say it.
export function unsavedWords(unsaved: UnsavedSession): string {
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const parts = [
    ...(unsaved.files ? [count(unsaved.files, "uncommitted file")] : unsaved.uncommitted ? ["uncommitted changes"] : []),
    ...(unsaved.commits ? [count(unsaved.commits, "unpushed commit")] : []),
  ];
  const what = parts.join(" and ") || "unsaved changes";
  return unsaved.branch ? `${what} on ${unsaved.branch}` : what;
}

// What an archive request names: the row's item, its sessions, and the keys whose changes success acknowledges.
export interface ArchiveTarget {
  itemKey: string;
  agentIds: string[];
  keys: string[];
}

export const archiveTarget = (item: WrapItem): ArchiveTarget => ({
  itemKey: item.wrap.itemKey,
  agentIds: item.wrap.sessions.map((session) => session.id),
  keys: item.wrap.keys,
});

// What archiving answers. A refusal keeps the row and says why, or names the unsaved work to confirm. `warning`: the
// sessions were archived, but a worktree that should have gone stayed, and why.
export type ArchiveResult =
  | { ok: true; warning?: string }
  | { ok: false; reason: "working"; message: string }
  | { ok: false; reason: "unsaved"; sessions: UnsavedSession[] };

// The answer the screen gets: the result, with the list after it.
export type ArchiveOutcome = ArchiveResult & { view: AttentionView };
