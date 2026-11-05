import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type UpdateNotice, updateNotice } from "../shared/update";
import { ourInstall } from "./feedback";
import { FIXTURE } from "./gh";

const run = promisify(execFile);

// Paseo's registry checks npm twice a day, so a release reaches its listing within about 12 hours [UPD-01].
const EVERY_MS = 12 * 60 * 60 * 1000;
// A check that failed (offline, an older Paseo) is tried again sooner.
const RETRY_MS = 60 * 60 * 1000;

// Previews have nothing to update; PASEO_ATTENTION_SPAN_FIXTURE_UPDATE=1 makes one up to show the notice.
const FIXTURE_UPDATE: UpdateNotice = {
  id: "attention-span",
  current: "0.4.3",
  latest: "0.5.0",
  source: "registry",
  args: ["--yes"],
  command: "paseo plugin update attention-span",
  notes: "https://github.com/andrioid/paseo-attention-span/releases",
};

// Asks Paseo itself, so the answer is what `paseo plugin update` would install: a registry install's
// reviewed pin, npm's latest, or a Git remote's HEAD. Directory installs are never updated, so they say nothing.
export class UpdateCheck {
  private last: { at: number; ttl: number; notice: UpdateNotice | null } | null = null;
  private inFlight: Promise<UpdateNotice | null> | null = null;
  // Why the last Update failed. A successful one restarts this process, so nothing needs remembering then.
  private failed: { latest: string; error: string } | null = null;

  async get(): Promise<UpdateNotice | null> {
    const notice = await this.cached();
    return notice && this.failed?.latest === notice.latest ? { ...notice, error: this.failed.error } : notice;
  }

  private cached(): Promise<UpdateNotice | null> {
    if (this.last && Date.now() - this.last.at < this.last.ttl) return Promise.resolve(this.last.notice);
    this.inFlight ??= check()
      .then(
        (notice) => (this.last = { at: Date.now(), ttl: EVERY_MS, notice }),
        (error) => {
          console.error("Checking for an Attention Span update failed:", (error as Error).message);
          return (this.last = { at: Date.now(), ttl: RETRY_MS, notice: null });
        },
      )
      .then((last) => last.notice)
      .finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  // Update, from an explicit tap on the version it names [SAFE-01]. `paseo plugin update` installs it and
  // restarts the plugin, which ends this process, so it runs detached and outlives it. Until then, a failure
  // is kept for the notice to show.
  async apply(latest: string): Promise<void> {
    const notice = await this.cached();
    if (!notice || notice.latest !== latest) throw new Error(`${latest} isn't the update on offer any more. Check again.`);
    this.failed = null;
    // Previews show how a failed update looks.
    if (FIXTURE) return void (this.failed = { latest, error: "Previews don't update." });
    const cli = process.env.PASEO_CLI || "paseo";
    const child = spawn(cli, ["plugin", "update", notice.id, ...notice.args, "--json", ...home()], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => (this.failed = { latest, error: error.message }));
    child.on("close", (code) => {
      const error = failure(notice.id, output, code);
      if (error) {
        console.error("Updating Attention Span failed:", error);
        this.failed = { latest, error };
      }
    });
    child.unref();
  }
}

async function check(): Promise<UpdateNotice | null> {
  if (FIXTURE) return process.env.PASEO_ATTENTION_SPAN_FIXTURE_UPDATE === "1" ? FIXTURE_UPDATE : null;
  const ours = ourInstall();
  if (!ours) return null;
  // Paseo gives its plugins the path of its CLI and its home, so this asks the daemon the plugin runs in.
  const cli = process.env.PASEO_CLI || "paseo";
  try {
    const { stdout } = await run(cli, ["plugin", "update", ours.id, "--check", "--json", ...home()], { timeout: 60_000 });
    return updateNotice(ours.id, JSON.parse(stdout));
  } catch (error) {
    // An "error" outcome exits 1 but still prints its JSON.
    throw new Error(failure(ours.id, (error as { stdout?: string }).stdout ?? "", 1) ?? (error as Error).message);
  }
}

const home = () => (process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : []);

// The CLI's reason for this plugin, from its JSON, or its output; null when it worked.
export function failure(id: string, output: string, code: number | null): string | null {
  try {
    const entry = (JSON.parse(output) as { id?: string; outcome?: string; error?: string }[]).find((candidate) => candidate.id === id);
    if (entry?.outcome === "error") return entry.error ?? "paseo plugin update failed";
    if (entry && code === 0) return null;
  } catch {
    // Not JSON: an older CLI, or it failed before it got that far.
  }
  return code === 0 ? null : output.trim().split("\n").pop() || `paseo plugin update exited with ${code}`;
}
