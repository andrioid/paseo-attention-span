import { type AgentSummary, type AttentionView, baseItem, type CloseAsk, isIdle, type Item, matchSessions, memberKeys, type RememberedGroups, type WrapItem } from "./attention";
import { type UnsavedSession, unsavedOf } from "./archive";
import { ago } from "./format";
import { changeText } from "./changes";
import { keySet } from "./names";

// Wrap up: finished or out-of-my-hands work whose unarchived Paseo sessions are all idle [ATT-22]. Pure, so the rules are
// testable. It's assembled on the client, which already polls Paseo's sessions for the screen and the sidebar's count; the
// server archives and acknowledges.

export type SessionCleanliness = "clean" | "dirty" | "unknown";

// What archiving a session would lose, from Paseo's reading of its worktree; the server asks git again before archiving.
// Previews count the files [ATT-22].
export function sessionUnsaved(agent: AgentSummary): UnsavedSession | null {
  const workspace = agent.workspace;
  return unsavedOf({ agentId: agent.id, title: agent.title }, workspace && { ...workspace, files: workspace.dirtyFiles, lines: workspace.dirtyLines });
}

// Dirty as soon as Paseo says something is unsaved, even when it couldn't tell the other half; unknown only when it knows
// of nothing unsaved but can't say it's clean.
export function sessionCleanliness(agent: AgentSummary): SessionCleanliness {
  const unsaved = sessionUnsaved(agent);
  if (!unsaved) return "clean";
  return unsaved.files || unsaved.uncommitted || unsaved.commits ? "dirty" : "unknown";
}

// A row with one session, clean: Archive session archives it at once, whatever happened on GitHub [ATT-22]. A row asking to
// close an issue answers that first [ATT-24].
export function cleanSingle(item: WrapItem): boolean {
  return !item.wrap.ask && item.wrap.sessions.length === 1 && sessionCleanliness(item.wrap.sessions[0]) === "clean";
}

// What finishing looked like, in the same words the cards use [HIS-05, HIS-07].
export function finishText(item: Item, now: Date): string {
  if (item.change) return changeText(item.change, now);
  const at = item.closedAt ?? item.othersActivityAt;
  const age = `${ago(at, now)} ago`;
  if (item.section === "reviewed") return `merged ${age}${item.mergedBy ? ` by ${item.mergedBy}` : ""}`;
  if (item.closedUnmerged) return `closed ${age}, not merged`;
  if (item.kind === "pr") return `merged ${age}${item.mergedBy ? ` by ${item.mergedBy}` : ""}`;
  return `closed ${age}${item.closedBy ? ` by ${item.closedBy}` : ""}${item.notPlanned ? " as not planned" : ""}`;
}

// Remembers each open stack's and issue group's member keys under every member, so a member that merges or closes still
// knows its open siblings: History lists a merged PR alone, as its branches are gone [ATT-22, ATT-04]. Forgotten after
// keepDays.
export function rememberGroups(groups: RememberedGroups, items: Pick<Item, "key" | "children">[], now: Date, keepDays: number): RememberedGroups {
  const at = now.toISOString();
  const since = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const next = Object.fromEntries(Object.entries(groups).filter(([, group]) => group.at >= since));
  for (const item of items) {
    if (item.children.length === 0) continue;
    const keys = [...keySet(memberKeys(item))];
    for (const key of keys) next[key] = { keys, at };
  }
  return next;
}

