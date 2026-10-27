import type { InboxConfig } from "../shared/config";
import { type Inbox, type InboxView, SECTION_TITLES, SectionId } from "../shared/inbox";
import type { State } from "./store";

export interface ViewMeta {
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  config: InboxConfig;
}

const EMPTY_FOOTER: Inbox["footer"] = { waitingOnOthers: [], toDo: [], doneThisWeek: [] };

// A dismissed item stays hidden until someone else does something on it or its reason changes [ATT-08].
export function isDismissed(item: Inbox["items"][number], dismissed: State["dismissed"]): boolean {
  const entry = dismissed[item.key];
  return !!entry && entry.section === item.section && item.othersActivityAt <= entry.at;
}

export function buildView(inbox: Inbox | null, dismissed: State["dismissed"], meta: ViewMeta): InboxView {
  const items = inbox?.items ?? [];
  const visible = items.filter((item) => !isDismissed(item, dismissed));
  const sections = SectionId.options
    .map((id) => ({ id, title: SECTION_TITLES[id], items: visible.filter((item) => item.section === id) }))
    .filter((section) => section.items.length > 0);
  return {
    ...meta,
    login: inbox?.login ?? null,
    count: visible.length,
    sections,
    footer: inbox?.footer ?? EMPTY_FOOTER,
    dismissedCount: items.length - visible.length,
  };
}
