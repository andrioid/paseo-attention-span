// What an item's card and sheet say and offer, as plain data: client/attention-screen.tsx draws it and wires the presses
// [ATT-05, ATT-06].
import { type ActionId, type AgentSummary, type AttentionView, type Chip, type FailingChecks, isWorking, type Item, looseSessions, ownStack, SECTIONS, type SubRow, type TabId, type WaitingOn, type WrapItem } from "./attention";
import { summarizeRerun } from "./checks";
import type { SessionKind } from "./config";
import { ago } from "./format";
import { sameName } from "./names";
import { ACTION_SESSION } from "./prompts";
import { doingCount, finishText } from "./wrap-up";

// A session's state, as a chip on its card: needing me beats working [ATT-07].
export function sessionSignal(agent: AgentSummary): Chip {
  if (agent.requiresAttention) return { text: "agent needs you", tone: "warn" };
  if (isWorking(agent)) return { text: "agent working", tone: "good" };
  if (agent.status === "error") return { text: "agent failed", tone: "bad" };
  return { text: "agent idle", tone: "neutral" };
}

// The same state as a badge on the session's line in a sheet, where the line already says it's a session [SES-03, ATT-07].
export function sessionBadge(agent: AgentSummary): Chip {
  const signal = sessionSignal(agent);
  return { ...signal, text: signal.text.replace(/^agent /, "") };
}

export function actionLabel(action: ActionId, item: Item): string {
  // Review takes the whole stack; Rebase, my PRs in it [ATT-04].
  const stacked = ownStack(item.target).length > 1;
  return {
    reply: "Reply ↗",
    acknowledge: "Acknowledge",
    review: (item.target.stack?.length ?? 0) > 1 ? "Review stack" : "Review",
    fix: "Fix CI",
    rerun: "Rerun failed jobs",
    address: "Address comments",
    update: "Update branch",
    rebase: stacked ? "Rebase stack" : "Rebase",
    refresh: "Refresh draft",
    ready: "Ready for review",
    request_review: "Request review",
    automerge: "Auto-merge",
    merge: "Merge",
    close: "Close draft",
    start: "Start",
    got_it: "Got it",
  }[action];
}

// What an action will do, in the sheet, so pressing it makes sense [ATT-06]. Rerun's comes from the fetched checks.
export function actionDetail(action: Exclude<ActionId, "rerun">, item: Item): string {
  const { target } = item;
  const pr = `#${target.number}`;
  const base = target.baseRefName ?? target.defaultBranch ?? "its base";
  const stacked = ownStack(target).length > 1;
  const asking = (target.stack ?? []).filter((p) => p.review);
  const comments = item.person?.comments ?? [];
  return {
    reply: item.person ? `Opens ${item.person.login}'s comment on GitHub` : "Opens it on GitHub",
    acknowledge:
      comments.length === 1 ? `Reacts to ${comments[0].author}'s comment, which clears it` : `Pick which of the ${comments.length} waiting comments to react to`,
    review:
      (target.stack?.length ?? 0) > 1
        ? `An agent reviews ${asking.map((p) => `#${p.number}`).join(", ") || "the stack"} in a checkout of the stack's top and reports back. Nothing is posted`
        : "An agent reviews the PR in a checkout and reports back. Nothing is posted",
    fix: "An agent reads the failing logs and commits a fix, without pushing",
    address: "An agent works through the unresolved comments and applies the trivial ones, without pushing",
    update: `GitHub rebases ${pr} onto ${base}`,
    rebase: `An agent rebases ${stacked ? "the stack" : pr} onto ${base}. It pushes only if there were no conflicts`,
    refresh: `An agent rebases the draft onto ${base} and says what it still needs`,
    ready: `Takes ${pr} out of draft, then asks who should review it`,
    request_review: `Pick people or teams to review ${pr}`,
    automerge: `GitHub merges ${pr} into ${base} (${target.mergeMethod}) once checks pass`,
    merge: `Merges ${pr} into ${base} (${target.mergeMethod}) now`,
    close: `Closes ${pr}. A comment is posted only if you write one`,
    start: "An agent reads the issue and proposes a plan",
    got_it: "Clears this note. Nothing changes on GitHub",
  }[action];
}

// A session is named for what started it; one of no kind, or a Start's, just continues.
export const sessionLabel = (kind: SessionKind | undefined, item: Item) => (kind && kind !== "start" ? actionLabel(kind, item) : "Continue session");

