import { z } from "zod";
import { InboxConfig, MergeMethod } from "./config";

// Top to bottom; an item appears once, under its most urgent reason [ATT-02].
export const SectionId = z.enum([
  "reply",
  "review",
  "ci",
  "changes",
  "ready",
  "upstream",
  "too_long",
  "drafts",
]);
export type SectionId = z.infer<typeof SectionId>;

export const SECTION_TITLES: Record<SectionId, string> = {
  reply: "Waiting for your reply",
  review: "Review requested",
  ci: "CI failing",
  changes: "Changes requested",
  ready: "Ready to merge",
  upstream: "Needs upstream",
  too_long: "Waiting too long",
  drafts: "My drafts",
};

export const ActionId = z.enum([
  "reply",
  "review",
  "fix",
  "address",
  "update",
  "rebase",
  "refresh",
  "merge",
  "close",
  "start",
]);
export type ActionId = z.infer<typeof ActionId>;

// What a session needs to check out the item and find its repository.
export const Target = z.object({
  kind: z.enum(["pr", "issue"]),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  // Pull requests only.
  id: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  headRefOid: z.string().optional(),
  defaultBranch: z.string().optional(),
  mergeMethod: MergeMethod.optional(),
  // "owner/name#number" of every PR in the stack, bottom first.
  stack: z.array(z.string()).optional(),
});
export type Target = z.infer<typeof Target>;

export const SubRow = z.object({
  key: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  detail: z.string(),
});
export type SubRow = z.infer<typeof SubRow>;

export const Item = z.object({
  key: z.string(),
  section: SectionId,
  kind: z.enum(["pr", "issue"]),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  // Short state line shown under the title [ATT-05].
  detail: z.string(),
  // Mention excerpt, when someone is waiting for a reply.
  snippet: z.string().optional(),
  replyUrl: z.string().optional(),
  // A bot is the one waiting [MEN-06].
  bot: z.boolean(),
  actions: z.array(ActionId),
  // Linked PRs under an issue, or the PRs above the bottom of a stack.
  children: z.array(SubRow),
  // The PR an action works on: the item itself, or the bottom of its stack.
  target: Target,
  // Latest activity by someone else, for bringing back dismissed items [ATT-08].
  othersActivityAt: z.string(),
});
export type Item = z.infer<typeof Item>;

export const FooterEntry = z.object({
  key: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  detail: z.string(),
});
export type FooterEntry = z.infer<typeof FooterEntry>;

export const Footer = z.object({
  waitingOnOthers: z.array(FooterEntry),
  toDo: z.array(FooterEntry),
  doneThisWeek: z.array(FooterEntry),
});
export type Footer = z.infer<typeof Footer>;

export const Section = z.object({ id: SectionId, title: z.string(), items: z.array(Item) });
export type Section = z.infer<typeof Section>;

export const Inbox = z.object({
  login: z.string(),
  items: z.array(Item),
  footer: Footer,
});
export type Inbox = z.infer<typeof Inbox>;

// What the client renders: dismissed items removed and grouped into sections.
export const InboxView = z.object({
  fetchedAt: z.string().nullable(),
  refreshing: z.boolean(),
  error: z.string().nullable(),
  login: z.string().nullable(),
  count: z.number(),
  sections: z.array(Section),
  footer: Footer,
  dismissedCount: z.number(),
  config: InboxConfig,
});
export type InboxView = z.infer<typeof InboxView>;

