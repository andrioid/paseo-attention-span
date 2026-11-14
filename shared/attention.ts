import type { OthersChange } from "./changes";
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
  // Finished or out of my hands, with open Paseo sessions left to tidy up [ATT-22].
  wrap: { tab: "doing", title: "Wrap up" },
  reply: { tab: "doing", title: "Waiting for your reply" },
  // Someone answered my question without mentioning me [ATT-16].
  answered: { tab: "doing", title: "Answered" },
  review: { tab: "doing", title: "Review requested" },
  ci: { tab: "doing", title: "CI failing" },
  changes: { tab: "doing", title: "Changes requested" },
  ready: { tab: "doing", title: "Ready to merge" },
  upstream: { tab: "doing", title: "Needs upstream" },
  // Nobody has the next move until I ask someone [PRS-12].
  needs_reviewer: { tab: "doing", title: "Needs a reviewer" },
  drafts: { tab: "doing", title: "My drafts" },
  // Waiting groups these by who they wait on, not by section [WAI-01].
  wait_review: { tab: "waiting", title: "Waiting for review" },
  wait_reviewer: { tab: "waiting", title: "Waiting for the reviewer" },
  wait_ci: { tab: "waiting", title: "CI running" },
  wait_answer: { tab: "waiting", title: "Questions I asked" },
  // What someone else did to my work, unread at the top of History [HIS-07].
  changed: { tab: "history", title: "Changed by others" },
  // [HIS-01, HIS-02]
  done: { tab: "history", title: "Done" },
  reviewed: { tab: "history", title: "Reviewed" },
  // Cleared changes that weren't my finished work: a PR closed unmerged, work taken out of my hands, a reopen [HIS-06, HIS-07].
  handed_off: { tab: "history", title: "Changed by others" },
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
  | "start"
  // Clears a Changed by others note; nothing changes on GitHub [HIS-07].
  | "got_it";

// What History's filter can add to each week, both off at first [HIS-07].
export type HistoryFilter = "reviewed" | "changed";

