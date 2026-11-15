import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Attention, type HistoryFilter, type Item, type RememberedGroups, type SectionId, SECTIONS } from "../shared/attention";
import { AttentionConfig, FIELD_ROLES, type FieldRole } from "../shared/config";
import type { KeptRow } from "../shared/archive";
import type { OthersChange } from "../shared/changes";
import { type ChangeLedger, EMPTY_LEDGER } from "./changes";
import type { Pending } from "./view";
import { sameName } from "../shared/names";

// Local files in ~/.config/paseo-attention-span/ [PRIV-01], or a folder chosen by environment variable.
const CHOSEN_DIR = process.env.PASEO_ATTENTION_SPAN_DIR ?? process.env.PASEO_GITHUB_ATTENTION_DIR;
export const DIR = CHOSEN_DIR ?? join(homedir(), ".config", "paseo-attention-span");
// Where they lived while the plugin was called "GitHub attention"; a chosen folder has none.
export const OLD_DIR = CHOSEN_DIR ? undefined : join(homedir(), ".config", "paseo-github-attention");

const knownSections = (items: unknown): boolean => Array.isArray(items) && items.every((item) => Object.hasOwn(SECTIONS, (item as Item)?.section));

export const State = z.object({
  // Item key -> others' activity and section when dismissed [ATT-08].
  dismissed: z.record(z.string(), z.object({ at: z.string(), section: z.custom<SectionId>() })).default({}),
  // Item key -> what I just changed on GitHub, until a fetch shows it [FRESH-02].
  pending: z.record(z.string(), z.custom<Pending>((value) => typeof (value as Pending)?.at === "string" && !!(value as Pending)?.effect)).default({}).catch({}),
  // Scopes ticked in Next up's filter; none means all [NXT-03].
  scopes: z.array(z.string()).default([]),
  // Sources ticked in Next up's filter; none means all [NXT-09].
  sources: z.array(z.string()).default([]),
  // Project statuses ticked in Next up's filter; none means all [NXT-03].
  projectFilter: z.array(z.string()).default([]),
  // Reviewed and Changed by others shown in each of History's weeks; none means finished only [HIS-07].
  historyFilter: z.array(z.enum(["reviewed", "changed"])).default([]).catch([] as HistoryFilter[]),
  // The device's IANA time zone, which History's weeks follow; the last device to send one wins. UTC until then [HIS-01].
  timeZone: z.string().nullable().default(null).catch(null),
  // The update notice put off with Not now, by the version it offered [UPD-01].
  skippedUpdate: z.string().nullable().default(null).catch(null),
  // What others did to my work, kept until Got it or an archive and for History [HIS-06, HIS-07, ATT-22].
  changes: z
    .object({
      events: z.array(z.custom<OthersChange>((value) => typeof (value as OthersChange)?.id === "string" && typeof (value as OthersChange)?.at === "string")),
      gotIt: z.array(z.string()),
      assigned: z.record(z.string(), z.string()).nullable(),
      handed: z.record(z.string(), z.string()),
      // PRs seen closed, to notice a reopen by someone else [HIS-07].
      tracked: z.record(z.string(), z.custom<ChangeLedger["tracked"][string]>((value) => typeof (value as { key?: string })?.key === "string")).default({}),
    })
    .default(EMPTY_LEDGER)
    .catch(EMPTY_LEDGER),
  // Key -> the keys of the stack or issue group it was last seen in, and when, so Wrap up still knows a merged PR's open
  // siblings after History lists it on its own [ATT-22, ATT-04].
  groups: z.record(z.string(), z.object({ keys: z.array(z.string()), at: z.string() })).default({}).catch({}) satisfies z.ZodType<RememberedGroups>,
  // Wrap up rows whose sessions were archived but whose worktree stayed, until it goes or is dismissed [ATT-22].
  kept: z.array(z.custom<KeptRow>((value) => typeof (value as KeptRow)?.workspaceId === "string" && typeof (value as KeptRow)?.itemKey === "string")).default([]).catch([]),
  // The repository and agent profile the New issue sheet last started with [ISS-01].
  newIssue: z.object({ repo: z.string().nullable().default(null), profileId: z.string().nullable().default(null) }).default({ repo: null, profileId: null }).catch({ repo: null, profileId: null }),
  // My Paseo projects' GitHub repos when last listed, for refreshes before the app has connected [NXT-08].
  projectRepos: z.array(z.string()).default([]),
  // The last fetch of each feed. A cache from an older version is dropped rather than shown wrong, like one with an item in a
  // section that's gone (Waiting too long was one) [ATT-11].
  live: z
    .object({
      fetchedAt: z.string(),
      attention: z.custom<Attention>(
        (value) =>
          knownSections((value as Attention)?.items) && (value as Attention).unclaimed?.every?.((issue) => Array.isArray(issue.sources) && Array.isArray(issue.openPrs)),
      ),
    })
    .nullable()
    .catch(null),
  history: z.object({ fetchedAt: z.string(), items: z.custom<Item[]>(knownSections) }).nullable().catch(null),
});
export type State = z.infer<typeof State>;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
}

