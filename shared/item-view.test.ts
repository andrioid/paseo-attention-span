import { describe, expect, it } from "vitest";
import type { ActionId, FailingChecks, Item, SubRow, WaitingOn } from "./attention";
import { actionDetail, alsoWaitingOn, cardStack, cardWhen, copiesLink, nudgeLead, rerunState, sessionBadge, sessionSignal, type SheetStep, sheetPlan, soleStep, stackMetaChips, tabCounts, waitChips } from "./item-view";
import { ACTION_SESSION } from "./prompts";
import { agent, change, clock, item } from "./test-builders";

const { now, hoursAgo, daysAgo } = clock(new Date("2026-11-13T12:00:00Z"));

// A sheet's lines as they read, top to bottom; work kept apart below is marked.
function lines(steps: SheetStep[]): string[] {
  return steps.map((step) => {
    switch (step.kind) {
      case "session":
        return `${step.label} (session ${step.agent.id})`;
      case "ask":
        return `${step.label}…`;
      case "rerun":
        return step.label;
      case "action":
        return step.housekeeping ? `${step.label} [apart]` : step.label;
      case "github":
        return step.pr ? `Open issue | Open PR #${step.pr.number}` : "Open on GitHub";
      case "start":
        return step.any ? "Start another session…" : "Start a session…";
      case "dismiss":
        return "Dismiss [apart]";
    }
  });
}

const row = (number: number, fields: Partial<SubRow> = {}): SubRow => ({ key: `o/r#${number}`, number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, draft: false, chips: [], attention: false, ...fields });
const stackTarget = (key: string, stack: { number: number; review?: true }[]) => {
  const base = item(key, "review");
  return { ...base.target, baseRefName: "main", stack: stack.map((pr) => ({ head: `b${pr.number}`, base: "main", ...pr })) };
};

describe("an item's sheet", () => {
  it("SES-02, SES-03: an action that starts a session asks first, until its session runs; then the session takes its line", () => {
    const ci = item("o/r#5", "ci", { actions: ["fix", "rerun"] });
    expect(lines(sheetPlan(ci, []))).toEqual(["Fix CI…", "Rerun failed jobs", "Open on GitHub", "Start a session…", "Dismiss [apart]"]);
    const fixing = agent("a1", "o/r#5", { kind: "fix", status: "running" });
    expect(lines(sheetPlan(ci, [fixing]))).toEqual(["Fix CI (session a1)", "Rerun failed jobs", "Open on GitHub", "Start another session…", "Dismiss [apart]"]);
  });

  it("SES-03, ATT-07: sessions no action of the item would start lead, named for what started them", () => {
    const ci = item("o/r#5", "ci", { actions: ["fix"] });
    const loose = agent("a0", "o/r#5");
    const rebase = agent("a2", "o/r#5", { kind: "rebase" });
    expect(lines(sheetPlan(ci, [loose, rebase])).slice(0, 3)).toEqual(["Continue session (session a0)", "Rebase (session a2)", "Fix CI…"]);
  });

  it("ATT-13, SES-02: every action that starts a session asks first; the rest act on GitHub", () => {
    const all = Object.keys(ACTION_SESSION) as ActionId[];
    const others: ActionId[] = ["update", "ready", "merge", "automerge", "request_review", "acknowledge", "got_it", "reply", "close"];
    const steps = sheetPlan(item("o/r#5", "ci", { actions: [...all, ...others] }), []);
    expect(steps.filter((step) => step.kind === "ask").map((step) => step.kind === "ask" && step.action)).toEqual(all);
    expect(steps.filter((step) => step.kind === "action").map((step) => step.kind === "action" && step.action)).toEqual(others);
  });

  it("ATT-04: a stack is reviewed and rebased as one, naming the PRs that ask for my review", () => {
    const review = item("o/r#1", "review", { actions: ["review"], target: stackTarget("o/r#1", [{ number: 1, review: true }, { number: 2, review: true }, { number: 3 }]) });
    expect(lines(sheetPlan(review, []))[0]).toBe("Review stack…");
    expect(actionDetail("review", review)).toBe("An agent reviews #1, #2 in a checkout of the stack's top and reports back. Nothing is posted");
    const mine = item("o/r#1", "upstream", { actions: ["rebase"], target: stackTarget("o/r#1", [{ number: 1 }, { number: 2 }]) });
    expect(lines(sheetPlan(mine, []))[0]).toBe("Rebase stack…");
    expect(actionDetail("rebase", mine)).toBe("An agent rebases the stack onto main. It pushes only if there were no conflicts");
    const single = item("o/r#1", "upstream", { actions: ["rebase"], target: { ...stackTarget("o/r#1", []), stack: undefined } });
    expect(lines(sheetPlan(single, []))[0]).toBe("Rebase…");
  });

  it("ATT-12: an issue opens on GitHub with the PR its actions apply to beside it, or in History the first PR that closed it", () => {
    const pr = { kind: "pr" as const, repo: "o/r", number: 103, title: "Fix", url: "https://github.com/o/r/pull/103" };
    const issue = item("o/r#7", "ci", { kind: "issue", target: pr, actions: ["fix"] });
    expect(lines(sheetPlan(issue, []))).toContain("Open issue | Open PR #103");
    const done = item("o/r#7", "done", { kind: "issue", closedAt: hoursAgo(2), children: [row(41), row(42)] });
    done.target = { ...done.target, kind: "issue" };
    expect(lines(sheetPlan(done, []))).toEqual(["Open issue | Open PR #41"]);
    expect(lines(sheetPlan(item("o/r#8", "ci"), []))).toContain("Open on GitHub");
  });

  it("SES-03, HIS-07: nothing to start once it's closed or out of my hands, and a note is cleared with Got it, not dismissed", () => {
    expect(lines(sheetPlan(item("o/r#5", "done", { closedAt: hoursAgo(1) }), []))).toEqual(["Open on GitHub"]);
    const note = item("o/r#5", "changed", { actions: ["got_it"], change: change("merged", "o/r#5") });
    expect(lines(sheetPlan(note, []))).toEqual(["Got it", "Open on GitHub"]);
  });

  it("ATT-06: Dismiss and closing a draft sit apart below the work; Dismiss only in Doing", () => {
    expect(lines(sheetPlan(item("o/r#5", "drafts", { actions: ["refresh", "close"] }), []))).toEqual(["Refresh draft…", "Close draft [apart]", "Open on GitHub", "Start a session…", "Dismiss [apart]"]);
    expect(lines(sheetPlan(item("o/r#5", "wait_review"), []))).not.toContain("Dismiss [apart]");
  });

  it("ATT-06: the card shows the sheet's one action in place of ›, not counting a quiet start", () => {
    const waiting = soleStep(sheetPlan(item("o/r#5", "wait_review"), []));
    expect(waiting && lines([waiting])).toEqual(["Open on GitHub"]);
    expect(soleStep(sheetPlan(item("o/r#5", "done", { closedAt: hoursAgo(1) }), []))?.kind).toBe("github");
    // Doing always has Dismiss too; a note has Got it.
    expect(soleStep(sheetPlan(item("o/r#5", "ci"), []))).toBeUndefined();
    expect(soleStep(sheetPlan(item("o/r#5", "changed", { actions: ["got_it"], change: change("merged", "o/r#5") }), []))).toBeUndefined();
  });
});

