import { describe, expect, it } from "vitest";
import type { Attention, Item } from "../shared/attention";
import { changeText, type OthersChange } from "../shared/changes";
import { AttentionConfig } from "../shared/config";
import { acknowledge, type ChangeLedger, changeCandidates, changeItems, closedByOther, EMPTY_LEDGER, ended, handover, type Lookups, nextLedger, ownClosed, reopened, reopenCandidates, withGotIt } from "./changes";
import type { AssignmentEvent, AssignmentSubject, ClosedIssue, EndedPullRequest, LiveResult, PickableNode, PullRequestNode, ReopenSubject } from "./github-types";
import { buildView } from "./view";

const NOW = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const repository = { nameWithOwner: "acme/shop" };
const users = (...logins: string[]) => ({ nodes: logins.map((login) => ({ login })) });

const assigned = (assignee: string, actor: string | null, hours: number): AssignmentEvent => ({
  __typename: "AssignedEvent",
  createdAt: hoursAgo(hours),
  actor: actor ? { login: actor } : null,
  assignee: { login: assignee },
});
const unassigned = (assignee: string, actor: string | null, hours: number): AssignmentEvent => ({ ...assigned(assignee, actor, hours), __typename: "UnassignedEvent" });

function subject(kind: "PullRequest" | "Issue", assignees: string[], events: AssignmentEvent[], state: AssignmentSubject["state"] = "OPEN"): AssignmentSubject {
  return { __typename: kind, id: `N_${kind}`, number: 7, title: "Work", url: "https://github.com/acme/shop/7", state, repository, assignees: users(...assignees), timelineItems: { nodes: events } };
}

function endedPr(id: string, fields: Partial<EndedPullRequest>): EndedPullRequest {
  return {
    id,
    number: 9,
    title: "Retry webhooks",
    url: "https://github.com/acme/shop/pull/9",
    merged: true,
    mergedAt: hoursAgo(2),
    closedAt: hoursAgo(2),
    repository,
    mergedBy: { login: "dave" },
    assignees: users(),
    timelineItems: { nodes: [] },
    ...fields,
  };
}

const openPr = (id: string, ...assignees: string[]) => ({ id, number: 3, repository, assignees: users(...assignees) }) as unknown as PullRequestNode;
const issue = (id: string, number = 5) => ({ id, number, repository }) as unknown as PickableNode;
function data(parts: { mine?: PullRequestNode[]; assigned?: PickableNode[]; ended?: EndedPullRequest[]; closedIssues?: ClosedIssue[] }): Pick<LiveResult, "mine" | "assigned" | "ended"> & Pick<LiveResult, "closedIssues"> {
  return { mine: { nodes: parts.mine ?? [] }, assigned: { nodes: parts.assigned ?? [] }, ended: { nodes: parts.ended ?? [] }, closedIssues: { nodes: parts.closedIssues ?? [] } };
}

function closedIssue(fields: Partial<ClosedIssue> = {}): ClosedIssue {
  return {
    id: "I1",
    number: 11,
    title: "Export fails",
    url: "https://github.com/acme/shop/issues/11",
    closedAt: hoursAgo(6),
    stateReason: "COMPLETED",
    repository,
    timelineItems: { nodes: [{ actor: { login: "alice" } }] },
    ...fields,
  };
}

function reopenSubject(fields: Partial<ReopenSubject> = {}): ReopenSubject {
  return {
    id: "P1",
    number: 9,
    title: "Retry webhooks",
    url: "https://github.com/acme/shop/pull/9",
    state: "OPEN",
    repository,
    timelineItems: { nodes: [{ createdAt: hoursAgo(1), actor: { login: "bob" } }] },
    ...fields,
  };
}