// A short state label on a row [ATT-05]; tone picks its color.
export interface Chip {
  text: string;
  tone: "good" | "bad" | "warn" | "neutral";
  // In place of the dot, where a picture says it better.
  icon?: "thumbUp" | "hourglass";
  // What it means in words, on hover and to screen readers [ATT-11, ATT-19].
  hint?: string;
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

// What my work waits for: on items in Waiting, and on my PRs in Doing that wait on reviewers too, which Waiting lists as
// well [WAI-01, PRS-15].
export interface Wait {
  // In a word or two: "review", "re-review", "question". None where the chips already say, like blocked by repo rules.
  reason?: string;
  // Since I asked, tagged, pushed or replied.
  since: string;
  // Waited at least waitingTooLongDays, where nudging is fair: not while the next step is mine, like failing CI, conflicts,
  // changes to make or a reply I owe, nor while CI runs [ATT-11].
  tooLong?: boolean;
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

// The name of a session and its new workspace; a review says so, apart from work on my own PRs [SES-09].
export function sessionTitle(kind: SessionKind, target: Pick<Target, "kind" | "number" | "title">): string {
  const item = `${target.kind === "pr" ? "PR" : "Issue"} ${target.number}: ${target.title}`;
  return (kind === "review" ? `Review ${item}` : item).slice(0, 120);
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
  // History only: who merged it, when it wasn't me [HIS-05].
  mergedBy?: string;
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
  // Whom it waits on: in Waiting, and on my PRs in Doing whom I asked that hasn't reviewed yet [WAI-02, PRS-15].
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
  // A PR of mine I closed without merging, for Wrap up's words [ATT-22].
  closedUnmerged?: true;
  // History only: who merged my PR, when it wasn't me [HIS-05].
  mergedBy?: string;
  // History only: who closed an issue assigned to me, when it wasn't me [HIS-07].
  closedBy?: string;
  // A Changed by others note, unread or cleared [HIS-06, HIS-07].
  change?: OthersChange;
  // Doing's Wrap up only: its open sessions and what finishing looked like [ATT-22].
  wrap?: WrapInfo;
}

// A Wrap up row's sessions: all idle, or it wouldn't be there [ATT-22].
export interface WrapInfo {
  sessions: AgentSummary[];
  // The finished item's own key; the row's is prefixed with "wrap:" so it never collides with it.
  itemKey: string;
  // memberKeys of the finished item: what its sessions are on and what archiving acknowledges [ATT-22].
  keys: string[];
  // "merged by dave 2h ago" or "closed 6h ago by alice", made when the row is.
  finish: string;
  // A session on someone else's PR that merged: its card says "review session" in words.
  review?: true;
}

// A Wrap up row: always with its sessions and keys [ATT-22].
export type WrapItem = Item & { section: "wrap"; wrap: WrapInfo };

// The GitHub work an item stands for: itself, the PRs under it, and the work a change note is about, spelled as GitHub
// spells them, since Paseo's labels match exactly. Compare them with keySet [ATT-03, ATT-04, HIS-07].
export function memberKeys(item: Pick<Item, "key" | "children"> & { change?: Pick<OthersChange, "key"> }): string[] {
  return uniqueKeys([item.key, ...(item.change ? [item.change.key] : []), ...item.children.map((child) => child.key)]);
}

// Each key once, ignoring case, in the first spelling seen.
export function uniqueKeys(keys: string[]): string[] {
  const unique = new Map<string, string>();
  for (const key of keys) if (!unique.has(key.toLowerCase())) unique.set(key.toLowerCase(), key);
  return [...unique.values()];
}

// Keys for comparing: GitHub's owner and repo names ignore case.
export const keySet = (keys: Iterable<string>): Set<string> => new Set([...keys].map((key) => key.toLowerCase()));

// Each open stack's and issue group's member keys, lower case, under every member, and when it was last seen open; so a
// member that merges still knows its open siblings [ATT-04, ATT-22].
export type RememberedGroups = Record<string, { keys: string[]; at: string }>;

// The colors GitHub lets an org give issue field options and a project its Status options. GRAY is what nothing chosen looks
// like, so it's shown untinted [NXT-10].
export type GithubColor = "GRAY" | "BLUE" | "GREEN" | "YELLOW" | "ORANGE" | "RED" | "PINK" | "PURPLE";

// An open project an issue is on, with its place on the board's built-in Status field [NXT-12].
export interface IssueProject {
  id: string;
  title: string;
  status?: string;
  color?: GithubColor;
}

// An open project Next up's issues are on, with every option of its Status field in the board's order, for the filter [NXT-03].
export interface ProjectInfo {
  id: string;
  title: string;
  statuses: { name: string; color: GithubColor }[];
}

// Whether Next up can read projects, and if not, why and how to fix it, for Settings [NXT-12]. Without them Next up just
// leaves projects out.
export interface ProjectsAccess {
  // missing: the token lacks read:project; failed: GitHub refused or didn't answer for another reason; unknown: not asked yet.
  state: "on" | "missing" | "failed" | "unknown";
  // GitHub's own words when it failed for another reason, like an org's SSO.
  error?: string;
  // What went wrong reading them on the last refresh while they're on, like boards an org's SSO hides, in GitHub's words.
  warning?: string;
  // Where gh's token comes from: its own login, which `gh auth refresh` can widen, or an environment variable it reads first.
  token: "gh" | "GH_TOKEN" | "GITHUB_TOKEN";
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
  // The color the org gave its priority option; missing when the org colored none, so the card falls back on rank [NXT-10].
  priorityColor?: GithubColor;
  // The open projects it's on [NXT-12]. Missing when projects can't be read, or when GitHub cut its list short with none open
  // in what came: then which boards it's on is unknown, so it's neither on one nor on none.
  projects?: IssueProject[];
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
  // The projects Next up's issues are on, for its filter [NXT-03, NXT-12].
  projects?: ProjectInfo[];
  // Repo -> who reviewed or was asked on my PRs there, latest first, for the reviewer picker [PRS-12].
  reviewers?: Record<string, Reviewer[]>;
  // My PRs I closed without merging lately: finished work for Wrap up, never shown in History [ATT-22].
  ownClosed?: Item[];
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
  // Its workspace, for Wrap up: whether its worktree holds unsaved work, and whether it's Paseo's own worktree [ATT-22].
  workspace?: SessionWorkspace;
}

export interface SessionWorkspace {
  kind: "directory" | "worktree" | "checkout" | "local_checkout";
  name: string;
  directory?: string;
  branch?: string;
  // Paseo's own reading: true when there are uncommitted changes; missing when it couldn't tell.
  dirty?: boolean;
  // Commits not on the upstream branch, from Paseo; missing when it couldn't tell.
  ahead?: number;
  // Previews only, where Paseo has no worktree: how many files are uncommitted, for the confirm sheet's words.
  dirtyFiles?: number;
}

// An item's open sessions: started on it or on any PR under it, until it's merged or closed.
// One that needs me comes first, then the most recent [SES-03].
export function itemSessions(agents: AgentSummary[], item: Pick<Item, "key" | "closedAt" | "children">): AgentSummary[] {
  if (item.closedAt) return [];
  return matchSessions(agents, [item.key, ...item.children.map((child) => child.key)]);
}

// A session is idle when it isn't working and doesn't need me; Wrap up and archiving both ask [ATT-22].
export function isIdle(agent: { status: string; requiresAttention?: boolean }): boolean {
  return !agent.requiresAttention && agent.status !== "running" && agent.status !== "initializing";
}

export function matchSessions(agents: AgentSummary[], keys: string[]): AgentSummary[] {
  const wanted = keySet(keys);
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
  // Items in Doing that need me; the sidebar shows it, adding Wrap up's rows client-side [ATT-09, ATT-22].
  count: number;
  doing: Section[];
  waiting: WaitingGroup[];
  history: Item[];
  // Every item key on Doing, Waiting or Next up before dismissals, so Wrap up knows what still isn't done [ATT-22].
  activeKeys?: string[];
  // My PRs I closed without merging, for Wrap up only [ATT-22].
  ownClosed?: Item[];
  // Key -> the keys of the stack or issue group it was last seen open in, lower case [ATT-22, ATT-04].
  groups?: Record<string, string[]>;
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  unclaimedFrom: UnclaimedSource;
  // The projects Next up's issues are on [NXT-03, NXT-12].
  projects: ProjectInfo[];
  dismissedCount: number;
  // Scopes ticked in Next up's filter; none means all [NXT-03].
  scopes: string[];
  // Sources ticked in Next up's filter; none means all [NXT-09].
  sources: string[];
  // Project statuses ticked in Next up's filter, as projectFilterId makes them; none means all [NXT-03].
  projectFilter: string[];
  // Reviewed and Changed by others shown in each of History's weeks; none means finished only [HIS-07].
  historyFilter: HistoryFilter[];
  config: AttentionConfig;
  // Changes I just made that GitHub's search hasn't caught up with; the app checks back sooner while there are any [FRESH-02].
  pending: number;
  // Fixture mode only: made-up sessions, since the preview daemon has no agents.
  fixtureAgents?: AgentSummary[];
}

// What a tick in Next up's project filter stands for: one status of one project, a project's issues without a status, or
// issues on no project [NXT-03].
export function projectFilterId(project: { id: string } | null, status?: string | null): string {
  if (!project) return "noproject";
  return status ? `status:${project.id}:${status}` : `nostatus:${project.id}`;
}

// The ticks an issue answers to: one per project it's on, or "noproject". None when its projects are unknown, so a project
// filter hides it rather than call it on no project.
export function projectFilterIds(issue: Pick<NextUpIssue, "projects">): string[] {
  if (!issue.projects) return [];
  return issue.projects.length ? issue.projects.map((project) => projectFilterId(project, project.status)) : [projectFilterId(null)];
}
