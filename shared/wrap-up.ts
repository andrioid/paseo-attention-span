import { type AgentSummary, type AttentionView, isIdle, type Item, keySet, matchSessions, memberKeys, type RememberedGroups, type SessionWorkspace, type WrapItem } from "./attention";
import { ago } from "./format";
import { changeText } from "./changes";

// Wrap up: finished or out-of-my-hands work whose unarchived Paseo sessions are all idle [ATT-22]. Pure, so the rules are
// testable. It's assembled on the client, which already polls Paseo's sessions for the screen and the sidebar's count; the
// server archives and acknowledges.

export type SessionCleanliness = "clean" | "dirty" | "unknown";

// What archiving would lose in a session's worktree, from Paseo's snapshot: clean only when it says both that nothing is
// uncommitted and that nothing is ahead. The server asks git again before archiving [ATT-22].
export function sessionCleanliness(agent: AgentSummary): SessionCleanliness {
  const workspace = agent.workspace;
  if (!workspace) return "unknown";
  if (workspace.dirty === true || (workspace.ahead ?? 0) > 0) return "dirty";
  if (workspace.dirty === false && workspace.ahead === 0) return "clean";
  return "unknown";
}

// "uncommitted changes and 1 unpushed commit on branch": what the multi-session sheet says about a session, from Paseo's
// snapshot, which doesn't count files.
export function unsavedText(agent: AgentSummary): string {
  const workspace: SessionWorkspace | undefined = agent.workspace;
  if (sessionCleanliness(agent) === "unknown") return "Couldn't check for unsaved changes";
  const parts: string[] = [];
  if (workspace?.dirty) parts.push("uncommitted changes");
  const ahead = workspace?.ahead ?? 0;
  if (ahead > 0) parts.push(`${ahead} unpushed commit${ahead === 1 ? "" : "s"}`);
  const what = parts.join(" and ") || "unsaved changes";
  return workspace?.branch ? `${what} on ${workspace.branch}` : what;
}

// A row with one session, clean: Archive session archives it at once, whatever happened on GitHub [ATT-22].
export function cleanSingle(item: WrapItem): boolean {
  return item.wrap.sessions.length === 1 && sessionCleanliness(item.wrap.sessions[0]) === "clean";
}

// What finishing looked like, in the same words the cards use [HIS-05, HIS-07].
function finishText(item: Item, now: Date): string {
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
// the note about it.
function candidates(view: WrapView): Item[] {
  const seen = new Set<string>();
  const ordered = [...view.history, ...(view.ownClosed ?? [])].sort((a, b) => Number(a.section === "changed") - Number(b.section === "changed"));
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
export type WrapView = Pick<AttentionView, "history" | "doing" | "waiting"> & Partial<Pick<AttentionView, "activeKeys" | "groups" | "ownClosed">>;

// What Doing's Wrap up shows, newest finish first. A row needs at least one open session, all idle. A stack or issue group
// enters once, and only when everything its sessions serve is done: a key still open in Doing or Waiting, or a remembered
// sibling of one, keeps the group out [ATT-22].
export function wrapItems(view: WrapView, agents: AgentSummary[], now = new Date()): WrapItem[] {
  if (agents.length === 0) return [];
  const active = keySet([...(view.activeKeys ?? []), ...[...view.doing.flatMap((section) => section.items), ...view.waiting.flatMap((group) => group.items)].flatMap(memberKeys)]);
  const groups = view.groups ?? {};
  const serving = (key: string) => [key.toLowerCase(), ...(groups[key.toLowerCase()] ?? [])].some((other) => active.has(other));
  const rows: { item: WrapItem; at: string }[] = [];
  const used = new Set<string>();
  for (const item of candidates(view)) {
    const keys = memberKeys(item);
    const sessions = matchSessions(agents, keys);
    if (sessions.length === 0) continue;
    // The group's sessions must all be idle, none may serve work that's still active, and a session belongs to one row only.
    if (sessions.some((agent) => !isIdle(agent) || serving(agent.itemKey) || used.has(agent.id)) || keys.some(serving)) continue;
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
  const inWrap = keySet(wrap.flatMap((item) => item.wrap.keys));
  return notes.filter((note) => !memberKeys(note).some((key) => inWrap.has(key.toLowerCase())));
}

// Doing's and the sidebar's count: what needs me, plus the rows Wrap up asks me to clean up [ATT-09, ATT-22].
export function doingCount(view: Pick<AttentionView, "count">, wrap: WrapItem[]): number {
  return view.count + wrap.length;
}
