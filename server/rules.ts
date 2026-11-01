import { type ActionId, type Person, SECTION_ORDER, type SectionId } from "../shared/attention";

// Which section an item goes in, as one rule per section. The regions of an item's state (CI, review, mergeability, draft)
// are flags; a rule is a guard over them. SECTIONS order is the priority: the first section whose rule holds wins [ATT-02].

export interface Rule<S> {
  when: (s: S) => boolean;
  // The first is the card's main action.
  actions?: (s: S) => ActionId[];
  // What it waits for, for Waiting too long's chip.
  label?: (s: S) => string;
}
export type Rules<S> = { [K in SectionId]?: Rule<S> };

// The first section, in SECTIONS order, whose rule holds.
export function pick<S>(rules: Rules<S>, s: S): SectionId | undefined {
  return SECTION_ORDER.find((id) => rules[id]?.when(s));
}

// Reply on GitHub, or 👍 the waiting comments, which clears them too [MEN-02].
export function replyActions(waiting: Person | undefined): ActionId[] {
  return waiting?.comments?.length ? ["reply", "acknowledge"] : ["reply"];
}

// ---- My PRs: a stack decided by its bottom PR [ATT-04] ----

export interface PrState {
  draft: boolean;
  // Someone mentioned me and is waiting [MEN-01].
  waiting?: Person;
  ciFailing: boolean;
  ciPending: boolean;
  changes: boolean;
  approved: boolean;
  conflicts: boolean;
  // Conflicts, or a PR above it no longer builds on its parent [UPS-01, UPS-02].
  blocked: boolean;
  autoMerge: boolean;
  autoMergeAllowed: boolean;
  behindBy: number;
  stacked: boolean;
  stale: boolean;
  // I replied to the reviewer, or pushed after changes were requested.
  replied: boolean;
  // Waited at least waitingTooLongDays [ATT-11].
  tooLong: boolean;
}

const waitingFor = (s: PrState) => (s.ciPending ? "CI running" : s.replied ? "waiting for the reviewer" : "waiting for review");

// Merge only once CI passed against the current base [PRS-04, UPS-07]. Until then, auto-merge if the repo allows it [PRS-10].
function readyActions(s: PrState): ActionId[] {
  if (s.behindBy > 0) return [s.stacked ? "rebase" : "update"];
  if (s.ciPending) return s.autoMergeAllowed ? ["automerge"] : [];
  return ["merge"];
}

// A stale draft offers Refresh and Close instead of Rebase [PRS-07]; a healthy one, Ready for review [PRS-11].
function draftActions(s: PrState): ActionId[] {
  if (s.stale) return ["refresh", "close"];
  if (s.blocked) return ["rebase"];
  if (s.ciFailing) return ["fix", "rerun"];
  return ["ready"];
}

export const PR_RULES: Rules<PrState> = {
  reply: { when: (s) => !!s.waiting, actions: (s) => replyActions(s.waiting) },
  // Rerun is for flaky checks, without an agent [PRS-09].
  ci: { when: (s) => !s.draft && s.ciFailing, actions: () => ["fix", "rerun"] },
  changes: { when: (s) => !s.draft && s.changes, actions: () => ["address"] },
  // Auto-merge waiting on CI leaves nothing for me to do.
  ready: { when: (s) => !s.draft && s.approved && !s.conflicts && !s.ciFailing && !s.changes && !(s.autoMerge && s.ciPending), actions: readyActions },
  upstream: { when: (s) => !s.draft && s.blocked, actions: () => ["rebase"] },
  // After too long it's mine to nudge [ATT-11].
  too_long: { when: (s) => !s.draft && s.tooLong, label: waitingFor },
  drafts: { when: (s) => s.draft, actions: draftActions },
  // Otherwise it waits on others: CI, the reviewer after my reply, or a review [WAI-01].
  wait_review: { when: (s) => !s.draft && !s.ciPending && !s.replied, label: waitingFor },
  wait_reviewer: { when: (s) => !s.draft && !s.ciPending && s.replied, label: waitingFor },
  wait_ci: { when: (s) => !s.draft && s.ciPending, label: waitingFor },
};

// ---- Issues where I commented [WAI-01] ----

export interface IssueState {
  // My comment is the last one.
  mineLast: boolean;
  tooLong: boolean;
}

// An issue may match none, and then isn't listed.
export const ISSUE_RULES: Rules<IssueState> = {
  // Nobody answered for too long: mine to nudge [ATT-11].
  too_long: { when: (s) => s.mineLast && s.tooLong, label: () => "waiting for an answer" },
  wait_answer: { when: (s) => s.mineLast },
};
