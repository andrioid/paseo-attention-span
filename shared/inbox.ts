import type { InboxConfig, MergeMethod } from "./config";

// Tabs tell the story of my work: what I finished, what needs me, what waits on others, what's next.
export type TabId = "history" | "doing" | "waiting" | "next";

// Within a tab, top to bottom; an item appears once, under its most urgent reason [ATT-02].
export const SECTIONS = {
  reply: { tab: "doing", title: "Waiting for your reply" },
  review: { tab: "doing", title: "Review requested" },
  ci: { tab: "doing", title: "CI failing" },
  changes: { tab: "doing", title: "Changes requested" },
  ready: { tab: "doing", title: "Ready to merge" },
  upstream: { tab: "doing", title: "Needs upstream" },
  too_long: { tab: "doing", title: "Waiting too long" },
  drafts: { tab: "doing", title: "My drafts" },
  // [WAI-01]
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

export type ActionId = "reply" | "review" | "fix" | "address" | "update" | "rebase" | "refresh" | "merge" | "close" | "start";

// A short state label on a row [ATT-05]; tone picks its color.
export interface Chip {
  text: string;
  tone: "good" | "bad" | "warn" | "neutral";
}

// The person (or bot) I'm waiting on, or who is waiting on me.
export interface Person {
  login: string;
  avatarUrl?: string;
  bot: boolean;
  since: string;
  snippet?: string;
  url?: string;
}

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
  // Every PR in the stack, bottom first.
  stack?: { number: number; head: string; base: string }[];
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
  actions: ActionId[];
  // Linked PRs under an issue, or the PRs above the bottom of a stack.
  children: SubRow[];
  target: Target;
  // Latest activity by someone else, for bringing back dismissed items [ATT-08].
  othersActivityAt: string;
  // History only: when it merged or closed.
  closedAt?: string;
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
}

export interface Inbox {
  login: string;
  items: Item[];
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
}

export interface Section {
  id: SectionId;
  title: string;
  items: Item[];
}

// A Paseo session started from an item [ATT-07].
export interface AgentSummary {
  id: string;
  status: string;
  requiresAttention: boolean;
  title: string | null;
  workspaceId: string | null;
}

// What the client renders: dismissed items removed, grouped per tab.
export interface InboxView {
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  login: string | null;
  // Items in Doing; the sidebar shows it [ATT-09].
  count: number;
  doing: Section[];
  waiting: Section[];
  history: Item[];
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  dismissedCount: number;
  config: InboxConfig;
  // Fixture mode only: made-up sessions, since the preview daemon has no agents.
  fixtureAgents?: Record<string, AgentSummary>;
}
