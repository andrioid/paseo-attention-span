import type { AgentSummary } from "./attention";
import { sessionsFrom, type SessionWorkspaceEntry } from "./item-sessions";
import type { PaseoAgentEntry } from "./linked-sessions";

// Paseo's agents and workspaces as the app last learned them, from a full list, Paseo's stream, or an action's own
// answer; the sessions are made from them whenever they or the view change [FRESH-04, ATT-22]. Pure, so its rules test
// in node; the client owns the clock, the stream and the cache.

// When the app learned something, on the client's own clock: a counter, so two never tie. A list is stamped when it was
// asked for, a stream update when it arrived (not when its batch was written), an action's answer when it came back.
export type Stamp = number;

interface Held<E> {
  // Null once removed or archived, kept so a list asked for before then can't bring it back.
  entry: E | null;
  at: Stamp;
  // Where the stream had got to for it; seq only orders updates of one generation.
  seq?: number;
  generation?: string;
}

export interface SessionEntries {
  agents: Map<string, Held<PaseoAgentEntry>>;
  workspaces: Map<string, Held<SessionWorkspaceEntry>>;
}

// Every page of both lists, as Paseo listed them.
export interface SessionSnapshot {
  agents: PaseoAgentEntry[];
  workspaces: SessionWorkspaceEntry[];
}

type Change<E> = { kind: "upsert"; entry: E } | { kind: "remove"; id: string };
// One update from Paseo's stream: a whole entry, or the ID of one that's gone. `generation` should name the subscription
// too, since each counts its own seq.
export type StreamUpdate = (({ of: "agent" } & Change<PaseoAgentEntry>) | ({ of: "workspace" } & Change<SessionWorkspaceEntry>)) & {
  seq?: number;
  generation?: string;
};
// …stamped when it arrived.
export type SessionUpdate = StreamUpdate & { at: Stamp };

// What an action that Paseo confirmed changed: entries it created or changed, and the IDs it archived.
export interface SessionResult {
  agents?: PaseoAgentEntry[];
  workspaces?: SessionWorkspaceEntry[];
  archivedAgents?: string[];
  archivedWorkspaces?: string[];
}

export const emptyEntries = (): SessionEntries => ({ agents: new Map(), workspaces: new Map() });

// An update the app already knows better about is dropped: one older on the stream than the last for that ID, or one that
// arrived before what's held was learned (an action's answer, while the update sat in its batch).
function stale<E>(held: Held<E> | undefined, update: { at: Stamp; seq?: number; generation?: string }): boolean {
  if (!held) return false;
  if (update.at < held.at) return true;
  return update.seq !== undefined && held.seq !== undefined && update.generation === held.generation && update.seq <= held.seq;
}

// Paseo's stream updates, in the order they arrived [FRESH-04].
export function applyUpdates(entries: SessionEntries, updates: SessionUpdate[]): SessionEntries {
  const next = { agents: new Map(entries.agents), workspaces: new Map(entries.workspaces) };
  for (const update of updates) {
    const held: Map<string, Held<unknown>> = update.of === "agent" ? next.agents : next.workspaces;
    const id = update.kind === "upsert" ? update.entry.id : update.id;
    if (stale(held.get(id), update)) continue;
    held.set(id, { entry: update.kind === "upsert" ? update.entry : null, at: update.at, seq: update.seq, generation: update.generation });
  }
  return next;
}

// Snapshot entries, in the list's order, except where the app learned something after the list was asked for: a stream
// update or an action's answer since then stands, and so does what's gone since, even if the list still has it.
function merged<E extends { id: string }>(held: Map<string, Held<E>>, listed: E[], at: Stamp): Map<string, Held<E>> {
  const next = new Map<string, Held<E>>();
  for (const entry of listed) {
    const known = held.get(entry.id);
    next.set(entry.id, known && known.at > at ? known : { ...known, entry, at });
  }
  for (const [id, known] of held) if (!next.has(id) && known.at > at) next.set(id, known);
  return next;
}

// A full list asked for at `at` [FRESH-04].
export function applySnapshot(entries: SessionEntries | undefined, snapshot: SessionSnapshot, at: Stamp): SessionEntries {
  const held = entries ?? emptyEntries();
  return { agents: merged(held.agents, snapshot.agents, at), workspaces: merged(held.workspaces, snapshot.workspaces, at) };
}

// What an action just did, as Paseo answered it, learned at `at`: neither a stream update that arrived before then nor a
// list asked for before then can undo it [FRESH-04].
export function writeResult(entries: SessionEntries | undefined, result: SessionResult, at: Stamp): SessionEntries {
  const held = entries ?? emptyEntries();
  const next = { agents: new Map(held.agents), workspaces: new Map(held.workspaces) };
  const write = <E>(into: Map<string, Held<E>>, id: string, entry: E | null) => {
    const known = into.get(id);
    // Where the stream had got to stays, so an older update with a seq can't win later either.
    if (!known || known.at <= at) into.set(id, { ...known, entry, at });
  };
  for (const agent of result.agents ?? []) write(next.agents, agent.id, agent);
  for (const id of result.archivedAgents ?? []) write(next.agents, id, null);
  for (const workspace of result.workspaces ?? []) write(next.workspaces, workspace.id, workspace);
  for (const id of result.archivedWorkspaces ?? []) write(next.workspaces, id, null);
  return next;
}

// The sessions on items, from what's held; `branches` are closedBranches of the view [SES-08, ATT-22].
export function sessionsOf(entries: SessionEntries, branches?: Map<string, string>): AgentSummary[] {
  const present = <E>(held: Map<string, Held<E>>) => [...held.values()].flatMap((known) => (known.entry ? [known.entry] : []));
  return sessionsFrom(present(entries.agents), present(entries.workspaces), branches);
}