describe("who took my work out of my hands", () => {
  it("HIS-07: someone who unassigns me and assigns themselves took over", () => {
    const change = handover(subject("PullRequest", ["phil"], [assigned("me", "me", 30), unassigned("me", "phil", 5), assigned("phil", "phil", 5)]), "me");
    expect(change).toMatchObject({ kind: "took_over", actor: "phil", to: "phil", subject: "pr", at: hoursAgo(5) });
    expect(changeText(change!, NOW)).toBe("phil took over 5h ago");
  });

  it("HIS-07: someone who moves it to a third person handed it to them; the one named is who took me off", () => {
    const change = handover(subject("Issue", ["carol"], [assigned("me", "me", 30), assigned("carol", "dave", 6), unassigned("me", "alice", 5)]), "me");
    expect(change).toMatchObject({ kind: "handed", actor: "alice", to: "carol" });
    expect(changeText(change!, NOW)).toBe("alice handed it to carol 5h ago");
  });

  it("HIS-07: my PR with nobody assigned that someone assigns to another is handed over by whoever assigned them", () => {
    expect(handover(subject("PullRequest", ["carol"], [assigned("carol", "dave", 3)]), "me")).toMatchObject({ kind: "handed", actor: "dave", to: "carol" });
  });

  it("HIS-07: an issue I'm taken off with nobody on it says who unassigned me", () => {
    const change = handover(subject("Issue", [], [assigned("me", "me", 30), unassigned("me", "bob", 72)]), "me");
    expect(change).toMatchObject({ kind: "unassigned", actor: "bob" });
    expect(changeText(change!, NOW)).toBe("bob unassigned you 3d ago");
  });

  it("HIS-07: stays silent for my own doing, work still mine, an unproven issue, or an issue closed by now", () => {
    expect(handover(subject("PullRequest", ["carol"], [unassigned("me", "me", 2), assigned("carol", "me", 2)]), "me")).toBeNull();
    expect(handover(subject("PullRequest", ["me", "carol"], [assigned("carol", "dave", 2)]), "me")).toBeNull();
    // A PR of mine that nobody has is still mine.
    expect(handover(subject("PullRequest", [], [unassigned("me", "dave", 2)]), "me")).toBeNull();
    // An issue that left my search without an unassign event: search lag or a coverage change, not a handover.
    expect(handover(subject("Issue", [], []), "me")).toBeNull();
    expect(handover(subject("Issue", [], [unassigned("me", "bob", 2)], "CLOSED"), "me")).toBeNull();
  });

  it("HIS-07: names nobody when GitHub doesn't say who", () => {
    expect(changeText(handover(subject("Issue", [], [unassigned("me", null, 1)]), "me")!, NOW)).toBe("unassigned you 1h ago");
  });
});

describe("my PRs others merged or closed", () => {
  it("HIS-07: a merge or a close by someone else is a note; my own isn't", () => {
    expect(changeText(ended(endedPr("P1", {}), "me")!, NOW)).toBe("merged by dave 2h ago");
    expect(ended(endedPr("P1", { mergedBy: { login: "Me" } }), "me")).toBeNull();
    const closed = endedPr("P2", { merged: false, mergedAt: null, mergedBy: null, timelineItems: { nodes: [{ actor: { login: "alice" } }] } });
    expect(changeText(ended(closed, "me")!, NOW)).toBe("closed by alice 2h ago, not merged");
    expect(ended({ ...closed, timelineItems: { nodes: [{ actor: { login: "me" } }] } }, "me")).toBeNull();
  });

  it("HIS-07: a PR handed over before it ended is a handover, not a merge; one assigned after it ended is still my merge", () => {
    const pr = endedPr("P1", { assignees: users("carol"), mergedBy: { login: "carol" } });
    const lookup = (hours: number): Lookups => new Map([["P1", { ...subject("PullRequest", ["carol"], [assigned("carol", "carol", hours)]), id: "P1", state: "MERGED" }]]);
    const before = nextLedger(EMPTY_LEDGER, data({ ended: [pr] }), "me", lookup(5), NOW, 30, 35);
    expect(before.events.map((event) => event.kind)).toEqual(["took_over"]);
    const after = nextLedger(EMPTY_LEDGER, data({ ended: [pr] }), "me", lookup(1), NOW, 30, 35);
    expect(after.events.map((event) => [event.kind, event.actor])).toEqual([["merged", "carol"]]);
    // Not looked up yet (the lookup failed): wait a refresh rather than call it a merge.
    expect(nextLedger(EMPTY_LEDGER, data({ ended: [pr] }), "me", new Map(), NOW, 30, 35).events).toEqual([]);
  });
});

