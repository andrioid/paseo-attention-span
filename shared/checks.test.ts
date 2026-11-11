import { describe, expect, it } from "vitest";
import { failingList, groupChecks, groupLabel, rerunHistory, summarizeRerun } from "./checks";

const actions = (name: string) => ({ name, rerunnable: true });

describe("groupChecks", () => {
  it("PRS-09: groups a matrix's jobs by the name before the brackets, in the order they came", () => {
    const groups = groupChecks(["lint", "e2e (chromium)", "e2e (firefox)", "unit (node 20)", "e2e (webkit)", "unit (node 22)", "typecheck"].map(actions));
    expect(groups.map(groupLabel)).toEqual(["lint", "e2e ×3", "unit ×2", "typecheck"]);
  });

  it("PRS-09: a job alone keeps its full name, so it's clear which one failed", () => {
    expect(groupChecks([actions("e2e (webkit)")]).map(groupLabel)).toEqual(["e2e (webkit)"]);
  });

  it("PRS-09: keeps checks that can't rerun apart from Actions jobs of the same name", () => {
    expect(groupChecks([actions("deploy (preview)"), { name: "deploy (prod)", rerunnable: false }])).toEqual([
      { name: "deploy (preview)", count: 1, rerunnable: true },
      { name: "deploy (prod)", count: 1, rerunnable: false },
    ]);
  });
});

describe("summarizeRerun", () => {
  it("PRS-09: counts what failed, what can rerun, and the most any run was rerun", () => {
    const summary = summarizeRerun([
      { pr: 101, checks: [actions("lint"), { name: "Vercel", rerunnable: false }], runs: [{ id: 1, attempt: 1 }, { id: 2, attempt: 3 }] },
    ]);
    expect(summary).toMatchObject({ failed: 2, rerunnable: 1, reruns: 2, runIds: [1, 2] });
  });

  it("ATT-04: a stack's PRs each keep their own groups; PRs without failures are left out", () => {
    const summary = summarizeRerun([
      { pr: 101, checks: [actions("e2e (a)"), actions("e2e (b)")], runs: [{ id: 1, attempt: 1 }] },
      { pr: 102, checks: [], runs: [] },
      { pr: 103, checks: [actions("unit (node 22)")], runs: [{ id: 3, attempt: 1 }] },
    ]);
    expect(summary.prs.map((p) => [p.pr, p.groups.map(groupLabel)])).toEqual([
      [101, ["e2e ×2"]],
      [103, ["unit (node 22)"]],
    ]);
    expect(summary.reruns).toBe(0);
  });
});

describe("rerunHistory", () => {
  it("PRS-09: says whether the failing runs were rerun before", () => {
    expect([0, 1, 2].map(rerunHistory)).toEqual(["not rerun", "rerun once", "rerun 2×"]);
  });
});

describe("failingList", () => {
  it("PRS-09: lists every failing check by its full name, saying which can't rerun", () => {
    expect(failingList([{ pr: 101, checks: [actions("e2e (webkit)"), { name: "Vercel", rerunnable: false }], runs: [] }])).toBe(
      "e2e (webkit)\nVercel · not GitHub Actions, can't rerun",
    );
  });

  it("ATT-04: puts each check under its PR in a stack", () => {
    expect(failingList([
      { pr: 101, checks: [actions("lint")], runs: [] },
      { pr: 102, checks: [actions("unit")], runs: [] },
    ])).toBe("#101\n  lint\n#102\n  unit");
  });
});
