import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FeedbackInfo } from "../shared/feedback";

const run = promisify(execFile);

// A scratch directory for the session, where this plugin is installed and which version it is [FB-01].
export async function feedbackInfo(): Promise<FeedbackInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "attention-span-feedback-"));
  const source = pluginDir();
  return { cwd, source, version: source ? await version(source) : null };
}

// Paseo evaluates the server as a bundle, so it has no file location of its own (import.meta.url is undefined).
// Paseo's config.json records where each plugin's source is: take this plugin's, by its manifest's ID.
export function pluginDir(paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo")): string | null {
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")) as { plugins?: Record<string, { path?: string }> };
    const ours = Object.entries(plugins)
      .filter(([, source]) => source.path && manifestId(source.path) === PLUGIN_ID)
      .sort(([a], [b]) => Number(b === PLUGIN_ID) - Number(a === PLUGIN_ID));
    return ours[0]?.[1].path ?? null;
  } catch {
    return null;
  }
}

const PLUGIN_ID = "attention-span";

function manifestId(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "paseo-plugin.json"), "utf8")) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

// package.json's version, which is a placeholder in a checkout: then the commit.
async function version(dir: string): Promise<string | null> {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    if (version && !version.startsWith("0.0.0")) return version;
  } catch {}
  try {
    const { stdout } = await run("git", ["-C", dir, "describe", "--always", "--dirty", "--tags"]);
    return `commit ${stdout.trim()}`;
  } catch {
    return null;
  }
}
