import type { AttentionView } from "./attention";

// What archiving a Wrap up row answers [ATT-22]. A refusal keeps the row and says why, or names the unsaved work to confirm.
export interface ArchiveSessionInfo {
  agentId: string;
  title: string | null;
  branch?: string;
  files?: number;
  commits?: number;
  unknown?: true;
}

export type ArchiveOutcome =
  // `warning`: archived, but a worktree that should have gone stayed, and why.
  | { ok: true; view: AttentionView; warning?: string }
  | { ok: false; reason: "working"; message: string; view: AttentionView }
  | { ok: false; reason: "unsaved"; sessions: ArchiveSessionInfo[]; view: AttentionView };

// What one row's archive names: the item, the keys whose events it acknowledges, and its sessions.
export interface ArchiveTarget {
  itemKey: string;
  agentIds: string[];
  keys: string[];
}
