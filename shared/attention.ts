import type { AttentionConfig, MergeMethod, SessionKind } from "./config";
import type { WorkKind } from "./work";

// Tabs tell the story of my work: what I finished, what needs me, what waits on others, what's next.
export type TabId = "history" | "doing" | "waiting" | "next";

// Each tab's data comes from one feed, fetched from GitHub on its own schedule. History changes only when I finish something.
export type FeedId = "live" | "history";
export const TAB_FEED: Record<TabId, FeedId> = { history: "history", doing: "live", waiting: "live", next: "live" };

// Within a tab, top to bottom. The order is also the priority: an item appears once, under the first section whose rule
// holds, its most urgent reason [ATT-02]. Moving a line here changes which section wins.
export const SECTIONS = {
  reply: { tab: "doing", title: "Waiting for your reply" },
  // Someone answered my question without mentioning me [ATT-16].
  answered: { tab: "doing", title: "Answered" },
  review: { tab: "doing", title: "Review requested" },
  ci: { tab: "doing", title: "CI failing" },
  changes: { tab: "doing", title: "Changes requested" },
  ready: { tab: "doing", title: "Ready to merge" },
  upstream: { tab: "doing", title: "Needs upstream" },
  too_long: { tab: "doing", title: "Waiting too long" },
  // Nobody has the next move until I ask someone [PRS-12].
  needs_reviewer: { tab: "doing", title: "Needs a reviewer" },
  drafts: { tab: "doing", title: "My drafts" },
  // Waiting groups these by who they wait on, not by section [WAI-01].
  wait_review: { tab: "waiting", title: "Waiting for review" },
  wait_reviewer: { tab: "waiting", title: "Waiting for the reviewer" },
  wait_ci: { tab: "waiting", title: "CI running" },
  wait_answer: { tab: "waiting", title: "Questions I asked" },
  // [HIS-01, HIS-02]
  done: { tab: "history", title: "Done" },
  reviewed: { tab: "history", title: "Reviewed" },
} as const satisfies Record<string, { tab: TabId; title: string }>;
export type SectionId = keyof typeof SECTIONS;
export const SECTION_ORDER = Object.keys(SECTIONS) as SectionId[];

// The first is the card's main action; the item's sheet lists them all.
export type ActionId =
  | "reply"
  | "acknowledge"
  | "review"
  | "fix"
  | "rerun"
  | "address"
  | "update"
  | "rebase"
  | "refresh"
  | "ready"
  | "request_review"
  | "automerge"
  | "merge"
  | "close"
  | "start";

// A short state label on a row [ATT-05]; tone picks its color.
export interface Chip {
  text: string;
  tone: "good" | "bad" | "warn" | "neutral";
  // In place of the dot, where a picture says it better.
  icon?: "thumbUp";
}

export type PersonRole = "author" | "changes";

// The person (or bot) I'm waiting on, or who is waiting on me.
export interface Person {
  login: string;
  // What they are to the item, where no quote says it: who opened it, or whose comments are left to address [ATT-19].
  role?: PersonRole;
  avatarUrl?: string;
  bot: boolean;
  since: string;
  snippet?: string;
  url?: string;
  // Mentions only: every comment still waiting on me, for 👍 [MEN-02].
  comments?: WaitingComment[];
}

// Someone my waiting work waits on: a reviewer I asked, one who asked for changes, or someone I tagged. Never a guess [WAI-02].
export interface WaitingOn {
  login: string;
  avatarUrl?: string;
  team: boolean;
  // A requested bot reviewer: nobody to send a list to [WAI-03].
  bot?: boolean;
  // Since I asked or tagged them, or last pushed or replied.
  since: string;
}

// What my waiting work waits for: on items in Waiting, and in Waiting too long, which Waiting shows too [WAI-01].
export interface Wait {
  // In a word or two: "review", "re-review", "question". None where the chips already say, like blocked by repo rules.
  reason?: string;
  // Since I asked, tagged, pushed or replied.
  since: string;
  // Waiting too long only: what it waited for, for its chip in Doing [ATT-11].
  overdue?: string;
}

