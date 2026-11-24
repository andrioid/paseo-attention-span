// What kind of work an issue or PR is, the same in Next up and History [HIS-04, NXT-15].
export type WorkKind = "bug" | "feature" | "epic" | "debt" | "task";

// A kind it knows, or an issue type it doesn't, by that type's own name.
export interface Work {
  name: string;
  kind?: WorkKind;
}

export const WORK_EMOJI: Record<WorkKind, string> = { bug: "🐞", feature: "🚀", epic: "🏔️", debt: "🧾", task: "🔧" };
// A PR of no kind it knows still leads its copied line with something.
export const PR_EMOJI = "🔀";

// Most telling first: anything that says bug is a bug, and an epic outranks the features in it.
const RANK: WorkKind[] = ["bug", "epic", "feature", "debt", "task"];

// Issue type and label names, matched whole so "not a bug" and "bug bash" don't count. A Map, so a name like
// "constructor" finds nothing.
const NAMES = new Map<string, WorkKind>([
  ["bug", "bug"],
  ["bugs", "bug"],
  ["bugfix", "bug"],
  ["bug fix", "bug"],
  ["bug report", "bug"],
  ["defect", "bug"],
  ["regression", "bug"],
  ["feature", "feature"],
  ["features", "feature"],
  ["feature request", "feature"],
  ["new feature", "feature"],
  ["enhancement", "feature"],
  ["story", "feature"],
  ["user story", "feature"],
  ["epic", "epic"],
  ["debt", "debt"],
  ["tech debt", "debt"],
  ["technical debt", "debt"],
  ["refactor", "debt"],
  ["task", "task"],
  ["chore", "task"],
  ["maintenance", "task"],
]);

// Conventional Commit types: "fix: …", "feat(api)!: …". Some only make sense at the front of a title.
const PREFIXES = new Map<string, WorkKind>([
  ["fix", "bug"],
  ["feat", "feature"],
  ["refactor", "debt"],
  ["chore", "task"],
  ["docs", "task"],
  ["build", "task"],
  ["ci", "task"],
  ["test", "task"],
  ["perf", "task"],
  ["style", "task"],
]);

// "Type: Bug 🐞", "kind/bug", "T-Feature" -> "bug", "bug", "feature".
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:type|kind|t|issue type|category) /, "");
}

const named = (name: string): WorkKind | undefined => NAMES.get(normalize(name));
const known = (kind: WorkKind): Work => ({ name: kind, kind });

// The first source that says anything decides: issue type, then labels, then the title's prefix. An issue type it doesn't
// know still decides, by its own name, since someone chose it. Within labels, bug beats epic beats feature beats debt beats
// task. Unknown is a fine answer.
export function workOf({ type, labels = [], title }: { type?: string | null; labels?: string[]; title: string }): Work | undefined {
  const typeName = type?.trim();
  if (typeName) {
    const typed = named(typeName);
    return typed ? known(typed) : { name: typeName.toLowerCase() };
  }
  const labelled = new Set(labels.map(named));
  const best = RANK.find((kind) => labelled.has(kind));
  if (best) return known(best);
  const prefix = /^\s*([a-z]+)(?:\([^)]*\))?!?:\s/i.exec(title)?.[1].toLowerCase();
  const prefixed = prefix ? PREFIXES.get(prefix) : undefined;
  return prefixed ? known(prefixed) : undefined;
}

// What leads an item's copied line: its kind's emoji, a PR's own mark, or nothing.
export function workEmoji(item: { kind: "pr" | "issue"; work?: Work }): string | undefined {
  return item.work?.kind ? WORK_EMOJI[item.work.kind] : item.kind === "pr" ? PR_EMOJI : undefined;
}

// Chips are plain words like every other chip; the emoji are for the copied lines.
export const workChip = (work: Work) => ({ text: work.name, tone: "neutral" as const });
