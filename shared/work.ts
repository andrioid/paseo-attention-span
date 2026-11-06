// What kind of work an issue or PR was, for History's chips and copied lines [HIS-04].
export type WorkKind = "bug" | "feature" | "task";

export const WORK_EMOJI: Record<WorkKind, string> = { bug: "🐞", feature: "🚀", task: "🔧" };
// A PR that's none of the above still leads its copied line with something.
export const PR_EMOJI = "🔀";

// Most telling first: anything that says bug is a bug.
const RANK: WorkKind[] = ["bug", "feature", "task"];

// Issue type and label names, matched whole so "not a bug" and "bug bash" don't count.
const NAMES: Record<string, WorkKind> = {
  bug: "bug",
  bugs: "bug",
  bugfix: "bug",
  "bug fix": "bug",
  "bug report": "bug",
  defect: "bug",
  regression: "bug",
  feature: "feature",
  features: "feature",
  "feature request": "feature",
  "new feature": "feature",
  enhancement: "feature",
  epic: "feature",
  story: "feature",
  "user story": "feature",
  task: "task",
  chore: "task",
  maintenance: "task",
};

// Conventional Commit types: "fix: …", "feat(api)!: …". Some only make sense at the front of a title.
const PREFIXES: Record<string, WorkKind> = {
  fix: "bug",
  feat: "feature",
  chore: "task",
  refactor: "task",
  docs: "task",
  build: "task",
  ci: "task",
  test: "task",
  perf: "task",
  style: "task",
};

// "Type: Bug 🐞", "kind/bug", "T-Feature" -> "bug", "bug", "feature".
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:type|kind|t|issue type|category) /, "");
}

const named = (name: string): WorkKind | undefined => NAMES[normalize(name)];

// The first source that says anything decides: issue type, then labels, then the title's prefix.
// Within labels, bug beats feature beats task. Unknown is a fine answer.
export function workKind({ type, labels = [], title }: { type?: string | null; labels?: string[]; title: string }): WorkKind | undefined {
  const typed = type ? named(type) : undefined;
  if (typed) return typed;
  const labelled = new Set(labels.map(named));
  const best = RANK.find((kind) => labelled.has(kind));
  if (best) return best;
  const prefix = /^\s*([a-z]+)(?:\([^)]*\))?!?:\s/i.exec(title)?.[1].toLowerCase();
  return prefix ? PREFIXES[prefix] : undefined;
}

// What leads an item's copied line: its kind, a PR's own mark, or nothing.
export function workEmoji(item: { kind: "pr" | "issue"; work?: WorkKind }): string | undefined {
  return item.work ? WORK_EMOJI[item.work] : item.kind === "pr" ? PR_EMOJI : undefined;
}

// Chips are plain words like every other chip; the emoji are for the copied lines.
export const workChip = (kind: WorkKind) => ({ text: kind, tone: "neutral" as const });
