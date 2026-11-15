import { describe, expect, it } from "vitest";
import type { NextUpIssue, ProjectInfo } from "./attention";
import { type FilterChange, type FilterKind, type NextUpFilterInput, nextUpFilter, repoGroups } from "./next-up-filter";
import { issue } from "./test-builders";

const board: ProjectInfo = {
  id: "P1",
  title: "Roadmap",
  statuses: [
    { name: "Todo", color: "GRAY" },
    { name: "Doing", color: "YELLOW" },
    { name: "Done", color: "GREEN" },
  ],
};
const onBoard = (status?: string) => [{ id: board.id, title: board.title, ...(status ? { status } : {}) }];

const input = (unclaimed: NextUpIssue[], fields: Partial<NextUpFilterInput> = {}): NextUpFilterInput => ({
  unclaimed,
  selected: [],
  sources: [],
  selectedSources: [],
  projects: [],
  selectedProjects: [],
  ...fields,
});

// Ticks in the sheet, saved the way the screen saves them.
function tick(from: NextUpFilterInput, ...taps: [FilterKind, string][]): NextUpFilterInput {
  return taps.reduce((state, [kind, id]) => {
    const change: FilterChange = nextUpFilter(state).toggle(kind, id);
    return {
      ...state,
      selected: change.scopes ?? state.selected,
      selectedSources: change.sources ?? state.selectedSources,
      selectedProjects: change.projectFilter ?? state.selectedProjects,
    };
  }, from);
}

const shownNumbers = (state: NextUpFilterInput) => nextUpFilter(state).shown.map((one) => one.number);
const options = (state: NextUpFilterInput, title: string) =>
  nextUpFilter(state).groups.find((group) => group.title === title)?.options.map((option) => `${option.indent ? "  " : ""}${option.label}${option.dim ? " (dim)" : ""}${option.state ? ` [${option.state}]` : ""}`);