// Waiting's work under someone it waits on, longest wait first; the last group, without anyone, is work no person holds up.
// Work waiting on several people is under each [WAI-01, WAI-03].
export interface WaitingGroup {
  who?: WaitingOn;
  items: Item[];
}

export interface WaitingComment {
  // The comment's node, or the issue or PR when its description mentions me.
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
}

// Someone who can be asked to review: a person, or a team as "org/slug" [PRS-12].
export interface Reviewer {
  login: string;
  avatarUrl?: string;
  team: boolean;
}

// What the reviewer picker offers, fetched when it opens [PRS-12, GH-01].
export interface ReviewerChoices {
  // GitHub's suggestions, from who touched the changed code.
  suggested: Reviewer[];
  // Who reviewed or was asked on my other PRs in the repo.
  recent: Reviewer[];
  teams: Reviewer[];
  // Why teams are missing, when GitHub wouldn't list them.
  teamsNote?: string;
}

// GitHub's reasons for closing an issue that Next up offers [NXT-11].
export type IssueCloseReason = "completed" | "not_planned";

// What a session or GitHub action works on.
export interface Target {
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  // Pull requests only.
  id?: string;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  defaultBranch?: string;
  mergeMethod?: MergeMethod;
  // Every PR in the stack, bottom first: mine, and others' that ask for my review [ATT-04].
  stack?: StackPr[];
}

export interface StackPr {
  number: number;
  head: string;
  base: string;
  // Someone else's, asking for my review; the rest are mine.
  review?: true;
}

// The PRs of mine in a target's stack: what Rebase, Refresh and Rerun act on. Others' branches are never pushed [ATT-04].
export function ownStack(target: Pick<Target, "stack">): StackPr[] {
  return (target.stack ?? []).filter((pr) => !pr.review);
}

// The PR a session checks out: for Review of a stack, its top, which has every PR's changes; otherwise the target [ATT-04].
export function checkoutPr(kind: SessionKind, target: Pick<Target, "number" | "headRefName" | "stack">): { number: number; head?: string } {
  const top = target.stack?.at(-1);
  return kind === "review" && top && target.stack!.length > 1 ? { number: top.number, head: top.head } : { number: target.number, head: target.headRefName };
}

export interface SubRow {
  key: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  chips: Chip[];
  // Behind its parent, conflicting or failing CI: shown even when the stack is collapsed.
  attention: boolean;
}

export interface Item {
  key: string;
  section: SectionId;
  kind: "pr" | "issue";
  draft: boolean;
  repo: string;
  number: number;
  title: string;
  url: string;
  chips: Chip[];
  person?: Person;
  // Waiting and Waiting too long only [WAI-02].
  waitingOn?: WaitingOn[];
  wait?: Wait;
  actions: ActionId[];
  // Linked PRs under an issue, or the PRs above the bottom of a stack.
  children: SubRow[];
  target: Target;
  // Latest activity by someone else, for bringing back dismissed items [ATT-08].
  othersActivityAt: string;
  // History only: when it merged or closed.
  closedAt?: string;
  // History only: what kind of work it was, when that can be told [HIS-04].
  work?: WorkKind;
  // History only: an issue closed as not planned, kept out of the copied week [HIS-03].
  notPlanned?: true;
}

// An issue to pick up: assigned to me [NXT-06] or nobody [NXT-01].
export interface NextUpIssue {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  type?: string;
  priority?: string;
  effort?: string;
  scope?: string;
  defaultBranch?: string;
  // Ids of the Next up sources that found it; empty without sources of its own [NXT-09].
  sources: string[];
  // Its priority's place in the field's order, 0 first; missing when unknown [NXT-02].
  priorityRank?: number;
  // Open PRs that close it: someone may already be on it [NXT-10].
  openPrs: { number: number; url: string; author: string | null }[];
}