describe("keeping and clearing", () => {
  const merged = (id: string, hours: number) => endedPr(id, { mergedAt: hoursAgo(hours), closedAt: hoursAgo(hours) });

  it("HIS-07, HIS-06: events are kept for keepDays, then dropped with their Got it", () => {
    const kept = nextLedger(EMPTY_LEDGER, data({ ended: [merged("P1", 24 * 20)] }), "me", new Map(), NOW, 30, 35);
    const tapped = { ...kept, gotIt: [kept.events[0].id] };
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    expect(nextLedger(tapped, data({}), "me", new Map(), later, 30, 35)).toMatchObject({ events: [], gotIt: [] });
    expect(nextLedger(tapped, data({}), "me", new Map(), NOW, 30, 35).gotIt).toEqual(tapped.gotIt);
  });

  it("HIS-07: a Got it tapped while a refresh ran survives it, and Undo while it ran too", () => {
    const before = nextLedger(EMPTY_LEDGER, data({ ended: [merged("P1", 2), merged("P2", 3)] }), "me", new Map(), NOW, 30, 35);
    const [first, second] = before.events.map((event) => event.id);
    // The refresh read the ledger with nothing tapped; meanwhile first was tapped.
    const after = nextLedger(before, data({ ended: [merged("P1", 2), merged("P2", 3)] }), "me", new Map(), NOW, 30, 35);
    expect(withGotIt(after, [first]).gotIt).toEqual([first]);
    // Read with second tapped, then Undo while it ran: the refresh doesn't bring the tap back.
    const tappedBefore = nextLedger({ ...before, gotIt: [second] }, data({ ended: [merged("P1", 2), merged("P2", 3)] }), "me", new Map(), NOW, 30, 35);
    expect(withGotIt(tappedBefore, []).gotIt).toEqual([]);
    // A tap on an event the refresh dropped goes with it.
    expect(withGotIt({ ...after, events: [after.events[0]] }, [first, second]).gotIt).toEqual([first]);
  });
});

describe("ownership cycles", () => {
  it("HIS-07: a PR I took myself off is still mine until someone takes it, and that's who's named, when they took it", () => {
    const self = handover(subject("PullRequest", ["carol"], [assigned("me", "me", 50), unassigned("me", "me", 40), assigned("carol", "carol", 3)]), "me");
    expect(self).toMatchObject({ kind: "took_over", actor: "carol", at: hoursAgo(3) });
    const earlier = handover(subject("PullRequest", ["carol"], [unassigned("me", "dave", 40), assigned("carol", "carol", 3)]), "me");
    expect(earlier).toMatchObject({ kind: "took_over", actor: "carol", at: hoursAgo(3) });
  });

  it("HIS-07: an old removal from an earlier round doesn't name who took it this time", () => {
    const events = [unassigned("me", "dave", 90), assigned("me", "me", 60), unassigned("me", "alice", 4), assigned("carol", "alice", 4)];
    expect(handover(subject("Issue", ["carol"], events), "me")).toMatchObject({ kind: "handed", actor: "alice", to: "carol", at: hoursAgo(4) });
  });
});

describe("the ledger between refreshes", () => {
  const lookups = (...subjects: [string, AssignmentSubject | null][]): Lookups => new Map(subjects);

  it("HIS-07: on a first run, issues aren't missed but none count as gone; PRs others have are looked up once", () => {
    const now = data({ mine: [openPr("P1", "carol")], assigned: [issue("I1")] });
    expect(changeCandidates(EMPTY_LEDGER, now, "me")).toEqual(["P1"]);
    const ledger = nextLedger(EMPTY_LEDGER, now, "me", lookups(["P1", { ...subject("PullRequest", ["carol"], [assigned("carol", "dave", 2)]), id: "P1" }]), NOW, 30, 35);
    expect(ledger.assigned).toEqual({ I1: "acme/shop#5" });
    expect(ledger.handed).toEqual({ P1: "carol" });
    expect(ledger.events.map((event) => event.kind)).toEqual(["handed"]);
    // Asked once: the same hands aren't looked up again.
    expect(changeCandidates(ledger, now, "me")).toEqual([]);
  });

  it("HIS-07: an issue that leaves my assigned search is checked, and kept to check again when the lookup fails", () => {
    const before: ChangeLedger = { ...EMPTY_LEDGER, assigned: { I1: "acme/shop#5" } };
    const after = data({});
    expect(changeCandidates(before, after, "me")).toEqual(["I1"]);
    const failed = nextLedger(before, after, "me", lookups(), NOW, 30, 35);
    expect(failed.assigned).toEqual({ I1: "acme/shop#5" });
    const still = nextLedger(before, after, "me", lookups(["I1", { ...subject("Issue", ["me"], []), id: "I1" }]), NOW, 30, 35);
    expect(still).toMatchObject({ assigned: {}, events: [] });
  });

  it("HIS-06, HIS-07: catches up only within the window, keeps each event once, and drops an uncleared handover once the work is mine again", () => {
    const old = endedPr("P9", { mergedAt: hoursAgo(24 * 40), closedAt: hoursAgo(24 * 40) });
    const once = nextLedger(EMPTY_LEDGER, data({ ended: [endedPr("P1", {}), old] }), "me", lookups(), NOW, 30, 35);
    expect(once.events.map((event) => event.subjectId)).toEqual(["P1"]);
    expect(nextLedger(once, data({ ended: [endedPr("P1", {})] }), "me", lookups(), NOW, 30, 35).events).toHaveLength(1);

    const handed: ChangeLedger = { ...EMPTY_LEDGER, events: [{ ...once.events[0], id: "h", kind: "handed", subjectId: "P3", to: "carol" }] };
    const back = nextLedger(handed, data({ mine: [openPr("P3", "me")] }), "me", lookups(), NOW, 30, 35);
    expect(back).toMatchObject({ events: [], gotIt: [] });
    // Cleared into a week, it stays even when the work is mine again [HIS-06].
    const cleared = nextLedger({ ...handed, gotIt: ["h"] }, data({ mine: [openPr("P3", "me")] }), "me", lookups(), NOW, 30, 35);
    expect(cleared.events.map((event) => [event.id, event.returned])).toEqual([["h", true]]);
    expect(cleared.gotIt).toEqual(["h"]);
    // Mine again, then merged by dave: that's a merge note, not hidden behind the old handover [HIS-06, HIS-07].
    const merged = nextLedger(cleared, data({ ended: [endedPr("P3", { mergedAt: hoursAgo(1), closedAt: hoursAgo(1) })] }), "me", lookups(), NOW, 30, 35);
    expect(merged.events.map((event) => [event.kind, event.subjectId])).toContainEqual(["merged", "P3"]);
  });
});

