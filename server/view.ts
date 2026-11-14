import { type Attention, type AttentionView, type Chip, type FeedId, type FeedStatus, type HistoryFilter, type Item, type NextUpIssue, type Section, SECTION_ORDER, SECTIONS, type TabId, type WaitingGroup } from "../shared/attention";
import type { AttentionConfig } from "../shared/config";
import { workChip, workKind } from "../shared/work";
import { type ChangeLedger, changeItems, EMPTY_LEDGER, handedKeys } from "./changes";
import { historySince } from "./queries";
import type { State } from "./store";

export interface ViewMeta {
  feeds: Record<FeedId, FeedStatus>;
  scopes: string[];
  sources: string[];
  projectFilter: string[];
  historyFilter: HistoryFilter[];
  groups?: Record<string, string[]>;
  config: AttentionConfig;
  pending: number;
}

// What a tap on GitHub changed, shown until a fetch can show it for itself [FRESH-02].
// Only where the outcome is certain does a card move; otherwise it stays, with a chip saying what's under way.
export type Effect =
  | { kind: "gone" }
  // Merged, or an issue of mine closed: off the lists, and into History as it will be fetched.
  | { kind: "done"; item: Item }
  | { kind: "claimed" }
  | { kind: "unclaimed" }
  | { kind: "chip"; chip: Chip };

export interface Pending {
  at: string;
  effect: Effect;
}

// GitHub's search shows a change within seconds (3s, measured), so a fetch begun this long after it shows it.
export const SETTLE_MS = 30_000;
// While fetches keep failing, a change stops being shown after this.
const GIVE_UP_MS = 10 * 60_000;

// Shown until every feed it touches has been fetched from after GitHub caught up.
export function isPending({ at, effect }: Pending, fetchedAt: Record<FeedId, string | null>, now: number): boolean {
  const time = new Date(at).getTime();
  if (now - time >= GIVE_UP_MS) return false;
  const feeds: FeedId[] = effect.kind === "done" ? ["live", "history"] : ["live"];
  return feeds.some((id) => !fetchedAt[id] || new Date(fetchedAt[id]).getTime() < time + SETTLE_MS);
}

// The History entry a merge or close will be, as classifyHistory makes it [HIS-01].
export function doneItem(source: Item | NextUpIssue, closedAt: string, notPlanned = false): Item {
  const { key, repo, number, title, url } = source;
  const kind = "kind" in source ? source.kind : "issue";
  // Labels come with the next History fetch; until then the issue type and title prefix tell what kind of work it was [HIS-04].
  const work = workKind({ type: "type" in source ? source.type : undefined, title });
  return {
    key,
    section: "done",
    kind,
    draft: false,
    repo,
    number,
    title,
    url,
    chips: [...(work ? [workChip(work)] : []), ...(notPlanned ? [{ text: "not planned", tone: "neutral" as const }] : [])],
    ...(work ? { work } : {}),
    ...(notPlanned ? { notPlanned: true as const } : {}),
    actions: [],
    // Not planned issues list their PRs on their own, as classifyHistory does [HIS-03].
    children: "children" in source && !notPlanned ? source.children.map((child) => ({ ...child, draft: false, chips: [], attention: false })) : [],
    target: { kind, repo, number, title, url },
    othersActivityAt: "1970-01-01T00:00:00Z",
    closedAt,
  };
}

// The fetched lists with what's pending applied on top.
export function applyPending(attention: Attention | null, history: Item[], pending: Record<string, Pending>): { attention: Attention | null; history: Item[] } {
  if (!attention || Object.keys(pending).length === 0) return { attention, history };
  const effect = (key: string) => pending[key]?.effect.kind;
  const off = (key: string) => effect(key) === "gone" || effect(key) === "done";
  const items = attention.items
    .filter((item) => !off(item.key))
    .map((item) => {
      const now = pending[item.key]?.effect;
      return now?.kind === "chip" && !item.chips.some((chip) => chip.text === now.chip.text) ? { ...item, chips: [...item.chips, now.chip] } : item;
    });
  const assigned = [...attention.assigned.filter((issue) => !off(issue.key) && effect(issue.key) !== "unclaimed"), ...attention.unclaimed.filter((issue) => effect(issue.key) === "claimed")];
  const unclaimed = [...attention.unclaimed.filter((issue) => !off(issue.key) && effect(issue.key) !== "claimed"), ...attention.assigned.filter((issue) => effect(issue.key) === "unclaimed")];
  // PRs listed under their issue count as known too, so a merge doesn't show twice [HIS-01].
  const known = new Set(history.flatMap((item) => [item.key, ...item.children.map((child) => child.key)]));
  const done = Object.values(pending).flatMap(({ effect }) => (effect.kind === "done" && !known.has(effect.item.key) ? [effect.item] : []));
  // History is newest first; what I just finished is newest of all.
  return { attention: { ...attention, items, assigned, unclaimed }, history: [...done, ...history] };
}

