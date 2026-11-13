import { ago } from "./format";

// What someone else did to my work without asking me: merged or closed my PR, took it over or handed it on, or unassigned me
// from an issue [ATT-21]. Issue closes, others' pushes and my own doings aren't here.
//   merged     someone else merged my PR
//   closed     someone else closed my PR without merging it
//   took_over  someone assigned themselves my PR or issue, and I'm off it
//   handed     someone assigned my PR or issue to a third person, and I'm off it
//   unassigned someone took me off an issue and nobody has it now
export type OthersChangeKind = "merged" | "closed" | "took_over" | "handed" | "unassigned";

export interface OthersChange {
  // Stable across refreshes, so Got it sticks to this event and no other on the same item.
  id: string;
  kind: OthersChangeKind;
  // The PR's or issue's node id, which survives a transfer; key is "owner/name#number" as last seen.
  subjectId: string;
  subject: "pr" | "issue";
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  // Who did it; missing when GitHub doesn't say (a deleted account).
  actor?: string;
  // The new assignee, for took_over and handed.
  to?: string;
  at: string;
}

// Handovers take the work out of my hands; merges and closes end it.
export const HANDOVER_KINDS: readonly OthersChangeKind[] = ["took_over", "handed", "unassigned"];
export const isHandover = (change: Pick<OthersChange, "kind">) => HANDOVER_KINDS.includes(change.kind);

// The words on the card, so the tile's color is never the only way to tell [ATT-21]: "merged by dave 2h ago".
export function changeText(change: Pick<OthersChange, "kind" | "actor" | "to" | "at">, now = new Date()): string {
  const age = `${ago(change.at, now)} ago`;
  const { actor, to } = change;
  switch (change.kind) {
    case "merged":
      return actor ? `merged by ${actor} ${age}` : `merged ${age}`;
    case "closed":
      return actor ? `closed by ${actor} ${age}, not merged` : `closed ${age}, not merged`;
    case "took_over":
      return actor ? `${actor} took over ${age}` : `taken over ${age}`;
    case "handed":
      return actor ? `${actor} handed it to ${to} ${age}` : `handed to ${to} ${age}`;
    case "unassigned":
      return actor ? `${actor} unassigned you ${age}` : `unassigned you ${age}`;
  }
}