describe("notes and History", () => {
  const config = AttentionConfig.parse({});
  const feed = { fetchedAt: NOW.toISOString(), refreshing: false, error: null };
  const meta = { feeds: { live: feed, history: feed }, scopes: [], sources: [], projectFilter: [], historyFilter: [], config, pending: 0 };
  const event = (kind: OthersChange["kind"], key: string, hours: number): OthersChange => ({
    id: `${kind}:${key}`,
    kind,
    subjectId: key,
    subject: "pr",
    key,
    repo: "acme/shop",
    number: 9,
    title: key,
    url: "u",
    actor: "dave",
    to: "carol",
    at: hoursAgo(hours),
  });
  const done = (key: string): Item => ({
    key,
    section: "done",
    kind: "pr",
    draft: false,
    repo: "acme/shop",
    number: 9,
    title: key,
    url: "u",
    chips: [],
    actions: [],
    children: [],
    target: { kind: "pr", repo: "acme/shop", number: 9, title: key, url: "u" },
    othersActivityAt: hoursAgo(1),
    closedAt: hoursAgo(1),
  });
  const ledger: ChangeLedger = { ...EMPTY_LEDGER, events: [event("merged", "acme/shop#1", 2), event("handed", "acme/shop#2", 5), event("closed", "acme/shop#3", 30)] };
  const attention: Attention = { login: "me", items: [], assigned: [], unclaimed: [] };

  it("HIS-07: unread notes sit at the top of History with Got it, don't count, and never touch Doing", () => {
    const view = buildView(attention, [], {}, meta, ledger, NOW);
    expect(view.doing).toEqual([]);
    expect(view.count).toBe(0);
    expect(view.history.filter((item) => item.section === "changed").map((item) => [item.change?.kind, item.actions])).toEqual([
      ["merged", ["got_it"]],
      ["handed", ["got_it"]],
      ["closed", ["got_it"]],
    ]);
    const cleared = buildView(attention, [], {}, meta, { ...ledger, gotIt: ledger.events.map((event) => event.id) }, NOW);
    expect(cleared.history.filter((item) => item.section === "changed")).toEqual([]);
    // A merge is the week's Finished, not repeated under its Changed by others [HIS-07].
    expect(cleared.history.filter((item) => item.section === "handed_off").map((item) => item.change?.kind)).toEqual(["handed", "closed"]);
  });

  it("HIS-07: a merge or issue close someone else did fills its week at once, with the finished words", () => {
    const closed: OthersChange = { ...event("issue_closed", "acme/shop#11", 6), subject: "issue", reason: "not_planned" };
    const view = buildView(attention, [], {}, meta, { ...EMPTY_LEDGER, events: [event("merged", "acme/shop#1", 2), closed] }, NOW);
    expect(view.history.filter((item) => item.section === "done").map((item) => [item.key, item.mergedBy, item.closedBy, item.notPlanned])).toEqual([
      ["acme/shop#1", "dave", undefined, undefined],
      ["acme/shop#11", undefined, "dave", true],
    ]);
    // The daily History fetch has the richer card, so it isn't shown twice.
    const fetched = { ...done("acme/shop#1"), mergedBy: "dave" };
    const withFeed = buildView(attention, [fetched], {}, meta, { ...EMPTY_LEDGER, events: [event("merged", "acme/shop#1", 2)] }, NOW);
    expect(withFeed.history.filter((item) => item.section === "done").map((item) => item.key)).toEqual(["acme/shop#1"]);
  });

  it("HIS-06: a handed-over PR isn't listed under the finished issue it closed either", () => {
    const issue: Item = { ...done("acme/shop#40"), kind: "issue", children: [{ key: "acme/shop#2", number: 2, title: "t", url: "u", draft: false, chips: [], attention: false }] };
    const view = buildView(attention, [issue], {}, meta, ledger, NOW);
    expect(view.history.find((item) => item.key === "acme/shop#40")?.children).toEqual([]);
  });

  it("HIS-06: History lists cleared closes and handovers, and a handed-over PR's later merge isn't my finished work", () => {
    const cleared = { ...ledger, gotIt: ledger.events.map((event) => event.id) };
    const view = buildView(attention, [done("acme/shop#2"), done("acme/shop#4")], {}, meta, cleared, NOW);
    expect(view.history.filter((item) => item.section === "done").map((item) => item.key)).toEqual(["acme/shop#4", "acme/shop#1"]);
    expect(view.history.filter((item) => item.section === "handed_off").map((item) => item.change?.kind)).toEqual(["handed", "closed"]);
  });

  it("HIS-07: older notes than mentionDays leave History's unread section", () => {
    expect(changeItems(ledger, NOW, 1, hoursAgo(1000)).notes.map((item) => item.change?.kind)).toEqual(["merged", "handed"]);
  });
});