// More about an item, fetched when its sheet opens rather than in every refresh [GH-01].
export interface ItemDetails {
  // The PR actions apply to.
  size?: { additions: number; deletions: number; files: number };
  // The issues a PR closes, or the PRs that close an issue.
  linked: { number: number; title: string; url: string; state: string }[];
  // Only asked for when the item offers Rerun: each PR in the stack with failing checks.
  failing: FailingChecks[];
}

export interface FailingChecks {
  pr: number;
  // Checks from GitHub Actions can be rerun; other status checks can't.
  checks: { name: string; rerunnable: boolean }[];
  runs: { id: number; attempt: number }[];
}

// Where Next up's unclaimed issues came from: the config, my Paseo projects' repos, or nowhere [NXT-08].
export type UnclaimedSource = "config" | "projects" | "none";

export interface Attention {
  login: string;
  items: Item[];
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  unclaimedFrom?: UnclaimedSource;
  // Repo -> who reviewed or was asked on my PRs there, latest first, for the reviewer picker [PRS-12].
  reviewers?: Record<string, Reviewer[]>;
}

export interface Section {
  id: SectionId;
  title: string;
  items: Item[];
}

// A Paseo session started from an item [ATT-07].
export interface AgentSummary {
  id: string;
  // The item it was started on: an issue or a PR.
  itemKey: string;
  // The action it was started for; sessions started before kinds were saved have none.
  kind?: SessionKind;
  status: string;
  requiresAttention: boolean;
  title: string | null;
  workspaceId: string | null;
  lastActivityAt: string | null;
}

// An item's open sessions: started on it or on any PR under it, until it's merged or closed.
// One that needs me comes first, then the most recent [SES-03].
export function itemSessions(agents: AgentSummary[], item: Pick<Item, "key" | "closedAt" | "children">): AgentSummary[] {
  if (item.closedAt) return [];
  return matchSessions(agents, [item.key, ...item.children.map((child) => child.key)]);
}

export function matchSessions(agents: AgentSummary[], keys: string[]): AgentSummary[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return agents
    .filter((agent) => wanted.has(agent.itemKey.toLowerCase()))
    .sort((a, b) => Number(b.requiresAttention) - Number(a.requiresAttention) || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

// Work in Waiting with an active session first: one that needs me, then one that's working. A finished session I've seen
// doesn't lift it. Otherwise the order stays as it was [WAI-01].
export function liftActive(items: Item[], agents: AgentSummary[]): Item[] {
  const rank = (item: Item) => {
    const agent = itemSessions(agents, item)[0];
    if (agent?.requiresAttention) return 0;
    return agent?.status === "running" || agent?.status === "initializing" ? 1 : 2;
  };
  return items.map((item) => ({ item, rank: rank(item) })).sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}

// Sessions none of the item's actions would have started: no kind saved, or the action's gone, like Fix CI once checks pass.
// They lead the sheet; the rest sit in their action's line [SES-03].
export function looseSessions(sessions: AgentSummary[], kinds: SessionKind[]): AgentSummary[] {
  return sessions.filter((agent) => !agent.kind || !kinds.includes(agent.kind));
}

export interface FeedStatus {
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
}

// What the client renders: dismissed items removed, grouped per tab.
export interface AttentionView {
  feeds: Record<FeedId, FeedStatus>;
  login: string | null;
  // Items in Doing; the sidebar shows it [ATT-09].
  count: number;
  doing: Section[];
  waiting: WaitingGroup[];
  history: Item[];
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  unclaimedFrom: UnclaimedSource;
  dismissedCount: number;
  // Scopes ticked in Next up's filter; none means all [NXT-03].
  scopes: string[];
  // Sources ticked in Next up's filter; none means all [NXT-09].
  sources: string[];
  config: AttentionConfig;
  // Changes I just made that GitHub's search hasn't caught up with; the app checks back sooner while there are any [FRESH-02].
  pending: number;
  // Fixture mode only: made-up sessions, since the preview daemon has no agents.
  fixtureAgents?: AgentSummary[];
}