// A dismissed item stays hidden until someone else does something on it or its reason changes [ATT-08].
export function isDismissed(item: Item, dismissed: State["dismissed"]): boolean {
  const entry = dismissed[item.key];
  return !!entry && entry.section === item.section && item.othersActivityAt <= entry.at;
}

// Waiting by who it waits on, so I know whom to nudge: whoever blocks the most first, ties by the longest wait, then bots, who
// can't be nudged, and last the work no person holds up. Each one's work oldest first; the screen lifts work with an active
// session. My PRs in Doing that wait on whom I asked are here too, so nudging them is one list [WAI-01, WAI-03, PRS-15].
export function waitingGroups(items: Item[]): WaitingGroup[] {
  const oldest = (list: Item[]) => list.map((item) => item.wait?.since ?? "").sort()[0] ?? "";
  const people = new Map<string, WaitingGroup>();
  const nobody: Item[] = [];
  for (const item of items) {
    if (!item.waitingOn?.length) nobody.push(item);
    for (const who of item.waitingOn ?? []) {
      const key = `${who.team ? "team" : "user"}:${who.login.toLowerCase()}`;
      const group = people.get(key) ?? { who: { ...who }, items: [] };
      // A requested bot is a bot wherever else its name turns up, like a tag [WAI-03].
      if (who.bot) group.who!.bot = true;
      group.items.push(item);
      people.set(key, group);
    }
  }
  const byWait = (a: Item, b: Item) => (a.wait?.since ?? "").localeCompare(b.wait?.since ?? "");
  const groups = [...people.values()].map((group) => ({ ...group, items: group.items.sort(byWait) }));
  groups.sort(
    (a, b) =>
      Number(!!a.who!.bot) - Number(!!b.who!.bot) ||
      b.items.length - a.items.length ||
      oldest(a.items).localeCompare(oldest(b.items)) ||
      a.who!.login.localeCompare(b.who!.login),
  );
  return nobody.length ? [...groups, { items: nobody.sort(byWait) }] : groups;
}

// Waiting's work: its own sections, and my PRs in Doing while they wait on someone I asked [WAI-01, PRS-15].
const inWaiting = (item: Item) => SECTIONS[item.section].tab === "waiting" || (SECTIONS[item.section].tab === "doing" && !!item.wait && !!item.waitingOn?.length);

export function buildView(attention: Attention | null, history: Item[], dismissed: State["dismissed"], meta: ViewMeta, ledger: ChangeLedger = EMPTY_LEDGER, now = new Date()): AttentionView {
  const items = [...(attention?.items ?? []), ...history];
  // A PR that left my hands isn't my finished work, even once its new owner merges it [HIS-06].
  const handed = handedKeys(ledger);
  const visible = items
    .filter((item) => !isDismissed(item, dismissed) && !(item.section === "done" && handed.has(item.key)))
    .map((item) => (item.section === "done" && item.children.some((child) => handed.has(child.key)) ? { ...item, children: item.children.filter((child) => !handed.has(child.key)) } : item));
  // Notes on what others did, what was cleared into a week, and finished work a live refresh saw first; never dismissed,
  // only cleared with Got it or an archive [HIS-06, HIS-07, ATT-22].
  const changes = changeItems(ledger, now, meta.config.mentionDays, historySince(now, meta.config.historyWeeks));
  // History's daily fetch has the richer item; one seen live fills in until then, so a merge or close shows in its week now.
  const knownDone = new Set(visible.filter((item) => SECTIONS[item.section].tab === "history" && item.section === "done").flatMap((item) => [item.key, ...item.children.map((child) => child.key)]));
  const liveFinished = changes.finished.filter((item) => !knownDone.has(item.key));
  const shown = [...visible, ...liveFinished, ...changes.notes, ...changes.history];
  const sections = (tab: TabId): Section[] =>
    SECTION_ORDER.filter((id) => SECTIONS[id].tab === tab)
      .map((id) => ({ id, title: SECTIONS[id].title, items: shown.filter((item) => item.section === id) }))
      .filter((section) => section.items.length > 0);
  const doing = sections("doing");
  return {
    ...meta,
    login: attention?.login ?? null,
    // What needs me; Wrap up's cleanup rows are added client-side, where the sessions are [ATT-09, ATT-22].
    count: doing.reduce((sum, section) => sum + section.items.length, 0),
    doing,
    waiting: waitingGroups(visible.filter(inWaiting)),
    history: shown.filter((item) => SECTIONS[item.section].tab === "history"),
    // Dismissed or not, these are still open; Wrap up must not call their sessions finished [ATT-22].
    ownClosed: attention?.ownClosed ?? [],
    activeKeys: (attention?.items ?? []).flatMap((item) => [item.key, ...item.children.map((child) => child.key)]),
    assigned: attention?.assigned ?? [],
    unclaimed: attention?.unclaimed ?? [],
    unclaimedFrom: attention?.unclaimedFrom ?? "config",
    projects: attention?.projects ?? [],
    dismissedCount: items.filter((item) => isDismissed(item, dismissed)).length,
  };
}
