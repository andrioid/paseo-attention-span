import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Attention, Item, SectionId } from "../shared/attention";
import { AttentionConfig } from "../shared/config";

// Local files in ~/.config/paseo-attention-span/ [PRIV-01].
const CHOSEN_DIR = process.env.PASEO_ATTENTION_SPAN_DIR ?? process.env.PASEO_GITHUB_ATTENTION_DIR;
export const DIR = CHOSEN_DIR ?? join(homedir(), ".config", "paseo-attention-span");
// Where they lived while the plugin was called "GitHub attention".
const OLD_DIR = join(homedir(), ".config", "paseo-github-attention");
const CONFIG = join(DIR, "config.json");
const STATE = join(DIR, "state.json");

export const State = z.object({
  // Item key -> others' activity and section when dismissed [ATT-08].
  dismissed: z.record(z.string(), z.object({ at: z.string(), section: z.custom<SectionId>() })).default({}),
  // Scope chips picked on Next up; none means all [NXT-03].
  scopes: z.array(z.string()).default([]),
  // My Paseo projects' GitHub repos when last listed, for refreshes before the app has connected [NXT-08].
  projectRepos: z.array(z.string()).default([]),
  // The last fetch of each feed. A cache from an older version is dropped rather than shown wrong.
  live: z.object({ fetchedAt: z.string(), attention: z.custom<Attention>((value) => Array.isArray((value as Attention)?.unclaimed)) }).nullable().catch(null),
  history: z.object({ fetchedAt: z.string(), items: z.custom<Item[]>(Array.isArray) }).nullable().catch(null),
});
export type State = z.infer<typeof State>;

// Moves the old folder over once, unless a folder is chosen by environment variable.
export async function moveOldFiles(): Promise<void> {
  if (CHOSEN_DIR || (await exists(DIR)) || !(await exists(OLD_DIR))) return;
  await rename(OLD_DIR, DIR);
}

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

export async function loadConfig(): Promise<AttentionConfig> {
  const parsed = AttentionConfig.safeParse(await readJson(CONFIG));
  if (!parsed.success) throw new Error(`${CONFIG} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

// Where an issue repo's code lives, chosen on the screen [SES-07].
export function saveCodeRepo(issueRepo: string, codeRepo: string): Promise<AttentionConfig> {
  return updateConfig((file) => {
    const existing = file.codeRepos && typeof file.codeRepos === "object" ? (file.codeRepos as Record<string, unknown>) : {};
    const codeRepos = Object.fromEntries(Object.entries(existing).filter(([issues]) => issues.toLowerCase() !== issueRepo.toLowerCase()));
    return { ...file, codeRepos: { ...codeRepos, [issueRepo]: codeRepo } };
  });
}

// The orgs and repos chosen in settings [SRC-02].
export function saveCoverage(orgs: string[], repos: string[]): Promise<AttentionConfig> {
  return updateConfig((file) => ({ ...file, orgs, repos }));
}

// What the screen writes changes only its own keys; everything else in the file is kept as it is.
// A file that doesn't read or parse is left alone.
async function updateConfig(change: (file: Record<string, unknown>) => Record<string, unknown>): Promise<AttentionConfig> {
  const raw = await readJson(CONFIG);
  const current = AttentionConfig.safeParse(raw);
  if (!current.success) throw new Error(`${CONFIG} is invalid: ${current.error.message}`);
  const next = change(raw as Record<string, unknown>);
  const parsed = AttentionConfig.safeParse(next);
  if (!parsed.success) throw new Error(`${CONFIG} is invalid: ${parsed.error.message}`);
  await writeAtomically(CONFIG, `${JSON.stringify(next, null, 2)}\n`);
  return parsed.data;
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

export async function loadState(): Promise<State> {
  const parsed = State.safeParse(await readJson(STATE).catch(() => ({})));
  // A cache that no longer parses (e.g. after an update) is simply dropped.
  return parsed.success ? parsed.data : State.parse({});
}

export async function saveState(state: State): Promise<void> {
  await writeAtomically(STATE, JSON.stringify(state, null, 2));
}