describe("Next up filter", () => {
  const ui = issue("o/r#1", { scope: "ui" });
  const api = issue("o/r#2", { scope: "api" });

  it("NXT-03: ticking a scope shows only its issues, and the button counts it", () => {
    const state = tick(input([ui, api]), ["scopes", "ui"]);
    expect(shownNumbers(state)).toEqual([1]);
    expect(nextUpFilter(state).picked).toBe(1);
    expect(shownNumbers(tick(state, ["scopes", "ui"]))).toEqual([1, 2]);
  });

  it("NXT-03: a remembered scope no issue has any more is ignored", () => {
    const filter = nextUpFilter(input([api], { selected: ["ui"] }));
    expect(filter.shown.map((one) => one.number)).toEqual([2]);
    expect(filter.picked).toBe(0);
    expect(filter.empty).toBe("No unclaimed issues.");
  });

  it("NXT-03: scopes are offered in order, and none when no issue has one", () => {
    expect(options(input([ui, api]), "Scope")).toEqual(["api", "ui"]);
    expect(nextUpFilter(input([issue("o/r#3")])).groups).toEqual([]);
  });

  it("NXT-09: filters by source only when there's more than one, ignoring sources no longer in settings", () => {
    const mine = issue("o/r#1", { sources: ["mine"] });
    const org = issue("o/r#2", { sources: ["org:acme"] });
    const two = [
      { id: "mine", label: "My repos" },
      { id: "org:acme", label: "acme" },
    ];
    expect(shownNumbers(tick(input([mine, org], { sources: two }), ["sources", "org:acme"]))).toEqual([2]);
    expect(options(input([mine, org], { sources: two }), "Source")).toEqual(["My repos", "acme"]);
    // One source: nothing to choose, and an old tick doesn't narrow.
    const one = input([mine, org], { sources: [two[0]], selectedSources: ["org:acme"] });
    expect(nextUpFilter(one).groups).toEqual([]);
    expect(shownNumbers(one)).toEqual([1, 2]);
    expect(shownNumbers(input([mine, org], { sources: two, selectedSources: ["repo:gone/away"] }))).toEqual([1, 2]);
  });

  it("NXT-03, NXT-12: a project lists the board's statuses in order, dims unused ones, then retired ones, No status, and No project last", () => {
    const unclaimed = [
      issue("o/r#1", { projects: onBoard("Doing") }),
      issue("o/r#2", { projects: onBoard("Parked") }),
      issue("o/r#3", { projects: onBoard() }),
      issue("o/r#4", { projects: [] }),
    ];
    expect(options(input(unclaimed, { projects: [board] }), "Project")).toEqual([
      "Roadmap [off]",
      "  Todo (dim)",
      "  Doing",
      "  Done (dim)",
      "  Parked",
      "  No status",
      "No project",
    ]);
  });

  it("NXT-12: without readable projects there's no Project choice", () => {
    expect(nextUpFilter(input([issue("o/r#1")], { projects: [board] })).groups).toEqual([]);
  });

  it("NXT-03, NXT-12: ticking a project ticks all its statuses and counts once; partly ticked, ticking it clears them", () => {
    const unclaimed = [issue("o/r#1", { projects: onBoard("Doing") }), issue("o/r#2", { projects: onBoard("Todo") }), issue("o/r#3", { projects: [] })];
    const whole = tick(input(unclaimed, { projects: [board] }), ["projects", "P1"]);
    expect(options(whole, "Project")?.[0]).toBe("Roadmap [on]");
    expect(nextUpFilter(whole).picked).toBe(1);
    expect(shownNumbers(whole)).toEqual([1, 2]);

    const part = tick(input(unclaimed, { projects: [board] }), ["projects", "status:P1:Doing"], ["projects", "noproject"]);
    expect(options(part, "Project")?.[0]).toBe("Roadmap [partial]");
    expect(nextUpFilter(part).picked).toBe(2);
    expect(shownNumbers(part)).toEqual([1, 3]);
    const cleared = tick(part, ["projects", "P1"]);
    expect(options(cleared, "Project")?.[0]).toBe("Roadmap [off]");
    expect(shownNumbers(cleared)).toEqual([3]);
  });

  it("NXT-12: an issue whose boards are unknown is hidden by a project filter rather than called on no project", () => {
    const state = input([issue("o/r#1", { projects: [] }), issue("o/r#2")], { projects: [board], selectedProjects: ["noproject"] });
    expect(shownNumbers(state)).toEqual([1]);
  });

  it("NXT-03, NXT-09: with nothing left, Unclaimed says what narrowed it", () => {
    const sources = [
      { id: "mine", label: "My repos" },
      { id: "org:acme", label: "acme" },
    ];
    const state = input([issue("o/r#1", { sources: ["mine"], scope: "ui", projects: onBoard("Todo") }), issue("o/r#2", { sources: ["org:acme"], scope: "api", projects: [] })], {
      sources,
      projects: [board],
      selectedSources: ["mine"],
      selected: ["api"],
      selectedProjects: ["noproject"],
    });
    expect(nextUpFilter(state).empty).toBe("No unclaimed issues in these sources and projects and scopes.");
    expect(nextUpFilter({ ...state, selectedProjects: [] }).empty).toBe("No unclaimed issues in these sources and scopes.");
  });
});

describe("Unclaimed by repo", () => {
  // Already in NXT-02's order, as the server sends them.
  const ranked = [issue("acme/shop#1"), issue("acme/api#2"), issue("acme/shop#3"), issue("me/tool#4"), issue("acme/api#5")];
  const grouped = (shown: NextUpIssue[]) => repoGroups(shown)?.map((group) => `${group.repo}: ${group.issues.map((one) => one.number).join(",")}`);

  it("NXT-14: groups by repository, the one with the top issue first, each keeping NXT-02's order", () => {
    expect(grouped(ranked)).toEqual(["acme/shop: 1,3", "acme/api: 2,5", "me/tool: 4"]);
  });

  it("NXT-14: a repository's issues stay together whatever the case of its name", () => {
    expect(grouped([issue("acme/shop#1"), issue("acme/api#2"), issue("Acme/Shop#3")])).toEqual(["acme/shop: 1,3", "acme/api: 2"]);
  });

  it("NXT-14: with one repository shown there's nothing to group, even when the filter narrowed it down", () => {
    expect(repoGroups([issue("acme/shop#1"), issue("acme/shop#3")])).toBeNull();
    expect(repoGroups([])).toBeNull();
    const sources = [
      { id: "org:acme", label: "acme" },
      { id: "mine", label: "My repos" },
    ];
    const state = input([issue("acme/shop#1", { sources: ["org:acme"] }), issue("me/tool#4", { sources: ["mine"] })], { sources, selectedSources: ["mine"] });
    expect(repoGroups(nextUpFilter(state).shown)).toBeNull();
  });
});
