import { z } from "zod";

// Session types, each with its own prompt template and profile lookup.
export const SessionKind = z.enum(["review", "fix", "address", "rebase", "refresh", "start"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const MergeMethod = z.enum(["squash", "merge", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

// ~/.config/paseo-github-inbox/config.json, edited by hand [SRC-01].
export const InboxConfig = z.object({
  // GitHub orgs and "owner/name" repos to cover. Both empty means everything involving me.
  orgs: z.array(z.string()).default([]),
  repos: z.array(z.string()).default([]),
  // Agent profile name per session type. A missing profile falls back to "default",
  // then to Paseo's defaults [SES-06].
  profiles: z
    .object({ default: z.string().default("default") })
    .catchall(z.string())
    .default({ default: "default", review: "review" }),
  // Replaces a built-in prompt template [SES-04].
  prompts: z.partialRecord(SessionKind, z.string()).default({}),
  // Merge method per "owner/name" [PRS-04].
  mergeMethods: z.record(z.string(), MergeMethod).default({}),
  waitingTooLongDays: z.number().positive().default(3),
  refreshMinutes: z.number().min(1).default(30),
  staleDraftDays: z.number().positive().default(30),
  mentionDays: z.number().positive().default(30),
});
export type InboxConfig = z.infer<typeof InboxConfig>;
