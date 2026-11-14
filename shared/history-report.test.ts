import { describe, expect, it } from "vitest";
import type { Item } from "./attention";
import { historyWeeks, weekOf } from "./history-report";

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

function item(number: number, section: Item["section"], closedDays: number, fields: Partial<Item> = {}): Item {
  return {
    key: `acme/shop#${number}`,
    section,
    kind: "pr",
    draft: false,
    repo: "acme/shop",
    number,
    title: `Item ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    chips: [],
    actions: [],
    children: [],
    target: { kind: "pr", repo: "acme/shop", number, title: `Item ${number}`, url: "u" },
    othersActivityAt: daysAgo(closedDays),
    closedAt: daysAgo(closedDays),
    ...fields,
  };
}

// All in one week, whatever day today is: the same instant.
const sameWeek = (fields: Partial<Item> = {}) => ({ ...fields, closedAt: daysAgo(0), othersActivityAt: daysAgo(0) });

describe("History's weeks and their copy", () => {
  const done = item(1, "done", 0, { ...sameWeek(), work: "bug" });
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
