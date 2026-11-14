import { type AgentSummary, type AttentionView, type Item, matchSessions, type SessionWorkspace } from "./attention";
import { ago } from "./format";
import { changeText } from "./changes";

// Wrap up: finished or out-of-my-hands work whose unarchived Paseo sessions are all idle [ATT-22]. Pure, so the rules are
// testable; the screen fetches the sessions and archives them.

// A session is idle when it isn't working and doesn't need me. Anything else keeps its row out of Wrap up.
export function sessionIdle(agent: AgentSummary): boolean {
  return !agent.requiresAttention && agent.status !== "running" && agent.status !== "initializing";
}

export type SessionCleanliness = "clean" | "dirty" | "unknown";

// What archiving would lose in a session's worktree. Paseo says whether it's dirty and how far it is ahead of upstream;
// when it couldn't say, the row treats it as dirty and the sheet says so [ATT-22].
export function sessionCleanliness(agent: AgentSummary): SessionCleanliness {
  const workspace = agent.workspace;
  if (!workspace) return "unknown";
  if (workspace.dirty === true || (workspace.ahead ?? 0) > 0) return "dirty";
  if (workspace.dirty === false && workspace.ahead !== undefined) return "clean";
  return "unknown";
}

// "2 uncommitted files and 1 unpushed commit on branch": what the confirm sheet names. Paseo doesn't count files, so the
// commit count is its own and the files are named without a number.
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
export function cleanSingle(item: Item): boolean {
  return !!item.wrap && item.wrap.sessions.length === 1 && sessionCleanliness(item.wrap.sessions[0]) === "clean";
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

// Remembers each open stack's and issue group's keys under every member, so a member that merges or closes still knows
// its open siblings: History lists a merged PR alone, as its branches are gone [ATT-22, ATT-04]. Forgotten after keepDays.
export function rememberGroups(
  groups: Record<string, { keys: string[]; at: string }>,
  items: Pick<Item, "key" | "children">[],
  now: Date,
  keepDays: number,
): Record<string, { keys: string[]; at: string }> {
  const at = now.toISOString();
  const since = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const next = Object.fromEntries(Object.entries(groups).filter(([, group]) => group.at >= since));
  for (const item of items) {
    if (item.children.length === 0) continue;
    const keys = [item.key, ...item.children.map((child) => child.key)].map((key) => key.toLowerCase());
    for (const key of keys) next[key] = { keys, at };
  }
  return next;
}

// The item, its children and the work a change note is about, lower case; a session on any of them serves the group
// [ATT-03, ATT-04, HIS-07].
const groupKeys = (item: Item) => [item.key, ...(item.change ? [item.change.key] : []), ...item.children.map((child) => child.key)].map((key) => key.toLowerCase());

// Every session the item's group matches, including one on a child PR.
const groupSessions = (agents: AgentSummary[], item: Item) => matchSessions(agents, [item.key, ...(item.change ? [item.change.key] : []), ...item.children.map((child) => child.key)]);

// The finished work and changes that could appear in Wrap up: my done and reviewed items, work that left my hands, and a
// change on finished work that History hasn't fetched yet [ATT-22, HIS-01, HIS-07]. A done item beats the note about it.
function candidates(view: Pick<AttentionView, "history"> & Pick<Partial<AttentionView>, "ownClosed">): Item[] {
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

// What Doing's Wrap up shows, newest finish first. A row needs at least one open session, all idle. A stack or issue group
// enters once, and only when every session it has serves work that's done: a session Paseo still links to an active item
// keeps the group out [ATT-22].
export function wrapItems(view: Pick<AttentionView, "history" | "doing" | "waiting"> & Pick<Partial<AttentionView>, "activeKeys" | "groups" | "ownClosed">, agents: AgentSummary[], now = new Date()): Item[] {
  if (agents.length === 0) return [];
  const active = new Map<string, true>((view.activeKeys ?? []).map((key) => [key.toLowerCase(), true]));
  for (const item of [...view.doing.flatMap((section) => section.items), ...view.waiting.flatMap((group) => group.items)]) {
    for (const key of groupKeys(item)) active.set(key, true);
  }
  // A key whose remembered stack or issue group still has an open member serves unfinished work [ATT-04].
  const groups = view.groups ?? {};
  const serving = (key: string) => [key.toLowerCase(), ...(groups[key.toLowerCase()] ?? [])].some((other) => active.has(other));
  const rows: { item: Item; at: string }[] = [];
  const used = new Set<string>();
  for (const item of candidates(view)) {
    const sessions = groupSessions(agents, item);
    if (sessions.length === 0) continue;
    // The group's sessions must all be idle, none may serve work that's still active, and a session belongs to one row only.
    if (sessions.some((agent) => !sessionIdle(agent) || serving(agent.itemKey) || used.has(agent.id))) continue;
    if (groupKeys(item).some(serving)) continue;
    for (const agent of sessions) used.add(agent.id);
    const keys = [item.key, ...(item.change ? [item.change.key] : []), ...item.children.map((child) => child.key)];
    rows.push({
      item: {
        ...item,
        key: `wrap:${item.key}`,
        section: "wrap",
        actions: [],
        chips: [],
        wrap: { sessions, keys, finish: finishText(item, now), ...(item.section === "reviewed" ? { review: true as const } : {}) },
      },
      at: item.closedAt ?? item.change?.at ?? item.othersActivityAt,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).map(({ item }) => item);
}

// The unread changes History shows: every note except the ones Already in Wrap up, where archiving is the acknowledgement
// [HIS-07, ATT-22]. A note whose work has no session left, or whose sessions are busy, stays unread.
export function unreadChanges(notes: Item[], wrap: Item[]): Item[] {
  const inWrap = new Set(wrap.flatMap((item) => item.wrap?.keys ?? groupKeys(item)).map((key) => key.toLowerCase()));
  return notes.filter((note) => !groupKeys(note).some((key) => inWrap.has(key)));
}

// Doing's and the sidebar's count: what needs me, plus the rows Wrap up asks me to clean up [ATT-09, ATT-22].
export function doingCount(view: Pick<AttentionView, "count">, wrap: Item[]): number {
  return view.count + wrap.length;
}
