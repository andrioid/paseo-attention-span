import { isHandover, type OthersChange } from "../shared/changes";
import type { Item } from "../shared/attention";
import type { AssignmentEvent, AssignmentSubject, EndedPullRequest, LiveResult } from "./github-types";
import { prKey } from "./queries";

// Changed by others: what someone else did to my work, kept between refreshes so a note stays until Got it, and so History
// can list work that left my hands [ATT-21, HIS-06]. Pure, so every rule is testable; service.ts does the fetching.

export interface ChangeLedger {
  events: OthersChange[];
  // Events I've tapped Got it on.
  gotIt: string[];
  // Issue node id -> key, from the last assigned search that worked. Null until the first, so nothing counts as gone then:
  // only issues seen assigned to me can be noticed leaving.
  assigned: Record<string, string> | null;
  // PR node id -> its assignees when last looked up, so each change of hands costs one lookup [GH-01].
  handed: Record<string, string>;
}

export const EMPTY_LEDGER: ChangeLedger = { events: [], gotIt: [], assigned: null, handed: {} };

type Data = Pick<LiveResult, "mine" | "assigned" | "ended">;
// A lookup's answer per node id: the subject, null when it's gone or hidden, missing when the lookup failed.
export type Lookups = Map<string, AssignmentSubject | null>;

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const present = <T>(nodes: (T | null | undefined)[]) => nodes.filter((node): node is T => !!node && Object.keys(node).length > 0);
const logins = (subject: { assignees: { nodes: { login: string }[] } }) => subject.assignees.nodes.map((node) => node.login);
// Assigned to someone, and not to me: out of my hands [PRS-08]. A PR of mine with nobody assigned is still mine.
const handedOver = (subject: { assignees: { nodes: { login: string }[] } }, me: string) => {
  const assignees = logins(subject);
  return assignees.length > 0 && !assignees.some((login) => same(login, me));
};
const signature = (subject: { assignees: { nodes: { login: string }[] } }) =>
  logins(subject)
    .map((login) => login.toLowerCase())
    .sort()
    .join(",");

// My PRs, open or closed lately, that someone else has: each looked up once per change of hands.
function handedPrs(data: Data, me: string): { id: string; signature: string }[] {
  const prs = [...present(data.mine.nodes), ...present(data.ended.nodes)].filter((pr) => pr.id && handedOver(pr, me));
  return [...new Map(prs.map((pr) => [pr.id, { id: pr.id, signature: signature(pr) }])).values()];
}

const assignedNow = (data: Data): Record<string, string> =>
  Object.fromEntries(present(data.assigned.nodes).flatMap((issue) => (issue.id ? [[issue.id, prKey(issue)]] : [])));

// What to look up: PRs whose hands changed since last looked, and issues no longer in my assigned search. An issue can leave
// the search for many reasons (search lag, a coverage change, its 50 results), so each is checked before anything is said.
export function changeCandidates(ledger: ChangeLedger, data: Data, me: string): string[] {
  const prs = handedPrs(data, me)
    .filter((pr) => ledger.handed[pr.id] !== pr.signature)
    .map((pr) => pr.id);
  const now = assignedNow(data);
  const gone = ledger.assigned ? Object.keys(ledger.assigned).filter((id) => !(id in now)) : [];
  return [...new Set([...prs, ...gone])];
}

const isAssignment = (node: AssignmentEvent | Record<string, never>): node is AssignmentEvent => "__typename" in node && "createdAt" in node;

// Who took it out of my hands, from GitHub's assign and unassign events [ATT-21]. Null when it's still mine, it was my own
// doing, or the events don't show it. An issue closed by now stays silent: issue closes are no big deal.
// The new owner is the latest of the current assignees to be assigned. It left my hands with whichever came last of my
// removal and the new owner's assignment, and whoever did that is named: "phil took over" when that's the new owner, else
// "dave handed it to carol". So a PR I unassigned myself from is still mine until someone else takes it.
export function handover(subject: AssignmentSubject, me: string): OthersChange | null {
  const assignees = logins(subject);
  if (assignees.some((login) => same(login, me))) return null;
  if (subject.__typename === "Issue" && subject.state !== "OPEN") return null;
  const events = present(subject.timelineItems.nodes)
    .filter(isAssignment)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const removal = events.findLast((event) => event.__typename === "UnassignedEvent" && same(event.assignee?.login, me));
  const given = events.findLast((event) => event.__typename === "AssignedEvent" && assignees.some((login) => same(login, event.assignee?.login)));
  const to = given?.assignee?.login ?? assignees[0];
  // A PR of mine with nobody on it is mine; an issue needs proof I was taken off it.
  if (subject.__typename === "PullRequest" ? !to : !removal) return null;
  const by = removal && given && to ? (given.createdAt > removal.createdAt ? given : removal) : (removal ?? given);
  if (!by || same(by.actor?.login, me)) return null;
  const actor = by.actor?.login;
  const kind = !to ? "unassigned" : same(actor, to) ? "took_over" : "handed";
  return change(subject, subject.__typename === "PullRequest" ? "pr" : "issue", kind, by.createdAt, actor, to);
}

// A PR of mine someone else merged or closed unmerged [ATT-21]. Whether it left my hands before it ended is up to nextLedger,
// which knows when that happened.
export function ended(pr: EndedPullRequest, me: string): OthersChange | null {
  if (pr.merged) return same(pr.mergedBy?.login, me) || !pr.mergedAt ? null : change(pr, "pr", "merged", pr.mergedAt, pr.mergedBy?.login);
  const closer = pr.timelineItems.nodes.at(-1)?.actor?.login;
  return same(closer, me) ? null : change(pr, "pr", "closed", pr.closedAt, closer);
}