// A session on an item that has no session action of its own starts with this prompt; it's editable first.
export const fallbackKind = (item: Item): SessionKind => (item.target.kind === "issue" ? "start" : "review");

// One line of an item's sheet, top to bottom; the client draws each and wires its press [ATT-06].
export type SheetStep =
  // A running session, in the line of what started it: it opens it [SES-03, ATT-07].
  | { kind: "session"; agent: AgentSummary; label: string }
  // A session action that asks first, with "…": the card's button is the one-tap start [SES-01, SES-02].
  | { kind: "ask"; action: ActionId; session: SessionKind; label: string; detail: string }
  // Rerun failed jobs, whose line comes from the fetched checks [PRS-09].
  | { kind: "rerun"; label: string }
  // A change on GitHub; closing it sits apart, below the work [ATT-06].
  | { kind: "action"; action: Exclude<ActionId, "rerun">; label: string; detail: string; housekeeping: boolean }
  // Open on GitHub, with an issue's PR beside it [ATT-12].
  | { kind: "github"; pr?: { number: number; url: string; stack?: { number: number }[] } }
  // Another session only on purpose: quiet, near the end [SES-02, SES-03].
  | { kind: "start"; any: boolean; session: SessionKind }
  | { kind: "dismiss" };

// Everything an item's sheet offers [ATT-06].
export function sheetPlan(item: Item, sessions: AgentSummary[]): SheetStep[] {
  // Sessions none of its actions would start lead, needs me first [SES-03].
  const kinds = item.actions.flatMap((action) => ACTION_SESSION[action] ?? []);
  const steps: SheetStep[] = looseSessions(sessions, kinds).map((agent) => ({ kind: "session", agent, label: sessionLabel(agent.kind, item) }));
  for (const action of item.actions) {
    const session = ACTION_SESSION[action];
    const label = actionLabel(action, item);
    if (session) {
      // An action's session takes its line once it runs, so work on it stays in one place [SES-03].
      const running = sessions.filter((agent) => agent.kind === session);
      if (running.length) steps.push(...running.map((agent) => ({ kind: "session" as const, agent, label: sessionLabel(session, item) })));
      else steps.push({ kind: "ask", action, session, label, detail: actionDetail(action as Exclude<ActionId, "rerun">, item) });
    } else if (action === "rerun") {
      steps.push({ kind: "rerun", label });
    } else {
      steps.push({ kind: "action", action, label, detail: actionDetail(action, item), housekeeping: action === "close" });
    }
  }
  // Anything Attention Span doesn't cover [ATT-12], with an issue's PR beside it: the one its actions apply to, or in
  // History, where an issue is its own target, the first of the PRs that closed it.
  const pr = targetUrl(item) && item.target.kind === "pr" ? item.target : item.kind === "issue" && item.children[0] ? item.children[0] : undefined;
  steps.push({ kind: "github", ...(pr ? { pr } : {}) });
  // Nothing's left to start on once it's merged or closed, or out of my hands; a note is cleared with Got it, not dismissed [HIS-07].
  if (!item.closedAt && !item.change) steps.push({ kind: "start", any: sessions.length > 0, session: fallbackKind(item) });
  if (SECTIONS[item.section].tab === "doing" && !item.change) steps.push({ kind: "dismiss" });
  return steps;
}

// A sheet with one action is a wasted tap: the card shows that action instead of ›. Starting another session is quiet, so
// it doesn't count [ATT-06].
export function soleStep(steps: SheetStep[]): SheetStep | undefined {
  const loud = steps.filter((step) => step.kind !== "start");
  return loud.length === 1 ? loud[0] : undefined;
}

// Rerun's line before it's pressed: still checking, nothing it can rerun and why, or the runs to rerun [PRS-09].
// Checking can be pressed: the sheet closes, and the rerun goes ahead once the checks are in.
export type RerunState =
  | { state: "checking" | "unknown" | "none"; detail: string }
  | { state: "elsewhere"; detail: string; failing: FailingChecks[] }
  | { state: "ready"; failing: FailingChecks[]; runIds: number[] };

export function rerunState(details: { data?: { failing: FailingChecks[] }; isLoading: boolean } | undefined): RerunState {
  if (!details || details.isLoading) return { state: "checking", detail: "Checking which checks failed…" };
  const failing = details.data?.failing;
  if (!failing) return { state: "unknown", detail: "Couldn't find the failing checks" };
  const summary = summarizeRerun(failing);
  if (summary.failed === 0) return { state: "none", detail: "No failed checks on the latest commit" };
  if (summary.runIds.length === 0) return { state: "elsewhere", detail: `${summary.failed} failed, none in GitHub Actions, so none can be rerun here`, failing };
  return { state: "ready", failing, runIds: summary.runIds };
}

