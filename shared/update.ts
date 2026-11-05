import { FEEDBACK_REPO } from "./feedback";

// A newer Attention Span than the one installed, as Paseo's own update check sees it [UPD-01].
export interface UpdateNotice {
  // The runtime ID it's installed under, which the command names.
  id: string;
  // A version for npm and registry installs, a short commit for Git ones.
  current: string;
  latest: string;
  // Where it comes from, said next to Update.
  source: "registry" | "npm" | "git";
  // What Update adds to `paseo plugin update <id>`, pinned to what was offered where Paseo allows it.
  args: string[];
  // To run by hand when Update fails.
  command: string;
  // Where to read what changed.
  notes: string;
  // Why the last Update failed, if it did.
  error?: string;
}

// The entry for one plugin in `paseo plugin update <id> --check --json`. Only what's read here.
interface CheckEntry {
  id?: string;
  outcome?: string;
  current?: { currentRevision?: string; identity?: { registry?: unknown } };
  target?: { kind?: string; version?: string; commit?: string };
  links?: string[];
}

// Only "update" is news; "current", "local" (a directory install, which Paseo never updates) and "error" aren't.
export function updateNotice(id: string, checked: unknown): UpdateNotice | null {
  const entries = (Array.isArray(checked) ? checked : []) as CheckEntry[];
  const entry = entries.find((candidate) => candidate?.id === id);
  if (entry?.outcome !== "update") return null;
  const current = entry.current?.currentRevision;
  const latest = entry.target?.kind === "git" ? entry.target.commit : entry.target?.version;
  if (!current || !latest || current === latest) return null;
  const git = entry.target?.kind === "git";
  const source = git ? "git" : entry.current?.identity?.registry ? "registry" : "npm";
  // A registry install takes only its reviewed pin, so it can't be named; npm and Git can, so a newer one can't slip in.
  const args = source === "registry" ? ["--yes"] : git ? ["--ref", latest] : ["--version", latest];
  // A Git install moves by commit, so Paseo's compare link is what changed; a release has notes on GitHub.
  const compare = git ? entry.links?.find((link) => link.includes("/compare/")) : undefined;
  return { id, current: short(current), latest: short(latest), source, args, command: `paseo plugin update ${id}`, notes: compare ?? `https://github.com/${FEEDBACK_REPO}/releases` };
}

const short = (revision: string) => (/^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision);
