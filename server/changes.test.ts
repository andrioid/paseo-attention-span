import { describe, expect, it } from "vitest";
import type { Attention, Item } from "../shared/attention";
import { changeText, type OthersChange } from "../shared/changes";
import { AttentionConfig } from "../shared/config";
import { type ChangeLedger, changeCandidates, changeItems, EMPTY_LEDGER, ended, handover, type Lookups, nextLedger, withGotIt } from "./changes";
import type { AssignmentEvent, AssignmentSubject, EndedPullRequest, LiveResult, PickableNode, PullRequestNode } from "./github-types";
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
function data(parts: { mine?: PullRequestNode[]; assigned?: PickableNode[]; ended?: EndedPullRequest[] }): Pick<LiveResult, "mine" | "assigned" | "ended"> {
  return { mine: { nodes: parts.mine ?? [] }, assigned: { nodes: parts.assigned ?? [] }, ended: { nodes: parts.ended ?? [] } };
}

describe("who took my work out of my hands", () => {
  it("ATT-21: someone who unassigns me and assigns themselves took over", () => {
    const change = handover(subject("PullRequest", ["phil"], [assigned("me", "me", 30), unassigned("me", "phil", 5), assigned("phil", "phil", 5)]), "me");
    expect(change).toMatchObject({ kind: "took_over", actor: "phil", to: "phil", subject: "pr", at: hoursAgo(5) });
    expect(changeText(change!, NOW)).toBe("phil took over 5h ago");
  });

  it("ATT-21: someone who moves it to a third person handed it to them; the one named is who took me off", () => {
    const change = handover(subject("Issue", ["carol"], [assigned("me", "me", 30), assigned("carol", "dave", 6), unassigned("me", "alice", 5)]), "me");
    expect(change).toMatchObject({ kind: "handed", actor: "alice", to: "carol" });
    expect(changeText(change!, NOW)).toBe("alice handed it to carol 5h ago");
  });

  it("ATT-21: my PR with nobody assigned that someone assigns to another is handed over by whoever assigned them", () => {
    expect(handover(subject("PullRequest", ["carol"], [assigned("carol", "dave", 3)]), "me")).toMatchObject({ kind: "handed", actor: "dave", to: "carol" });
  });

  it("ATT-21: an issue I'm taken off with nobody on it says who unassigned me", () => {
    const change = handover(subject("Issue", [], [assigned("me", "me", 30), unassigned("me", "bob", 72)]), "me");
    expect(change).toMatchObject({ kind: "unassigned", actor: "bob" });
    expect(changeText(change!, NOW)).toBe("bob unassigned you 3d ago");
  });

  it("ATT-21: stays silent for my own doing, work still mine, an unproven issue, or an issue closed by now", () => {
    expect(handover(subject("PullRequest", ["carol"], [unassigned("me", "me", 2), assigned("carol", "me", 2)]), "me")).toBeNull();
    expect(handover(subject("PullRequest", ["me", "carol"], [assigned("carol", "dave", 2)]), "me")).toBeNull();
    // A PR of mine that nobody has is still mine.
    expect(handover(subject("PullRequest", [], [unassigned("me", "dave", 2)]), "me")).toBeNull();
    // An issue that left my search without an unassign event: search lag or a coverage change, not a handover.
    expect(handover(subject("Issue", [], []), "me")).toBeNull();
    expect(handover(subject("Issue", [], [unassigned("me", "bob", 2)], "CLOSED"), "me")).toBeNull();
  });

  it("ATT-21: names nobody when GitHub doesn't say who", () => {
    expect(changeText(handover(subject("Issue", [], [unassigned("me", null, 1)]), "me")!, NOW)).toBe("unassigned you 1h ago");
  });
});