// Why it waits and how long, in Waiting only; Doing says what's mine to do. Once it has waited too long, where nudging is
// fair, the age itself turns amber with ⌛ and says so in words [WAI-01, ATT-11].
export function waitChips(item: Item, inWaiting: boolean, tooLongDays: number, now = new Date()): Chip[] {
  const { wait } = item;
  if (!wait || !inWaiting) return [];
  const age = ago(wait.since, now);
  const reason: Chip[] = wait.reason ? [{ text: wait.reason, tone: "neutral" }] : [];
  if (!wait.tooLong) return [...reason, { text: age, tone: "neutral" }];
  const since = wait.reason === "question" ? "you asked" : "your last push or reply";
  const limit = `${tooLongDays} day${tooLongDays === 1 ? "" : "s"}`;
  return [...reason, { text: age, tone: "warn", icon: "hourglass", hint: `Waited too long: ${age} since ${since}, more than ${limit}` }];
}

// "Review 2h", "Question 3d": why and how long, to lead a line in a nudge [WAI-03].
export function nudgeLead(item: Item, now = new Date()): string | undefined {
  if (!item.wait) return undefined;
  const { reason, since } = item.wait;
  return reason ? `${reason[0].toUpperCase()}${reason.slice(1)} ${ago(since, now)}` : ago(since, now);
}

// In a Waiting group, the card names whom else it waits on; the group names one [WAI-02].
export function alsoWaitingOn(item: Item, groupWho: WaitingOn | undefined): string[] {
  if (!groupWho) return [];
  return (item.waitingOn ?? []).filter((who) => !(who.team === groupWho.team && sameName(who.login, groupWho.login))).map((who) => who.login);
}

// The card's "when": a note's change, or how it finished, in the words Wrap up uses [HIS-05, HIS-07].
export function cardWhen(item: Item, now = new Date()): string | undefined {
  return item.change || item.closedAt ? finishText(item, now) : undefined;
}

// History is where I report from, so its cards copy their link in one tap; unread notes are not report rows [ATT-15].
export const copiesLink = (item: Item) => SECTIONS[item.section].tab === "history" && item.section !== "changed";

// The PR an item's actions apply to, where that isn't the item itself, like an issue's PR.
export const targetUrl = (item: Item) => (item.target.number !== item.number || item.target.kind !== item.kind ? item.target.url : undefined);

const isRed = (chips: Chip[]) => chips.some((chip) => chip.tone === "bad");

// The full stack is in the sheet; the card shows the PRs that need attention [ATT-04]. Once it shows any, it shows the PR an
// issue's actions apply to as well, tinted, and says that PR's facts there rather than in its meta, as the sheet does [ATT-06].
export function cardStack(item: Item): { rows: SubRow[]; target?: SubRow } {
  const target = targetUrl(item);
  const needing = item.children.some((child) => child.attention || isRed(child.chips));
  const rows = needing ? item.children.filter((child) => child.attention || isRed(child.chips) || child.url === target) : [];
  return { rows, target: rows.find((child) => child.url === target) };
}

// An issue's chips are about the PR its actions apply to. Where its stack line shows that PR, each is said once, on that PR's
// row, and the meta keeps only what the row doesn't say; "PR #103" and "stack of 2" are the stack line itself. The sheet always
// shows the row; a card only when a PR in the stack needs attention [ATT-04, ATT-06].
export function stackMetaChips(item: Item, targetRow: SubRow | undefined): Chip[] {
  if (!targetRow) return item.chips;
  const onRow = new Set(targetRow.chips.map((chip) => chip.text));
  return item.chips.filter((chip) => !/^PR #\d+$/.test(chip.text) && !/^stack of \d+$/.test(chip.text) && !onRow.has(chip.text));
}

// Each tab's count: History's finished work, Doing with Wrap up's rows [ATT-09, ATT-22], work waiting on several people once,
// and every issue in Next up.
export function tabCounts(view: Pick<AttentionView, "history" | "count" | "waiting" | "assigned" | "unclaimed">, wrap: WrapItem[]): Record<TabId, number> {
  return {
    history: view.history.filter((item) => item.section === "done").length,
    doing: doingCount(view, wrap),
    waiting: new Set(view.waiting.flatMap((group) => group.items.map((item) => item.key))).size,
    next: view.assigned.length + view.unclaimed.length,
  };
}