function change(
  subject: { id: string; number: number; title: string; url: string; repository: { nameWithOwner: string } },
  kind: "pr" | "issue",
  what: OthersChange["kind"],
  at: string,
  actor?: string,
  to?: string,
): OthersChange {
  return {
    id: `${what}:${subject.id}:${at}`,
    kind: what,
    subjectId: subject.id,
    subject: kind,
    key: prKey(subject),
    repo: subject.repository.nameWithOwner,
    number: subject.number,
    title: subject.title,
    url: subject.url,
    ...(actor ? { actor } : {}),
    ...(to ? { to } : {}),
    at,
  };
}

// The ledger after a refresh. New events count only within `windowDays` (mentionDays), so a first run catches up that far
// and no further; kept for `keepDays`, long enough for History. Work back in my hands drops its handover. What couldn't be
// looked up is left to retry next time.
export function nextLedger(ledger: ChangeLedger, data: Data, me: string, lookups: Lookups, now: Date, windowDays: number, keepDays: number): ChangeLedger {
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const found: OthersChange[] = [];
  const endedAt = new Map(present(data.ended.nodes).map((pr) => [pr.id, pr.mergedAt ?? pr.closedAt]));
  // Assigning a PR once it's merged or closed hands nothing over.
  const handovers = [...lookups.values()]
    .map((subject) => (subject ? handover(subject, me) : null))
    .filter((event): event is OthersChange => !!event && !(endedAt.has(event.subjectId) && event.at > endedAt.get(event.subjectId)!));
  found.push(...handovers);
  const handedAt = (id: string) => [...ledger.events, ...handovers].filter((event) => isHandover(event) && event.subjectId === id).map((event) => event.at);
  for (const pr of present(data.ended.nodes)) {
    // A PR someone else has whose hands aren't looked up yet waits a refresh, so a handover isn't reported as a merge.
    if (handedOver(pr, me) && !lookups.has(pr.id) && ledger.handed[pr.id] !== signature(pr)) continue;
    const event = ended(pr, me);
    // One that left my hands before it ended was a handover, not my work merged or closed.
    if (event && !handedAt(pr.id).some((at) => at <= event.at)) found.push(event);
  }
  // Mine again: my PRs with nobody else on them, and issues assigned to me.
  const mineNow = new Set([...present(data.mine.nodes).filter((pr) => !handedOver(pr, me)).map((pr) => pr.id), ...Object.keys(assignedNow(data))]);
  const known = new Set(ledger.events.map((event) => event.id));
  const fresh = found.filter((event) => !known.has(event.id) && event.at >= since(windowDays));
  const events = [...ledger.events, ...fresh]
    .filter((event) => !(isHandover(event) && mineNow.has(event.subjectId)))
    .filter((event) => event.at >= since(keepDays))
    .sort((a, b) => b.at.localeCompare(a.at));
  const ids = new Set(events.map((event) => event.id));

  // Issues that left my search and couldn't be looked up stay, so they're checked again.
  const assigned = assignedNow(data);
  if (ledger.assigned) for (const [id, key] of Object.entries(ledger.assigned)) if (!(id in assigned) && !lookups.has(id)) assigned[id] = key;
  // A PR's hands are settled once looked up; one that failed keeps its old signature, so it's asked again.
  const handed: Record<string, string> = {};
  for (const pr of handedPrs(data, me)) {
    const before = ledger.handed[pr.id];
    if (before !== undefined || lookups.has(pr.id)) handed[pr.id] = lookups.has(pr.id) ? pr.signature : before;
  }
  return { events, gotIt: ledger.gotIt.filter((id) => ids.has(id)), assigned, handed };
}

// The ledger as cards: Doing's notes not yet cleared, within `windowDays`, newest first [ATT-21]; History's work closed
// unmerged by others or taken out of my hands, from `historySince` [HIS-06].
export function changeItems(ledger: ChangeLedger, now: Date, windowDays: number, historySince: string): { doing: Item[]; history: Item[] } {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const gotIt = new Set(ledger.gotIt);
  const base = (change: OthersChange): Omit<Item, "key" | "section"> => ({
    kind: change.subject,
    draft: false,
    repo: change.repo,
    number: change.number,
    title: change.title,
    url: change.url,
    chips: [],
    actions: [],
    children: [],
    target: { kind: change.subject, repo: change.repo, number: change.number, title: change.title, url: change.url },
    othersActivityAt: change.at,
    change,
  });
  const doing = ledger.events
    .filter((change) => !gotIt.has(change.id) && change.at >= since)
    .map((change): Item => ({ ...base(change), key: `change:${change.id}`, section: "changed", actions: ["got_it"] }));
  const history = ledger.events
    .filter((change) => change.kind !== "merged" && change.at >= historySince)
    .map((change): Item => ({ ...base(change), key: `handed:${change.id}`, section: "handed_off", closedAt: change.at }));
  return { doing, history };
}

// Keys of my PRs and issues that left my hands: a merge by their new owner isn't my finished work [HIS-06].
export function handedKeys(ledger: ChangeLedger): Set<string> {
  return new Set(ledger.events.filter(isHandover).map((event) => event.key));
}