describe("Rerun failed jobs' line", () => {
  const failing = (checks: { name: string; rerunnable: boolean }[], runs = [{ id: 11, attempt: 1 }]): FailingChecks[] => [{ pr: 5, checks, runs }];

  it("PRS-09: says it's checking until the checks are in, and can be pressed meanwhile", () => {
    expect(rerunState(undefined)).toEqual({ state: "checking", detail: "Checking which checks failed…" });
    expect(rerunState({ isLoading: true })).toEqual({ state: "checking", detail: "Checking which checks failed…" });
  });

  it("PRS-09: says why nothing can be rerun", () => {
    expect(rerunState({ isLoading: false })).toEqual({ state: "unknown", detail: "Couldn't find the failing checks" });
    expect(rerunState({ isLoading: false, data: { failing: failing([], []) } })).toEqual({ state: "none", detail: "No failed checks on the latest commit" });
    const status = rerunState({ isLoading: false, data: { failing: failing([{ name: "deploy", rerunnable: false }], []) } });
    expect(status.state === "elsewhere" && status.detail).toBe("1 failed, none in GitHub Actions, so none can be rerun here");
  });

  it("PRS-09: reruns the failed GitHub Actions runs", () => {
    const state = rerunState({ isLoading: false, data: { failing: failing([{ name: "lint", rerunnable: true }], [{ id: 11, attempt: 1 }, { id: 12, attempt: 2 }]) } });
    expect(state.state === "ready" && state.runIds).toEqual([11, 12]);
  });
});

