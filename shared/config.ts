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

// ~/.config/paseo-attention-span/config.json, edited by hand [SRC-01].
export const AttentionConfig = z.object({
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
  refreshMinutes: z.number().min(5).default(15),
  staleDraftDays: z.number().positive().default(30),
  mentionDays: z.number().positive().default(30),
  // How many weeks History shows [HIS-01].
  historyWeeks: z.number().int().positive().default(4),
  // Unclaimed issues to pick from [NXT-04]. With no sources chosen, Next up looks in `orgs` and `repos` [NXT-08].
  nextUp: z
    .object({
      // Sources: my own repos (not forks), whole orgs, and single "owner/name" repos.
      mine: z.boolean().default(false),
      orgs: z.array(z.string()).default([]),
      repos: z.array(z.string()).default([]),
      priority: RankedField.optional(),
      effort: RankedField.optional(),
      scope: z.object({ field: z.string() }).optional(),
    })
    .default({ mine: false, orgs: [], repos: [] }),
});
export type AttentionConfig = z.infer<typeof AttentionConfig>;

// Where Next up looks, one search each; `id` is what the chips I pick remember [NXT-09].
export interface NextUpSource {
  id: string;
  label: string;
}

export function nextUpSources({ nextUp }: Pick<AttentionConfig, "nextUp">): NextUpSource[] {
  return [
    ...(nextUp.mine ? [{ id: "mine", label: "My repos" }] : []),
    ...nextUp.orgs.map((org) => ({ id: `org:${org}`, label: org })),
    ...nextUp.repos.map((repo) => ({ id: `repo:${repo}`, label: repo })),
  ];
}

// "owner/name" of a Paseo project with a GitHub remote, from its project key.
export function githubRepoOf(projectKey: string | null | undefined): string | null {
  return /^remote:github\.com\/(.+)$/i.exec(projectKey ?? "")?.[1] ?? null;
}

// The repository whose checkout a session on an issue from `repo` works in [SES-07].
export function codeRepoFor(config: Pick<AttentionConfig, "codeRepos">, repo: string): string {
  const mapped = Object.entries(config.codeRepos).find(([issues]) => issues.toLowerCase() === repo.toLowerCase());
  return mapped?.[1] ?? repo;
}
