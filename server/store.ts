import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InboxConfig } from "../shared/config";
import type { Inbox, SectionId } from "../shared/inbox";

// Local files in ~/.config/paseo-github-attention/ [PRIV-01].
export const DIR = process.env.PASEO_GITHUB_ATTENTION_DIR ?? join(homedir(), ".config", "paseo-github-attention");
const CONFIG = join(DIR, "config.json");
const STATE = join(DIR, "state.json");

export const State = z.object({
  // Item key -> others' activity and section when dismissed [ATT-08].
  dismissed: z.record(z.string(), z.object({ at: z.string(), section: z.custom<SectionId>() })).default({}),
  // A cache from an older version is dropped rather than shown wrong.
  last: z.object({ fetchedAt: z.string(), inbox: z.custom<Inbox>((value) => Array.isArray((value as Inbox)?.unclaimed)) }).nullable().default(null),
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

export async function loadState(): Promise<State> {
  const parsed = State.safeParse(await readJson(STATE).catch(() => ({})));
  // A cache that no longer parses (e.g. after an update) is simply dropped.
  return parsed.success ? parsed.data : State.parse({});
}

export async function saveState(state: State): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const temporary = `${STATE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, STATE);
}
