import type { AttentionView, WrapItem } from "./attention";

// Archiving a Wrap up row's sessions [ATT-22]. The screen names the row; the server checks, archives and acknowledges.

// A session with work archiving could lose, as the confirm sheet names it: "2 uncommitted files and 1 unpushed commit on
// branch". `unknown` when git and Paseo couldn't both say; the sheet says so instead.
export interface UnsavedSession {
  agentId: string;
  title: string | null;
  branch?: string;
  files?: number;
  commits?: number;
  unknown?: true;
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
