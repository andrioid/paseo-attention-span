import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FeedbackInfo } from "../shared/feedback";

const run = promisify(execFile);

// Where this plugin is installed and which version it is [FB-01].
export async function feedbackInfo(): Promise<FeedbackInfo> {
  const dir = pluginDir();
  if (!dir) return { cwd: homedir(), hasSource: false, version: null };
  return { cwd: dir, hasSource: true, version: await version(dir) };
}

function pluginDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++, dir = dirname(dir)) {
    if (existsSync(join(dir, "paseo-plugin.json"))) return dir;
  }
  return null;
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