// The files in `dir`. `oldDir` is moved over once, before `dir` exists.
export function createStore(dir: string, oldDir?: string) {
  const config = join(dir, "config.json");
  const state = join(dir, "state.json");

  async function moveOldFiles(): Promise<void> {
    if (!oldDir || (await exists(dir)) || !(await exists(oldDir))) return;
    await rename(oldDir, dir);
  }

  async function loadConfig(): Promise<AttentionConfig> {
    const parsed = AttentionConfig.safeParse(await readJson(config));
    if (!parsed.success) throw new Error(`${config} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  // Where an issue repo's code lives, chosen on the screen [SES-07].
  function saveCodeRepo(issueRepo: string, codeRepo: string): Promise<AttentionConfig> {
    return updateConfig((file) => {
      const existing = file.codeRepos && typeof file.codeRepos === "object" ? (file.codeRepos as Record<string, unknown>) : {};
      const codeRepos = Object.fromEntries(Object.entries(existing).filter(([issues]) => !sameName(issues, issueRepo)));
      return { ...file, codeRepos: { ...codeRepos, [issueRepo]: codeRepo } };
    });
  }

  // The orgs and repos chosen in settings [SRC-02].
  function saveCoverage(orgs: string[], repos: string[]): Promise<AttentionConfig> {
    return updateConfig((file) => ({ ...file, orgs, repos }));
  }

  // Where Next up looks, chosen in settings [NXT-04]. The fields and the rest of nextUp are kept.
  function saveNextUpSources(sources: Pick<AttentionConfig["nextUp"], "mine" | "orgs" | "repos">): Promise<AttentionConfig> {
    return updateConfig((file) => {
      const nextUp = file.nextUp && typeof file.nextUp === "object" ? (file.nextUp as Record<string, unknown>) : {};
      return { ...file, nextUp: { ...nextUp, ...sources } };
    });
  }

  // Which org issue fields Next up uses, from settings [NXT-04]: null turns one off, a role left out is kept as it is.
  // A field kept as it was keeps its order.
  function saveNextUpFields(fields: Partial<Record<FieldRole, string | null>>): Promise<AttentionConfig> {
    return updateConfig((file) => {
      const nextUp = file.nextUp && typeof file.nextUp === "object" ? (file.nextUp as Record<string, unknown>) : {};
      const chosen = Object.fromEntries(
        FIELD_ROLES.filter((role) => fields[role] !== undefined).map((role) => {
          const before = nextUp[role] as { field?: unknown } | null | undefined;
          const field = fields[role]!;
          return [role, field === null ? null : before && typeof before.field === "string" && sameName(before.field, field) ? { ...before, field } : { field }];
        }),
      );
      return { ...file, nextUp: { ...nextUp, ...chosen } };
    });
  }

  // Whether replies on others' threads count without a tag, from settings [ATT-17].
  function saveFollowThreads(followThreads: boolean): Promise<AttentionConfig> {
    return updateConfig((file) => ({ ...file, followThreads }));
  }

  // What the screen writes changes only its own keys; everything else in the file is kept as it is.
  // A file that doesn't read or parse is left alone.
  async function updateConfig(change: (file: Record<string, unknown>) => Record<string, unknown>): Promise<AttentionConfig> {
    const raw = await readJson(config);
    const current = AttentionConfig.safeParse(raw);
    if (!current.success) throw new Error(`${config} is invalid: ${current.error.message}`);
    const next = change(raw as Record<string, unknown>);
    const parsed = AttentionConfig.safeParse(next);
    if (!parsed.success) throw new Error(`${config} is invalid: ${parsed.error.message}`);
    await writeAtomically(config, `${JSON.stringify(next, null, 2)}\n`);
    return parsed.data;
  }

  async function writeAtomically(path: string, content: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, path);
  }

  async function loadState(): Promise<State> {
    const parsed = State.safeParse(await readJson(state).catch(() => ({})));
    // A cache that no longer parses (e.g. after an update) is simply dropped.
    return parsed.success ? parsed.data : State.parse({});
  }

  async function saveState(saved: State): Promise<void> {
    await writeAtomically(state, JSON.stringify(saved, null, 2));
  }

  return { moveOldFiles, loadConfig, saveCodeRepo, saveCoverage, saveNextUpSources, saveNextUpFields, saveFollowThreads, loadState, saveState };
}
export type Store = ReturnType<typeof createStore>;