describe("issues closed and PRs reopened by others", () => {
  it("HIS-07: someone else closing an issue assigned to me is a note, completed or not planned; my own close isn't", () => {
    expect(changeText(closedByOther(closedIssue(), "me")!, NOW)).toBe("closed by alice 6h ago as completed");
    expect(changeText(closedByOther(closedIssue({ stateReason: "NOT_PLANNED" }), "me")!, NOW)).toBe("closed by alice 6h ago as not planned");
    expect(closedByOther(closedIssue({ timelineItems: { nodes: [{ actor: { login: "me" } }] } }), "me")).toBeNull();
    const ledger = nextLedger(EMPTY_LEDGER, data({ closedIssues: [closedIssue()] }), "me", new Map(), NOW, 30, 35);
    expect(ledger.events.map((event) => [event.kind, event.reason, event.actor])).toEqual([["issue_closed", "completed", "alice"]]);
  });

  it("HIS-07: a PR Attention Span saw closed is tracked, and reopening by someone else replaces its close with a note", () => {
    const closed = endedPr("P1", { merged: false, mergedAt: null, mergedBy: null, timelineItems: { nodes: [{ actor: { login: "alice" } }] } });
    const before = nextLedger(EMPTY_LEDGER, data({ ended: [closed] }), "me", new Map(), NOW, 30, 35);
    expect(before.tracked.P1).toMatchObject({ key: "acme/shop#9" });
    // Still in the closed search: still closed, so not asked about [GH-01].
    expect(reopenCandidates(before, data({ ended: [closed] }))).toEqual([]);
    expect(reopenCandidates(before, data({}))).toEqual(["P1"]);
    const after = nextLedger(before, data({ ended: [closed] }), "me", new Map(), NOW, 30, 35, new Map([["P1", reopenSubject()]]));
    expect(after.tracked).toEqual({});
    expect(after.events.map((event) => [event.kind, event.actor])).toEqual([["reopened", "bob"]]);
    expect(changeText(after.events[0], NOW)).toBe("reopened by bob 1h ago");
    // The closed PR leaves its week with its close.
    expect(nextLedger(after, data({}), "me", new Map(), NOW, 30, 35).events.map((event) => event.kind)).toEqual(["reopened"]);
  });

  it("HIS-07: my own reopen is silent, a failed lookup waits, and old events don't replay as a reopen", () => {
    const closed = endedPr("P1", { merged: false, mergedAt: null, mergedBy: null });
    const before = nextLedger(EMPTY_LEDGER, data({ ended: [closed] }), "me", new Map(), NOW, 30, 35);
    const mine = nextLedger(before, data({}), "me", new Map(), NOW, 30, 35, new Map([["P1", reopenSubject({ timelineItems: { nodes: [{ createdAt: hoursAgo(1), actor: { login: "me" } }] } })]]));
    // My own reopen is no note, but the close it undid leaves its week all the same.
    expect(mine.events).toEqual([]);
    expect(mine.tracked).toEqual({});
    // Nothing looked up (the batch failed): still tracked for next time.
    expect(nextLedger(before, data({ ended: [closed] }), "me", new Map(), NOW, 30, 35).tracked.P1).toBeDefined();
    // Still closed when looked up: keep watching it.
    expect(nextLedger(before, data({}), "me", new Map(), NOW, 30, 35, new Map([["P1", reopenSubject({ state: "CLOSED" })]])).tracked.P1).toBeDefined();
    // A ledger with an old close but nothing tracked has no reopen to announce.
    expect(reopenCandidates({ ...before, tracked: {} })).toEqual([]);
    expect(reopened({ key: "acme/shop#9", number: 9, title: "Retry", url: "u", repo: "acme/shop", closedAt: hoursAgo(60) }, reopenSubject({ state: "MERGED" }), "me")).toBeNull();
  });

  it("HIS-07, GH-01: a merged PR stops being tracked, and nothing past the window is tracked, looked up or not", () => {
    const closed = endedPr("P1", { merged: false, mergedAt: null, mergedBy: null });
    const before = nextLedger(EMPTY_LEDGER, data({ ended: [closed] }), "me", new Map(), NOW, 30, 35);
    expect(nextLedger(before, data({}), "me", new Map(), NOW, 30, 35, new Map([["P1", reopenSubject({ state: "MERGED" })]])).tracked).toEqual({});
    const later = new Date(NOW.getTime() + 40 * 86_400_000);
    expect(nextLedger(before, data({}), "me", new Map(), later, 30, 35, new Map([["P1", reopenSubject({ state: "CLOSED" })]])).tracked).toEqual({});
  });

  it("ATT-22: my own unmerged closes are finished work for Wrap up; others' and merges aren't", () => {
    const mine = endedPr("P1", { merged: false, mergedAt: null, mergedBy: null, timelineItems: { nodes: [{ actor: { login: "me" } }] } });
    const theirs = endedPr("P2", { number: 10, merged: false, mergedAt: null, mergedBy: null, timelineItems: { nodes: [{ actor: { login: "alice" } }] } });
    expect(ownClosed(data({ ended: [mine, theirs, endedPr("P3", {})] }), "me").map((item) => [item.key, item.closedUnmerged])).toEqual([["acme/shop#9", true]]);
  });

  it("ATT-22: an archive acknowledges exactly the events on its work at that moment", () => {
    const ledger = nextLedger(EMPTY_LEDGER, data({ ended: [endedPr("P1", {}), endedPr("P2", {})], closedIssues: [closedIssue()] }), "me", new Map(), NOW, 30, 35);
    expect(ledger.events).toHaveLength(3);
    const target = ledger.events[0];
    const after = acknowledge(ledger, [target.key]);
    const marked = new Set(after.events.filter((event) => after.gotIt.includes(event.id)).map((event) => event.id));
    expect([...marked]).toEqual(ledger.events.filter((event) => event.key === target.key).map((event) => event.id));
    expect(after.gotIt).toHaveLength(ledger.events.filter((event) => event.key === target.key).length);
    expect(acknowledge(after, ["acme/shop#999"]).gotIt).toEqual(after.gotIt);
  });

  it("HIS-07, ATT-22: an archive in Paseo leaves what others did after it unread", () => {
    const ledger = nextLedger(EMPTY_LEDGER, data({ ended: [endedPr("P1", {})] }), "me", new Map(), NOW, 30, 35);
    const [event] = ledger.events;
    expect(acknowledge(ledger, [event.key], new Date(Date.parse(event.at) - 1000).toISOString()).gotIt).toEqual([]);
    expect(acknowledge(ledger, [event.key], event.at).gotIt).toEqual([event.id]);
  });
});
