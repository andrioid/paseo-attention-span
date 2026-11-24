import { describe, expect, it } from "vitest";
import type { Item } from "./attention";
import { item as base } from "./test-builders";
import { historyWeeks, weekOf } from "./history-report";

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const item = (number: number, section: Item["section"], closedDays: number, fields: Partial<Item> = {}) =>
  base(`acme/shop#${number}`, section, { title: `Item ${number}`, othersActivityAt: daysAgo(closedDays), closedAt: daysAgo(closedDays), ...fields });

// All in one week, whatever day today is: the same instant.
const sameWeek = (fields: Partial<Item> = {}) => ({ ...fields, closedAt: daysAgo(0), othersActivityAt: daysAgo(0) });

describe("History's weeks and their copy", () => {
  const done = item(1, "done", 0, { ...sameWeek(), work: { name: "bug", kind: "bug" } });
  const notPlanned = item(2, "done", 0, { ...sameWeek(), kind: "issue", notPlanned: true });
  const reviewed = item(3, "reviewed", 0, sameWeek());
  const handed = item(4, "handed_off", 0, sameWeek());
  const unread = item(5, "changed", 0, sameWeek());
  const all = [done, notPlanned, reviewed, handed, unread];

  it("HIS-01, HIS-03: Finished only by default; the copy leaves out issues closed as not planned", () => {
    const { weeks } = historyWeeks(all, []);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].done.map((entry) => entry.number)).toEqual([1, 2]);
    expect(weeks[0].reviewed).toEqual([]);
    expect(weeks[0].changed).toEqual([]);
    expect(weeks[0].copy).toEqual({ text: "- 🐞 [Item 1](https://github.com/acme/shop/pull/1)", links: 1 });
  });

  it("HIS-04: epics and debt lead with their own emoji; a type it doesn't know leads a PR with 🔀 and an issue with nothing", () => {
    const week = (...items: Item[]) => historyWeeks(items, []).weeks[0].copy.text;
    const epic = item(6, "done", 0, { ...sameWeek(), kind: "issue", work: { name: "epic", kind: "epic" } });
    const debt = item(7, "done", 0, { ...sameWeek(), kind: "issue", work: { name: "debt", kind: "debt" } });
    const spikePr = item(8, "done", 0, { ...sameWeek(), work: { name: "spike" } });
    const spikeIssue = item(9, "done", 0, { ...sameWeek(), kind: "issue", work: { name: "spike" } });
    expect(week(epic, debt, spikePr, spikeIssue).split("\n").map((line) => line.split(" [")[0])).toEqual(["- 🏔️", "- 🧾", "-", "- 🔀"]);
  });

  it("HIS-02, HIS-03: each copied list is sorted by kind, epics and features first and PRs of no kind last, newest first within each", () => {
    // Seconds apart on a Wednesday, so they share a week whenever the test runs.
    const at = (section: Item["section"], seconds: number, fields: Partial<Item> = {}) => {
      const closedAt = new Date(new Date(2026, 10, 18, 12).getTime() - seconds * 1000).toISOString();
      return { ...fields, section, closedAt, othersActivityAt: closedAt };
    };
    const finished = [
      at("done", 1),
      at("done", 2, { work: { name: "bug", kind: "bug" } }),
      at("done", 3, { kind: "issue", work: { name: "spike" } }),
      at("done", 4, { work: { name: "task", kind: "task" } }),
      at("done", 5, { work: { name: "feature", kind: "feature" } }),
      at("done", 6, { kind: "issue" }),
      at("done", 7, { work: { name: "debt", kind: "debt" } }),
      at("done", 8, { work: { name: "epic", kind: "epic" } }),
      at("done", 9, { work: { name: "feature", kind: "feature" } }),
    ];
    // Out of order on purpose: the copy doesn't lean on the order they arrive in.
    const reviewed = [at("reviewed", 13), at("reviewed", 11, { work: { name: "bug", kind: "bug" } }), at("reviewed", 10), at("reviewed", 12, { work: { name: "feature", kind: "feature" } })];
    const items = [...finished, ...reviewed].map((fields, index) => item(index + 1, fields.section, 0, fields));
    const [week] = historyWeeks(items, ["reviewed"]).weeks;
    const [finishedText, reviewedText] = week.copy.text.split("## Reviewed");
    const numbers = (text: string) => [...text.matchAll(/Item (\d+)/g)].map((match) => Number(match[1]));
    expect(numbers(finishedText)).toEqual([8, 5, 9, 2, 7, 4, 3, 6, 1]);
    expect(numbers(reviewedText)).toEqual([13, 11, 12, 10]);
    expect(week.done.map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(week.reviewed.map((entry) => entry.number)).toEqual([10, 11, 12, 13]);
  });

  it("HIS-02, HIS-03: with Reviewed shown, the copy has both lists under their headings", () => {
    const [week] = historyWeeks(all, ["reviewed"]).weeks;
    expect(week.reviewed.map((entry) => entry.number)).toEqual([3]);
    expect(week.copy.text).toBe("## Finished\n\n- 🐞 [Item 1](https://github.com/acme/shop/pull/1)\n\n## Reviewed\n\n- 🔀 [Item 3](https://github.com/acme/shop/pull/3)");
    expect(week.copy.links).toBe(2);
  });

  it("HIS-06, HIS-07: cleared changes show when asked, never in the copy; unread notes are never in a week", () => {
    const [week] = historyWeeks(all, ["changed"]).weeks;
    expect(week.changed.map((entry) => entry.number)).toEqual([4]);
    expect(week.copy.links).toBe(1);
    expect(historyWeeks(all, ["reviewed", "changed"]).weeks.flatMap((entry) => [...entry.done, ...entry.reviewed, ...entry.changed]).map((entry) => entry.number)).not.toContain(5);
  });

  it("HIS-07: a week of only what the filter hides isn't shown, but still keeps the Filter button", () => {
    expect(historyWeeks([reviewed], [])).toEqual({ weeks: [], anything: true });
    expect(historyWeeks([reviewed], ["reviewed"]).weeks).toHaveLength(1);
    expect(historyWeeks([unread], [])).toEqual({ weeks: [], anything: false });
  });

  it("HIS-01: newest week first, Monday-start", () => {
    const weeks = historyWeeks([item(1, "done", 20), item(2, "done", 0)], []).weeks;
    expect(weeks.map((week) => week.done[0].number)).toEqual([2, 1]);
    expect(weekOf(daysAgo(0)).getDay()).toBe(1);
  });
});
