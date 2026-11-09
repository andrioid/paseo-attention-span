import type { AttentionView } from "./attention";

// The empty Doing tab: a horizon that follows the device's clock [ATT-18].
export type Scene = "morning" | "midday" | "evening" | "night";

// Fixed local hours, the same every day: morning 5–11, midday 11–16, evening 16–21, night 21–5.
export function sceneAt(date: Date): Scene {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "evening";
  return "night";
}

// Calm only when it's true: Doing is empty after a refresh that worked. Dismissed items don't count;
// they're not on me until something new happens [ATT-08]. Loading, a failed refresh or none yet show plainly.
export function isClear(view: Pick<AttentionView, "doing" | "feeds">, failed = false): boolean {
  const live = view.feeds.live;
  return view.doing.length === 0 && !!live.fetchedAt && !live.error && !failed;
}