describe("a card", () => {
  const who = (login: string, team = false): WaitingOn => ({ login, team, since: hoursAgo(3) });

  it("ATT-11: in Waiting it says why and how long; once too long, the age turns amber and explains itself", () => {
    const waiting = item("o/r#5", "wait_review", { wait: { reason: "review", since: hoursAgo(2) } });
    expect(waitChips(waiting, true, 3, now)).toEqual([
      { text: "review", tone: "neutral" },
      { text: "2h", tone: "neutral" },
    ]);
    // Doing says what's mine to do instead.
    expect(waitChips(waiting, false, 3, now)).toEqual([]);
    const stale = item("o/r#5", "wait_answer", { wait: { reason: "question", since: daysAgo(4), tooLong: true } });
    expect(waitChips(stale, true, 1, now)[1]).toEqual({ text: "4d", tone: "warn", icon: "hourglass", hint: "Waited too long: 4d since you asked, more than 1 day" });
  });

  it("WAI-03: a nudge line leads with why and how long", () => {
    expect(nudgeLead(item("o/r#5", "wait_review", { wait: { reason: "review", since: hoursAgo(2) } }), now)).toBe("Review 2h");
    expect(nudgeLead(item("o/r#5", "wait_ci", { wait: { since: hoursAgo(5) } }), now)).toBe("5h");
  });

  it("WAI-02: under one person's group, the card names whom else it waits on", () => {
    const shared = item("o/r#5", "wait_review", { waitingOn: [who("Dave"), who("erin"), who("dave", true)] });
    expect(alsoWaitingOn(shared, who("dave"))).toEqual(["erin", "dave"]);
    expect(alsoWaitingOn(shared, undefined)).toEqual([]);
  });

  it("HIS-05, HIS-07: says how it finished, and who did it when it wasn't me, in Wrap up's words", () => {
    expect(cardWhen(item("o/r#5", "done", { closedAt: hoursAgo(2), mergedBy: "dave" }), now)).toBe("merged 2h ago by dave");
    expect(cardWhen(item("o/r#5", "done", { kind: "issue", closedAt: hoursAgo(3), notPlanned: true }), now)).toBe("closed 3h ago as not planned");
    expect(cardWhen(item("o/r#5", "changed", { change: change("merged", "o/r#5", { at: hoursAgo(1) }) }), now)).toBe("merged by dave 1h ago");
    expect(cardWhen(item("o/r#5", "ci"), now)).toBeUndefined();
  });

  it("ATT-15: History's cards copy their link, apart from unread notes", () => {
    expect(copiesLink(item("o/r#5", "done", { closedAt: hoursAgo(1) }))).toBe(true);
    expect(copiesLink(item("o/r#5", "changed", { change: change("merged", "o/r#5") }))).toBe(false);
    expect(copiesLink(item("o/r#5", "ci"))).toBe(false);
  });

  it("ATT-04, ATT-06: shows the stack's PRs that need attention, with the PR an issue's actions apply to, whose chips it says once", () => {
    const target = { kind: "pr" as const, repo: "o/r", number: 2, title: "B", url: row(2).url };
    const issue: Item = item("o/r#9", "ci", {
      kind: "issue",
      target,
      chips: [{ text: "PR #2", tone: "neutral" }, { text: "stack of 3", tone: "neutral" }, { text: "CI failing", tone: "bad" }, { text: "3 behind", tone: "neutral" }],
      children: [row(1), row(2, { chips: [{ text: "CI failing", tone: "bad" }] }), row(3)],
    });
    const { rows, target: tinted } = cardStack(issue);
    expect(rows.map((one) => one.number)).toEqual([2]);
    expect(tinted?.number).toBe(2);
    expect(stackMetaChips(issue, tinted).map((chip) => chip.text)).toEqual(["3 behind"]);
    // Nothing needing attention: no stack line, and the chips stay on the card.
    const calm = { ...issue, children: [row(1), row(2), row(3)] };
    expect(cardStack(calm).rows).toEqual([]);
    expect(stackMetaChips(calm, cardStack(calm).target)).toHaveLength(4);
  });
});

describe("tab counts", () => {
  it("ATT-09, ATT-22: Doing counts Wrap up's rows; Waiting counts work waiting on several people once; History counts finished work", () => {
    const shared = item("o/r#5", "wait_review");
    const view = {
      count: 2,
      history: [item("o/r#1", "done"), item("o/r#2", "changed")],
      waiting: [{ who: { login: "dave", team: false, since: hoursAgo(1) }, items: [shared] }, { who: { login: "erin", team: false, since: hoursAgo(1) }, items: [shared, item("o/r#6", "wait_review")] }],
      assigned: [],
      unclaimed: [],
    };
    const wrap = [{ ...item("wrap:o/r#1", "wrap"), section: "wrap" as const, wrap: { itemKey: "o/r#1", keys: ["o/r#1"], finish: "", sessions: [] } }];
    expect(tabCounts(view, wrap)).toEqual({ history: 1, doing: 3, waiting: 2, next: 0 });
  });
});

describe("a session's state", () => {
  it.each([
    ["needs me, even while working", { status: "running", requiresAttention: true }, "agent needs you", "warn", "needs you"],
    ["working", { status: "running" }, "agent working", "good", "working"],
    ["starting up, as working", { status: "initializing" }, "agent working", "good", "working"],
    ["failed", { status: "error" }, "agent failed", "bad", "failed"],
    ["idle", { status: "idle" }, "agent idle", "neutral", "idle"],
  ])("ATT-07, SES-03: a session that's %s says so on its card and its sheet line", (_, fields, chip, tone, badge) => {
    const session = agent("a", "o/r#1", fields);
    expect(sessionSignal(session)).toEqual({ text: chip, tone });
    expect(sessionBadge(session)).toEqual({ text: badge, tone });
  });
});
