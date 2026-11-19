import { type AgentSummary, type AttentionView, type Item, itemSessions, matchSessions, memberKeys, type NextUpIssue, type WrapItem } from "./attention";
import type { WrapView } from "./wrap-up";
import { keySet } from "./names";

// In progress: my drafts, and the issues I started a session on that no card shows yet [PRS-05, SES-11]. Pure, so the rules
// test in node. It's assembled on the client, which polls Paseo's sessions, and every place that shows or counts Doing or
// Next up reads the same projection.

// An issue I started from Next up or Wrap up, with no pull request, reply or wrap-up row of its own yet.
export interface StartedIssue {
  key: string;
  repo: string;
  number: number;
  // Next up's issue, when Next up knows it: assigned to me, or unclaimed where it looks. Without it, the card is plain.
  issue?: NextUpIssue;
  assigned: boolean;
  // Its open sessions, the one that needs me first, then the latest.
  sessions: AgentSummary[];
  // One of its sessions waits on me: only then does it count [ATT-09].
  needsMe: boolean;
  // Its sessions' latest activity.
  at: string;
}

type ProjectionView = WrapView & Pick<AttentionView, "count" | "assigned" | "unclaimed">;

// "owner/name#12" -> its parts.
function parseKey(key: string): { repo: string; number: number } | null {
  const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(key);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

// Every key a card already shows, open or finished: a started issue that has one belongs there, not here. That covers an
// issue whose PRs are listed under it, a reply on it, a close it waits for, and it closing [ATT-03, ATT-22, ATT-24]. A card
// I dismissed counts too, so dismissing it doesn't bring the issue back here [ATT-08].
function shownKeys(view: ProjectionView, wrap: WrapItem[]): Set<string> {
  const items: Item[] = [
    ...view.doing.flatMap((section) => section.items),
    ...view.waiting.flatMap((group) => group.items),
    ...view.history,
    ...(view.ownClosed ?? []),
  ];
  return keySet([
    ...(view.activeKeys ?? []),
    ...items.flatMap(memberKeys),
    ...(view.closeAsks ?? []).flatMap((ask) => [ask.key, ...ask.prs.map((pr) => pr.key)]),
    ...wrap.flatMap((item) => item.wrap.keys),
  ]);
}

// The issues with an open session started on them as an issue ("start") that no card shows, latest activity first. Sessions
// Paseo links by workspace, or started on a pull request, never make one, but once there is one they're its sessions too.
export function startedIssues(view: ProjectionView, agents: AgentSummary[], wrap: WrapItem[]): StartedIssue[] {
  const shown = shownKeys(view, wrap);
  const known = new Map<string, { issue: NextUpIssue; assigned: boolean }>();
  for (const issue of view.unclaimed) known.set(issue.key.toLowerCase(), { issue, assigned: false });
  for (const issue of view.assigned) known.set(issue.key.toLowerCase(), { issue, assigned: true });
  const byKey = new Map<string, string>();
  for (const agent of agents) {
    const key = agent.itemKey.toLowerCase();
    if (agent.kind === "start" && !shown.has(key) && !byKey.has(key)) byKey.set(key, agent.itemKey);
  }
  const started: StartedIssue[] = [];
  for (const [key, itemKey] of byKey) {
    const match = known.get(key);
    const parts = match ? { repo: match.issue.repo, number: match.issue.number } : parseKey(itemKey);
    if (!parts) continue;
    const sessions = matchSessions(agents, [itemKey]);
    started.push({
      key: match?.issue.key ?? itemKey,
      ...parts,
      ...(match ? { issue: match.issue } : {}),
      assigned: match?.assigned ?? false,
      sessions,
      needsMe: sessions.some((agent) => agent.requiresAttention),
      at: sessions.map((agent) => agent.lastActivityAt ?? "").reduce((a, b) => (a > b ? a : b), ""),
    });
  }
  return started.sort((a, b) => Number(b.needsMe) - Number(a.needsMe) || b.at.localeCompare(a.at));
}

// The view as Doing, Next up and their counts show it: started issues leave Next up for In progress, and the ones whose
// session waits on me add to Doing's count [ATT-09, NXT-06].
export function withInProgress<V extends ProjectionView>(view: V, agents: AgentSummary[], wrap: WrapItem[]): V & { started: StartedIssue[] } {
  const started = startedIssues(view, agents, wrap);
  if (started.length === 0) return { ...view, started };
  const moved = keySet(started.map((issue) => issue.key));
  const stays = (issue: NextUpIssue) => !moved.has(issue.key.toLowerCase());
  return {
    ...view,
    assigned: view.assigned.filter(stays),
    unclaimed: view.unclaimed.filter(stays),
    count: view.count + started.filter((issue) => issue.needsMe).length,
    started,
  };
}

// One line of In progress: a draft from the server, or a started issue.
export type InProgressEntry = { kind: "draft"; item: Item } | { kind: "issue"; started: StartedIssue };

// Drafts and started issues together: whatever waits on me first, then the latest session activity; drafts without a
// session keep the server's order after them [PRS-05].
export function inProgressEntries(drafts: Item[], started: StartedIssue[], agents: AgentSummary[]): InProgressEntry[] {
  const ranked = [
    ...drafts.map((item, order) => {
      const sessions = itemSessions(agents, item);
      return {
        entry: { kind: "draft", item } as InProgressEntry,
        needsMe: sessions.some((agent) => agent.requiresAttention),
        at: sessions.map((agent) => agent.lastActivityAt ?? "").reduce((a, b) => (a > b ? a : b), ""),
        order,
      };
    }),
    ...started.map((issue, order) => ({ entry: { kind: "issue", started: issue } as InProgressEntry, needsMe: issue.needsMe, at: issue.at, order: drafts.length + order })),
  ];
  return ranked.sort((a, b) => Number(b.needsMe) - Number(a.needsMe) || b.at.localeCompare(a.at) || a.order - b.order).map(({ entry }) => entry);
}
