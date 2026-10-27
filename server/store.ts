import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InboxConfig } from "../shared/config";
import type { Inbox, Item, SectionId } from "../shared/inbox";

// Local files in ~/.config/paseo-github-attention/ [PRIV-01].
export const DIR = process.env.PASEO_GITHUB_ATTENTION_DIR ?? join(homedir(), ".config", "paseo-github-attention");
const CONFIG = join(DIR, "config.json");
const STATE = join(DIR, "state.json");

export const State = z.object({
  // Item key -> others' activity and section when dismissed [ATT-08].
  dismissed: z.record(z.string(), z.object({ at: z.string(), section: z.custom<SectionId>() })).default({}),
  // The last fetch of each feed. A cache from an older version is dropped rather than shown wrong.
  live: z.object({ fetchedAt: z.string(), inbox: z.custom<Inbox>((value) => Array.isArray((value as Inbox)?.unclaimed)) }).nullable().default(null),
  history: z.object({ fetchedAt: z.string(), items: z.custom<Item[]>(Array.isArray) }).nullable().default(null),
});
export type State = z.infer<typeof State>;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
}

export async function loadConfig(): Promise<InboxConfig> {
  const parsed = InboxConfig.safeParse(await readJson(CONFIG));
  if (!parsed.success) throw new Error(`${CONFIG} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

// The one setting the screen writes: everything else in the file is kept as it is [SES-07].
export async function saveCodeRepo(issueRepo: string, codeRepo: string): Promise<InboxConfig> {
  const raw = await readJson(CONFIG);
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const existing = file.codeRepos && typeof file.codeRepos === "object" ? (file.codeRepos as Record<string, unknown>) : {};
  const codeRepos = Object.fromEntries(Object.entries(existing).filter(([issues]) => issues.toLowerCase() !== issueRepo.toLowerCase()));
  const next = { ...file, codeRepos: { ...codeRepos, [issueRepo]: codeRepo } };
  const parsed = InboxConfig.safeParse(next);
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
