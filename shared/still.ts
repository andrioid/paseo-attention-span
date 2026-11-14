import type { AttentionView, FeedStatus } from "./attention";
import { historyWeeks } from "./history-report";

// The empty tabs: a horizon that follows the device's clock [ATT-18, HIS-08, WAI-04, NXT-13].
export type Scene = "morning" | "midday" | "evening" | "night";

// Fixed local hours, the same every day: morning 5–11, midday 11–16, evening 16–21, night 21–5.
export function sceneAt(date: Date): Scene {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "evening";
  return "night";
}

// Calm only when it's true: a refresh of the tab's feed worked. Loading, a failed refresh or none yet show plainly.
const refreshed = (feed: FeedStatus, failed: boolean) => !!feed.fetchedAt && !feed.error && !failed;

// Doing is empty. Dismissed items don't count; they're not on me until something new happens [ATT-08].
// Wrap up's rows do: the horizon waits for them [ATT-18, ATT-22].
export function isClear(view: Pick<AttentionView, "doing" | "feeds">, failed = false, wrap = 0): boolean {
  return view.doing.length === 0 && wrap === 0 && refreshed(view.feeds.live, failed);
}

// Nothing waits on anyone [WAI-04].
export function waitingClear(view: Pick<AttentionView, "waiting" | "feeds">, failed = false): boolean {
  return view.waiting.length === 0 && refreshed(view.feeds.live, failed);
}

// Nothing finished in History's weeks and no unread notes above them. A filter hiding everything isn't rest:
// that week still holds something, so it shows plainly [HIS-08].
export function historyClear(view: Pick<AttentionView, "history" | "feeds">, notes: number, failed = false): boolean {
  return notes === 0 && !historyWeeks(view.history, []).anything && refreshed(view.feeds.history, failed);
}

// Next up with nothing in it at all, not even behind a filter [NXT-13]. Nowhere to look is a setting, so it shows
// straight away; nothing to pick up waits for a refresh that worked.
export function nextUpClear(view: Pick<AttentionView, "assigned" | "unclaimed" | "unclaimedFrom" | "feeds">, failed = false): "setup" | "clear" | null {
  if (view.assigned.length > 0 || view.unclaimed.length > 0) return null;
  if (view.unclaimedFrom === "none") return "setup";
  return refreshed(view.feeds.live, failed) ? "clear" : null;
}
