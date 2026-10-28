import { type Attention, type AttentionView, type FeedId, type FeedStatus, type Item, type Section, SECTION_ORDER, SECTIONS, type TabId } from "../shared/attention";
import type { AttentionConfig } from "../shared/config";
import type { State } from "./store";

export interface ViewMeta {
  feeds: Record<FeedId, FeedStatus>;
  scopes: string[];
  config: AttentionConfig;
}

// A dismissed item stays hidden until someone else does something on it or its reason changes [ATT-08].
export function isDismissed(item: Item, dismissed: State["dismissed"]): boolean {
  const entry = dismissed[item.key];
  return !!entry && entry.section === item.section && item.othersActivityAt <= entry.at;
}

export function buildView(attention: Attention | null, history: Item[], dismissed: State["dismissed"], meta: ViewMeta): AttentionView {
  const items = [...(attention?.items ?? []), ...history];
  const visible = items.filter((item) => !isDismissed(item, dismissed));
  const sections = (tab: TabId): Section[] =>
    SECTION_ORDER.filter((id) => SECTIONS[id].tab === tab)
      .map((id) => ({ id, title: SECTIONS[id].title, items: visible.filter((item) => item.section === id) }))
      .filter((section) => section.items.length > 0);
  const doing = sections("doing");
  return {
    ...meta,
    login: attention?.login ?? null,
    count: doing.reduce((sum, section) => sum + section.items.length, 0),
    doing,
    waiting: sections("waiting"),
    history: visible.filter((item) => SECTIONS[item.section].tab === "history"),
    assigned: attention?.assigned ?? [],
    unclaimed: attention?.unclaimed ?? [],
    dismissedCount: items.length - visible.length,
  };
}
