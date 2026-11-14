import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// A session Attention Span started, archived in Paseo itself: once no session it started is left open on any part of the
// item's stack or issue group, what others did to that work up to the archive is acknowledged, so it doesn't come back as
// unread [HIS-07, ATT-22]. Only sessions Attention Span started count, by their item label; sessions linked only by their
// workspace don't, either way. A failed decision is kept in memory and made again on the next chance; archives while the
// server isn't running aren't noticed.

type Paseo = PluginHandlerContext["paseo"];
type ListedAgent = Awaited<ReturnType<Paseo["agents"]["list"]>>["entries"][number]["agent"];
type ListOptions = NonNullable<Parameters<Paseo["agents"]["list"]>[0]>;

// The markers and item labels of sessions Attention Span started, under its current and earlier names [ATT-07, SES-03].
const MARKERS = ["attention-span", "github-attention", "github-inbox"];
const ITEM_LABELS = MARKERS.map((marker) => `${marker}-item`);
// Agents another agent started belong to that agent's session.
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
// A decision that keeps failing is given up after this many tries.
const MAX_TRIES = 10;

export interface ArchiveEvent {
  agentId: string;
  parentAgentId: string | null;
  archivedAt: string;
}

// What Paseo says of the archived session now; null when it couldn't be found.
export type FoundSession = Pick<ListedAgent, "labels" | "archivedAt"> | null;

export const itemKeyOf = (labels: Record<string, string> | undefined | null): string | undefined =>
  ITEM_LABELS.map((label) => labels?.[label]).find(Boolean);

// The item whose notes the archive may acknowledge; "drop" when it acknowledges nothing, "wait" when it can't tell yet.
export function archivedItem(event: ArchiveEvent, found: FoundSession): { itemKey: string } | "drop" | "wait" {
  if (event.parentAgentId) return "drop";
  if (!found) return "wait";
  if (found.labels?.[PARENT_AGENT_LABEL]) return "drop";
  // Restored since, or archived again: this archive no longer stands, and a later one has its own event.
  if (!found.archivedAt || Date.parse(found.archivedAt) !== Date.parse(event.archivedAt)) return "drop";
  const itemKey = itemKeyOf(found.labels);
  return itemKey ? { itemKey } : "drop";
}

// Whether an open session Attention Span started is on any of the keys, which are compared ignoring case. The archived
// session itself counts too: if it's listed open, it was restored while this was being decided.
export function stillOpen(keys: string[], open: Pick<ListedAgent, "labels" | "archivedAt">[]): boolean {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return open.some((agent) => {
    if (agent.archivedAt) return false;
    const itemKey = itemKeyOf(agent.labels);
    return !!itemKey && wanted.has(itemKey.toLowerCase());
  });
}

// Every page of a list; a failed page fails the whole list, so it's never mistaken for an empty one.
async function listAll(paseo: Paseo, options: ListOptions): Promise<ListedAgent[]> {
  const agents: ListedAgent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await paseo.agents.list({ ...options, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(...result.entries.map((entry) => entry.agent));
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return agents;
    cursor = result.pageInfo.nextCursor;
  }
}

// The archived session as Paseo has it now: its own snapshot, or else the list with archived sessions in it.
async function findSession(paseo: Paseo, agentId: string): Promise<FoundSession> {
  const refreshed = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent;
  if (refreshed) return refreshed;
  return (await listAll(paseo, { filter: { includeArchived: true } })).find((agent) => agent.id === agentId) ?? null;
}

export interface ArchiveDeps {
  groupKeysOf(itemKey: string): string[];
  acknowledge(keys: string[], upTo: string): Promise<unknown>;
}

export class ArchivedInPaseo {
  // Agent id -> the archive still to decide, and how often that failed.
  private pending = new Map<string, { event: ArchiveEvent; tries: number }>();
  private running: Promise<void> = Promise.resolve();

  constructor(private deps: ArchiveDeps) {}

  // A new archive, and another try at the ones still pending. One at a time, so two never decide the same archive.
  notice(paseo: Paseo, event?: ArchiveEvent): Promise<void> {
    if (event) this.pending.set(event.agentId, { event, tries: 0 });
    this.running = this.running.then(() => this.drain(paseo));
    return this.running;
  }

  get waiting(): number {
    return this.pending.size;
  }

  private async drain(paseo: Paseo): Promise<void> {
    for (const [agentId, job] of [...this.pending]) {
      const done = await this.decide(paseo, job.event).catch((error) => {
        console.error("Couldn't acknowledge an archived session's changes:", (error as Error).message);
        return false;
      });
      if (this.pending.get(agentId) !== job) continue; // archived again meanwhile: the newer event is decided next time
      if (done || ++job.tries >= MAX_TRIES) this.pending.delete(agentId);
    }
  }

  // True once decided; false to try again later.
  private async decide(paseo: Paseo, event: ArchiveEvent): Promise<boolean> {
    if (event.parentAgentId) return true; // a sub-agent's archive is its parent session's business: nothing to look up
    const item = archivedItem(event, await findSession(paseo, event.agentId));
    if (item === "drop") return true;
    if (item === "wait") return false;
    const keys = this.deps.groupKeysOf(item.itemKey);
    const open = (await Promise.all(MARKERS.map((marker) => listAll(paseo, { filter: { labels: { [marker]: "1" } } })))).flat();
    if (stillOpen(keys, open)) return true;
    await this.deps.acknowledge(keys, event.archivedAt);
    return true;
  }
}
