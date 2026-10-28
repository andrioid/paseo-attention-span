import { z } from "zod";

// Session types, each with its own prompt template and profile lookup.
export const SessionKind = z.enum(["review", "fix", "address", "rebase", "refresh", "start"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const MergeMethod = z.enum(["squash", "merge", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

// An org issue field and how its values rank; values match by name, so "Small" matches "🐇 Small (0.5-2d)".
const RankedField = z.object({
  field: z.string(),
  // Best first. Without it, the field's own option order applies.
  order: z.array(z.string()).optional(),
});

// ~/.config/paseo-github-attention/config.json, edited by hand [SRC-01].
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
  // Where an issue repo's code lives, "owner/name" -> "owner/name", for issues kept apart from the code [SES-07].
  codeRepos: z.record(z.string(), z.string()).default({}),
  // Merge method per "owner/name" [PRS-04].
  mergeMethods: z.record(z.string(), MergeMethod).default({}),
  waitingTooLongDays: z.number().positive().default(3),
  // A digest, not a live view: GitHub is asked at most this often unless I press ⟳ [GH-01].
  refreshMinutes: z.number().min(5).default(60),
  staleDraftDays: z.number().positive().default(30),
  mentionDays: z.number().positive().default(30),
  // How many weeks History shows [HIS-01].
  historyWeeks: z.number().int().positive().default(4),
  // Unclaimed issues to pick from [NXT-04]. Repos default to the inbox's orgs and repos.
  nextUp: z
    .object({
      repos: z.array(z.string()).optional(),
      priority: RankedField.optional(),
      effort: RankedField.optional(),
      scope: z.object({ field: z.string() }).optional(),
    })
    .default({}),
});
export type InboxConfig = z.infer<typeof InboxConfig>;

// The repository whose checkout a session on an issue from `repo` works in [SES-07].
export function codeRepoFor(config: Pick<InboxConfig, "codeRepos">, repo: string): string {
  const mapped = Object.entries(config.codeRepos).find(([issues]) => issues.toLowerCase() === repo.toLowerCase());
  return mapped?.[1] ?? repo;
}
