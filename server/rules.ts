import { type ActionId, type Person, SECTION_ORDER, type SectionId } from "../shared/attention";

// Which section an item goes in, as one rule per section. The regions of an item's state (CI, review, mergeability, draft)
// are flags; a rule is a guard over them. SECTIONS order is the priority: the first section whose rule holds wins [ATT-02].

export interface Rule<S> {
  when: (s: S) => boolean;
  // The first is the card's main action.
  actions?: (s: S) => ActionId[];
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
  // Someone commented on it after me, lately, and I haven't 👍'd it [ATT-16].
  answer?: Person;
  ciFailing: boolean;
  ciPending: boolean;
  changes: boolean;
  approved: boolean;
  conflicts: boolean;
  // GitHub says the repo's rules block merging it now, for whatever reason [PRS-13].
  mergeBlocked: boolean;
  // Conflicts, or a PR above it no longer builds on its parent [UPS-01, UPS-02].
  blocked: boolean;
  autoMerge: boolean;
  autoMergeAllowed: boolean;
  behindBy: number;
  stacked: boolean;
  stale: boolean;
  // Someone has the next move: a person or team is requested, or someone else has reviewed [PRS-12].
  asked: boolean;
  // I replied to the reviewer, or pushed after changes were requested.
  replied: boolean;
}

// Approved and nothing I know of in the way, yet GitHub's rules still block it: signed commits, a required check that never
// reported, a resolved-conversations rule, and the like. Nothing for me to do here, so it waits [PRS-13].
export const rulesBlock = (s: PrState) => !s.draft && s.mergeBlocked && s.approved && !s.ciPending && !s.ciFailing && !s.changes && !s.conflicts;

// Fair to nudge whoever it waits on once it has waited too long: not while the next step is mine (failing CI, conflicts or a
// stack out of sync, changes to make, a reply I owe), nor while CI runs, which a reviewer may fairly wait out [ATT-11].
export const nudgeable = (s: PrState) => !s.draft && !s.waiting && !s.answer && !s.ciFailing && !s.ciPending && !s.changes && !s.blocked;

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
  answered: { when: (s) => !!s.answer, actions: (s) => replyActions(s.answer) },
  // Rerun is for flaky checks, without an agent [PRS-09].
  ci: { when: (s) => !s.draft && s.ciFailing, actions: () => ["fix", "rerun"] },
  changes: { when: (s) => !s.draft && s.changes, actions: () => ["address"] },
  // Auto-merge waiting on CI leaves nothing for me to do.
  // Blocked while CI runs counts as waiting on CI, which auto-merge covers [PRS-10, PRS-13].
  ready: { when: (s) => !s.draft && s.approved && !s.conflicts && !s.ciFailing && !s.changes && !(s.autoMerge && s.ciPending) && !rulesBlock(s), actions: readyActions },
  upstream: { when: (s) => !s.draft && s.blocked, actions: () => ["rebase"] },
  // Mine until I ask someone, even while CI runs. Merge, for repos where nobody reviews, once CI passed on the current base
  // and GitHub's rules allow it [PRS-12, PRS-04, PRS-13].
  needs_reviewer: {
    when: (s) => !s.draft && !s.asked,
    actions: (s) => (!s.ciFailing && !s.ciPending && s.behindBy === 0 && !s.mergeBlocked ? ["request_review", "merge"] : ["request_review"]),
  },
  drafts: { when: (s) => s.draft, actions: draftActions },
  // Otherwise it waits on others: CI, the reviewer after my reply, or a review, however long; Waiting says when that's too
  // long [WAI-01, ATT-11]. Blocked by rules waits with reviews [PRS-13].
  wait_review: { when: (s) => !s.draft && s.asked && !s.ciPending && (!s.replied || rulesBlock(s)) },
  wait_reviewer: { when: (s) => !s.draft && s.asked && !s.ciPending && s.replied && !rulesBlock(s) },
  wait_ci: { when: (s) => !s.draft && s.asked && s.ciPending },
};

// ---- Issues and others' PRs I'm in [WAI-01, ATT-16] ----

export interface IssueState {
  // I opened it.
  authored: boolean;
  // I follow threads I've commented on, so replies there count without a tag: the followThreads setting [ATT-17].
  follow: boolean;
  // My comment is the last one from a person; bots don't count [MEN-05].
  mineLast: boolean;
  // My comments since someone else last spoke ask something; a statement, tagged or not, waits on nobody [WAI-01].
  question: boolean;
  // A person commented after me (or after I opened it) within mentionDays, and I haven't 👍'd it [MEN-02].
  answered: boolean;
  // My last comment is within mentionDays.
  fresh: boolean;
}

// An issue may match none, and then isn't listed: an answer I 👍'd needs nothing more, nor an old thread of someone else's.
// Mentions come first, through their own search [MEN-01].
export const ISSUE_RULES: Rules<IssueState> = {
  // A recent comment after mine, without mentioning me: mine until I reply, 👍 it or dismiss it [ATT-16].
  // On someone else's thread only when I've allowed replies without a tag [ATT-17].
  answered: { when: (s) => s.answered && (s.authored || s.follow) },
  // My question waits on an answer: on my own issues however long ago, on others' only while fresh. Waiting says when it's
  // waited too long [WAI-01, ATT-11].
  wait_answer: { when: (s) => s.mineLast && s.question && (s.authored || s.fresh) },
};