describe("my PRs others merged or closed", () => {
  it("ATT-21: a merge or a close by someone else is a note; my own isn't", () => {
    expect(changeText(ended(endedPr("P1", {}), "me")!, NOW)).toBe("merged by dave 2h ago");
    expect(ended(endedPr("P1", { mergedBy: { login: "Me" } }), "me")).toBeNull();
    const closed = endedPr("P2", { merged: false, mergedAt: null, mergedBy: null, timelineItems: { nodes: [{ actor: { login: "alice" } }] } });
    expect(changeText(ended(closed, "me")!, NOW)).toBe("closed by alice 2h ago, not merged");
    expect(ended({ ...closed, timelineItems: { nodes: [{ actor: { login: "me" } }] } }, "me")).toBeNull();
  });

  it("ATT-21: a PR handed over before it ended is a handover, not a merge; one assigned after it ended is still my merge", () => {
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

  it("ATT-21, HIS-06: events are kept for keepDays, then dropped with their Got it", () => {
    const kept = nextLedger(EMPTY_LEDGER, data({ ended: [merged("P1", 24 * 20)] }), "me", new Map(), NOW, 30, 35);
    const tapped = { ...kept, gotIt: [kept.events[0].id] };
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    expect(nextLedger(tapped, data({}), "me", new Map(), later, 30, 35)).toMatchObject({ events: [], gotIt: [] });
    expect(nextLedger(tapped, data({}), "me", new Map(), NOW, 30, 35).gotIt).toEqual(tapped.gotIt);
  });

  it("ATT-21: a Got it tapped while a refresh ran survives it, and Undo while it ran too", () => {
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
  it("ATT-21: a PR I took myself off is still mine until someone takes it, and that's who's named, when they took it", () => {
    const self = handover(subject("PullRequest", ["carol"], [assigned("me", "me", 50), unassigned("me", "me", 40), assigned("carol", "carol", 3)]), "me");
    expect(self).toMatchObject({ kind: "took_over", actor: "carol", at: hoursAgo(3) });
    const earlier = handover(subject("PullRequest", ["carol"], [unassigned("me", "dave", 40), assigned("carol", "carol", 3)]), "me");
    expect(earlier).toMatchObject({ kind: "took_over", actor: "carol", at: hoursAgo(3) });
  });

  it("ATT-21: an old removal from an earlier round doesn't name who took it this time", () => {
    const events = [unassigned("me", "dave", 90), assigned("me", "me", 60), unassigned("me", "alice", 4), assigned("carol", "alice", 4)];
    expect(handover(subject("Issue", ["carol"], events), "me")).toMatchObject({ kind: "handed", actor: "alice", to: "carol", at: hoursAgo(4) });
  });
});

describe("the ledger between refreshes", () => {
  const lookups = (...subjects: [string, AssignmentSubject | null][]): Lookups => new Map(subjects);

  it("ATT-21: on a first run, issues aren't missed but none count as gone; PRs others have are looked up once", () => {
    const now = data({ mine: [openPr("P1", "carol")], assigned: [issue("I1")] });
    expect(changeCandidates(EMPTY_LEDGER, now, "me")).toEqual(["P1"]);
    const ledger = nextLedger(EMPTY_LEDGER, now, "me", lookups(["P1", { ...subject("PullRequest", ["carol"], [assigned("carol", "dave", 2)]), id: "P1" }]), NOW, 30, 35);
    expect(ledger.assigned).toEqual({ I1: "acme/shop#5" });
    expect(ledger.handed).toEqual({ P1: "carol" });
    expect(ledger.events.map((event) => event.kind)).toEqual(["handed"]);
    // Asked once: the same hands aren't looked up again.
    expect(changeCandidates(ledger, now, "me")).toEqual([]);
  });

  it("ATT-21: an issue that leaves my assigned search is checked, and kept to check again when the lookup fails", () => {
    const before: ChangeLedger = { ...EMPTY_LEDGER, assigned: { I1: "acme/shop#5" } };
    const after = data({});
    expect(changeCandidates(before, after, "me")).toEqual(["I1"]);
    const failed = nextLedger(before, after, "me", lookups(), NOW, 30, 35);
    expect(failed.assigned).toEqual({ I1: "acme/shop#5" });
    const still = nextLedger(before, after, "me", lookups(["I1", { ...subject("Issue", ["me"], []), id: "I1" }]), NOW, 30, 35);
    expect(still).toMatchObject({ assigned: {}, events: [] });
  });

  it("ATT-21: catches up only within the window, keeps each event once, and drops a handover once the work is mine again", () => {
    const old = endedPr("P9", { mergedAt: hoursAgo(24 * 40), closedAt: hoursAgo(24 * 40) });
    const once = nextLedger(EMPTY_LEDGER, data({ ended: [endedPr("P1", {}), old] }), "me", lookups(), NOW, 30, 35);
    expect(once.events.map((event) => event.subjectId)).toEqual(["P1"]);
    expect(nextLedger(once, data({ ended: [endedPr("P1", {})] }), "me", lookups(), NOW, 30, 35).events).toHaveLength(1);

    const handed: ChangeLedger = { ...EMPTY_LEDGER, events: [{ ...once.events[0], id: "h", kind: "handed", subjectId: "P3", to: "carol" }], gotIt: ["h"] };
    const back = nextLedger(handed, data({ mine: [openPr("P3", "me")] }), "me", lookups(), NOW, 30, 35);
    expect(back).toMatchObject({ events: [], gotIt: [] });
  });
});

describe("notes and History", () => {
  const config = AttentionConfig.parse({});
  const feed = { fetchedAt: NOW.toISOString(), refreshing: false, error: null };
  const meta = { feeds: { live: feed, history: feed }, scopes: [], sources: [], projectFilter: [], config, pending: 0 };
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

  it("ATT-21: notes sit last in Doing with Got it, don't count, and keep Doing from looking clear until cleared", () => {
    const view = buildView(attention, [], {}, meta, ledger, NOW);
    expect(view.doing.map((section) => section.id)).toEqual(["changed"]);
    expect(view.doing[0].items.map((item) => item.actions)).toEqual([["got_it"], ["got_it"], ["got_it"]]);
    expect(view.count).toBe(0);
    const cleared = buildView(attention, [], {}, meta, { ...ledger, gotIt: ledger.events.map((event) => event.id) }, NOW);
    expect(cleared.doing).toEqual([]);
  });

  it("HIS-06: a handed-over PR isn't listed under the finished issue it closed either", () => {
    const issue: Item = { ...done("acme/shop#40"), kind: "issue", children: [{ key: "acme/shop#2", number: 2, title: "t", url: "u", draft: false, chips: [], attention: false }] };
    const view = buildView(attention, [issue], {}, meta, ledger, NOW);
    expect(view.history.find((item) => item.key === "acme/shop#40")?.children).toEqual([]);
  });

  it("HIS-06: History lists what was closed unmerged or handed off, and a handed-over PR's later merge isn't my finished work", () => {
    const view = buildView(attention, [done("acme/shop#2"), done("acme/shop#4")], {}, meta, ledger, NOW);
    expect(view.history.filter((item) => item.section === "done").map((item) => item.key)).toEqual(["acme/shop#4"]);
    expect(view.history.filter((item) => item.section === "handed_off").map((item) => item.change?.kind)).toEqual(["handed", "closed"]);
  });

  it("ATT-21: older notes than mentionDays leave Doing", () => {
    expect(changeItems(ledger, NOW, 1, hoursAgo(1000)).doing.map((item) => item.change?.kind)).toEqual(["merged", "handed"]);
  });
});
