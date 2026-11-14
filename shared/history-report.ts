import type { HistoryFilter, Item } from "./attention";
import { linkList } from "./format";
import { workEmoji } from "./work";

// History's weeks: what each shows under the filter, and what its copy button copies [HIS-01, HIS-02, HIS-03, HIS-06, HIS-07].
// Pure, so the report's rules are testable; client/history.tsx draws it.

export interface HistoryWeek {
  // The week's Monday, at midnight in the device's time zone.
  monday: Date;
  done: Item[];
  // Others' merged PRs I reviewed, when Reviewed is shown [HIS-02].
  reviewed: Item[];
  // Cleared changes by others that aren't finished work, when Changed by others is shown [HIS-06, HIS-07].
  changed: Item[];
  // Markdown lists per kind, and how many links; never changes by others, nor issues closed as not planned [HIS-03, HIS-04].
  copy: { text: string; links: number };
}

// Monday-start weeks in the device's time zone.
export function weekOf(iso: string): Date {
  const day = new Date(iso);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

const newestFirst = (a: Item, b: Item) => b.closedAt!.localeCompare(a.closedAt!);

// The weeks with anything shown, newest first, and whether any week holds anything at all, even only what the filter
// hides: then the Filter button stays, so it can be turned on. Unread notes aren't in weeks; they sit above them.
export function historyWeeks(items: Item[], filter: HistoryFilter[]): { weeks: HistoryWeek[]; anything: boolean } {
  const byWeek = new Map<number, Item[]>();
  for (const item of items) {
    if (item.section === "changed" || !item.closedAt) continue;
    const week = weekOf(item.closedAt).getTime();
    byWeek.set(week, [...(byWeek.get(week) ?? []), item]);
  }
  const weeks = [...byWeek]
    .sort((a, b) => b[0] - a[0])
    .map(([week, all]): HistoryWeek => {
      const done = all.filter((item) => item.section === "done").sort(newestFirst);
      const reviewed = filter.includes("reviewed") ? all.filter((item) => item.section === "reviewed") : [];
      // A merge or an issue close someone else did is the week's Finished, so it isn't here too [HIS-07].
      const changed = filter.includes("changed") ? all.filter((item) => item.section === "handed_off").sort(newestFirst) : [];
      return { monday: new Date(week), done, reviewed, changed, copy: weekCopy(done, reviewed) };
    })
    .filter((week) => week.done.length + week.reviewed.length + week.changed.length > 0);
  return { weeks, anything: byWeek.size > 0 };
}

// What was done, each led by its kind, then what I reviewed when that's shown, each under its own heading when both are
// there. Not planned issues stay on screen but out of the report [HIS-03, HIS-04].
function weekCopy(done: Item[], reviewed: Item[]): HistoryWeek["copy"] {
  const finished = done.filter((item) => !item.notPlanned);
  const list = (items: Item[]) => linkList(items.map((item) => ({ title: item.title, url: item.url, mark: workEmoji(item) })));
  const finishedText = list(finished);
  const reviewedText = list(reviewed);
  const text = [finishedText && reviewedText ? `## Finished\n\n${finishedText}` : finishedText, reviewedText ? `## Reviewed\n\n${reviewedText}` : ""].filter(Boolean).join("\n\n");
  return { text, links: finished.length + reviewed.length };
}
