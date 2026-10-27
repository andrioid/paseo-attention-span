import type { InboxConfig } from "../shared/config";
import { type Inbox, type InboxView, type Section, SECTION_ORDER, SECTIONS, type TabId } from "../shared/inbox";
import type { State } from "./store";

export interface ViewMeta {
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  config: InboxConfig;
}

// A dismissed item stays hidden until someone else does something on it or its reason changes [ATT-08].
export function isDismissed(item: Inbox["items"][number], dismissed: State["dismissed"]): boolean {
  const entry = dismissed[item.key];
  return !!entry && entry.section === item.section && item.othersActivityAt <= entry.at;
}

export function buildView(inbox: Inbox | null, dismissed: State["dismissed"], meta: ViewMeta): InboxView {
  const items = inbox?.items ?? [];
  const visible = items.filter((item) => !isDismissed(item, dismissed));
  const sections = (tab: TabId): Section[] =>
    SECTION_ORDER.filter((id) => SECTIONS[id].tab === tab)
      .map((id) => ({ id, title: SECTIONS[id].title, items: visible.filter((item) => item.section === id) }))
      .filter((section) => section.items.length > 0);
  const doing = sections("doing");
  return {
    ...meta,
    login: inbox?.login ?? null,
    count: doing.reduce((sum, section) => sum + section.items.length, 0),
    doing,
    waiting: sections("waiting"),
    history: visible.filter((item) => SECTIONS[item.section].tab === "history"),
    assigned: inbox?.assigned ?? [],
    unclaimed: inbox?.unclaimed ?? [],
    dismissedCount: items.length - visible.length,
  };
}