// The finished work and changes that could appear in Wrap up: my done and reviewed items, my own unmerged closes, work that
// left my hands, and a change on finished work that History hasn't fetched yet [ATT-22, HIS-01, HIS-07]. A done item beats
// the note about it. A merged PR from the live feed only stands in until History lists it, alone or under its issue, so
// it never makes a row of its own beside its issue's [FRESH-03].
function candidates(view: WrapView): Item[] {
  const listed = new Set(view.history.flatMap((item) => [item.key, ...item.children.map((child) => child.key)]).map((key) => key.toLowerCase()));
  const seen = new Set<string>();
  const ordered = [...view.history, ...(view.ownClosed ?? []).filter((item) => !listed.has(item.key.toLowerCase()))].sort((a, b) => Number(a.section === "changed") - Number(b.section === "changed"));
  return ordered.filter((item) => {
    // A reopened PR is open again, not work to wrap up.
    if (item.section === "changed" && (!item.change || item.change.kind === "reopened")) return false;
    const key = item.key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// What Wrap up reads from the view.
export type WrapView = Pick<AttentionView, "history" | "doing" | "waiting"> & Partial<Pick<AttentionView, "activeKeys" | "groups" | "ownClosed" | "closeAsks">>;

// "#34 merged 2h ago", "#34 and #35 merged 2h ago", "4 PRs merged 2h ago": what's done under an issue asked about, by its
// latest merge [ATT-24].
export function askText(ask: CloseAsk, now: Date): string {
  const numbers = ask.prs.map((pr) => `#${pr.number}`);
  const which = numbers.length > 3 ? `${numbers.length} PRs` : numbers.length > 1 ? `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}` : numbers[0];
  return `${which} merged ${ago(ask.mergedAt, now)} ago`;
}

// What Doing's Wrap up shows, newest finish first. A row needs at least one open session, all idle. A stack or issue group
// enters once, and only when everything its sessions serve is done: a key still open in Doing or Waiting, or a remembered
// sibling of one, keeps the group out [ATT-22].
export function wrapItems(view: WrapView, agents: AgentSummary[], now = new Date()): WrapItem[] {
  const asks = view.closeAsks ?? [];
  if (agents.length === 0 && asks.length === 0) return [];
  const active = keySet([...(view.activeKeys ?? []), ...[...view.doing.flatMap((section) => section.items), ...view.waiting.flatMap((group) => group.items)].flatMap(memberKeys)]);
  const groups = view.groups ?? {};
  const serving = (key: string) => [key.toLowerCase(), ...(groups[key.toLowerCase()] ?? [])].some((other) => active.has(other));
  const rows: { item: WrapItem; at: string }[] = [];
  const used = new Set<string>();
  // The group's sessions must all be idle, none may serve work that's still active, and a session belongs to one row only.
  // A sub-agent still working keeps its session's row out too.
  const unready = (sessions: AgentSummary[]) => sessions.some((agent) => !isIdle(agent) || agent.subAgents?.working || serving(agent.itemKey) || used.has(agent.id));
  // An issue to close leads its row, with its merged PRs' sessions once they're ready, so they don't make rows of their own;
  // it asks with or without them [ATT-24].
  const asked = new Set<string>();
  for (const ask of asks) {
    const keys = [ask.key, ...ask.prs.map((pr) => pr.key)];
    const found = matchSessions(agents, keys);
    const sessions = unready(found) ? [] : found;
    for (const agent of sessions) used.add(agent.id);
    for (const key of keys) asked.add(key.toLowerCase());
    const base = baseItem({ key: `wrap:${ask.key}`, section: "wrap", kind: "issue", repo: ask.repo, number: ask.number, title: ask.title, url: ask.url }, ask.mergedAt);
    rows.push({ item: { ...base, section: "wrap", children: ask.prs, wrap: { sessions, itemKey: ask.key, keys, finish: askText(ask, now), ask: true } }, at: ask.mergedAt });
  }
  for (const item of candidates(view)) {
    const keys = memberKeys(item);
    if (keys.some((key) => asked.has(key.toLowerCase()))) continue;
    const sessions = matchSessions(agents, keys);
    if (sessions.length === 0) continue;
    if (unready(sessions) || keys.some(serving)) continue;
    for (const agent of sessions) used.add(agent.id);
    rows.push({
      item: {
        ...item,
        key: `wrap:${item.key}`,
        section: "wrap",
        actions: [],
        chips: [],
        wrap: { sessions, itemKey: item.key, keys, finish: finishText(item, now), ...(item.section === "reviewed" ? { review: true as const } : {}) },
      },
      at: item.closedAt ?? item.change?.at ?? item.othersActivityAt,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).map(({ item }) => item);
}

// The unread changes History shows: every note except the ones already in Wrap up, where archiving is the acknowledgement
// [HIS-07, ATT-22]. A note whose work has no session left, or whose sessions are busy, stays unread.
export function unreadChanges(notes: Item[], wrap: WrapItem[]): Item[] {
  // A row asking to close an issue only acknowledges when it has sessions to archive [ATT-24].
  const inWrap = keySet(wrap.filter((item) => item.wrap.sessions.length > 0).flatMap((item) => item.wrap.keys));
  return notes.filter((note) => !memberKeys(note).some((key) => inWrap.has(key.toLowerCase())));
}

// Doing's and the sidebar's count: what needs me, plus the rows Wrap up asks me to clean up [ATT-09, ATT-22].
export function doingCount(view: Pick<AttentionView, "count">, wrap: WrapItem[]): number {
  return view.count + wrap.length;
}
