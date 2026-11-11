import type { FailingChecks } from "./attention";

// What Rerun failed jobs says about a PR's failing checks, in one line: how many failed, which, and whether they were rerun
// before, so a flaky check can be told from a real failure [PRS-09].

export interface CheckGroup {
  // A matrix's jobs share the name before " (": e2e (chromium) and e2e (firefox) are e2e. A job alone keeps its full name.
  name: string;
  count: number;
  // Checks from GitHub Actions can be rerun; other status checks can't.
  rerunnable: boolean;
}

export interface RerunSummary {
  failed: number;
  // Of those, the ones from GitHub Actions.
  rerunnable: number;
  // How often the failing runs were rerun already: the most of any run.
  reruns: number;
  // Each PR with failing checks, grouped; more than one only for a stack of mine [ATT-04].
  prs: { pr: number; groups: CheckGroup[] }[];
  runIds: number[];
}

const matrixName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "") || name;

// Checks in the order they came, a matrix's jobs as one group with a count. Ones that can't rerun stay apart from ones that can.
export function groupChecks(checks: FailingChecks["checks"]): CheckGroup[] {
  const groups = new Map<string, { base: string; names: string[]; rerunnable: boolean }>();
  for (const check of checks) {
    const base = matrixName(check.name);
    const key = `${check.rerunnable}:${base}`;
    const group = groups.get(key) ?? { base, names: [], rerunnable: check.rerunnable };
    group.names.push(check.name);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ base, names, rerunnable }) => ({ name: names.length === 1 ? names[0] : base, count: names.length, rerunnable }));
}

export function summarizeRerun(failing: FailingChecks[]): RerunSummary {
  const checks = failing.flatMap((f) => f.checks);
  const runs = failing.flatMap((f) => f.runs);
  return {
    failed: checks.length,
    rerunnable: checks.filter((check) => check.rerunnable).length,
    reruns: Math.max(0, ...runs.map((run) => run.attempt - 1)),
    prs: failing.filter((f) => f.checks.length > 0).map((f) => ({ pr: f.pr, groups: groupChecks(f.checks) })),
    runIds: runs.map((run) => run.id),
  };
}

// "e2e ×3", or the job's own name.
export const groupLabel = (group: CheckGroup) => (group.count > 1 ? `${group.name} ×${group.count}` : group.name);

// "rerun once", "rerun 2×", "not rerun".
export const rerunHistory = (reruns: number) => (reruns === 0 ? "not rerun" : reruns === 1 ? "rerun once" : `rerun ${reruns}×`);

// Every failing check by its full name, one per line, under its PR in a stack, saying which can't rerun: the hint, and what a
// screen reader hears.
export function failingList(failing: FailingChecks[]): string {
  const stack = failing.filter((f) => f.checks.length > 0).length > 1;
  return failing
    .filter((f) => f.checks.length > 0)
    .flatMap((f) => [...(stack ? [`#${f.pr}`] : []), ...f.checks.map((check) => `${stack ? "  " : ""}${check.name}${check.rerunnable ? "" : " · not GitHub Actions, can't rerun"}`)])
    .join("\n");
}
