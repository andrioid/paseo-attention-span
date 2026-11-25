import { replaceEqualDeep } from "@tanstack/react-query";
import { type AttentionView, newerView } from "../shared/attention";

export const VIEW_QUERY_KEY = ["attention-span", "view"] as const;

// How the view is cached: every write, a poll's answer or an action's, keeps whichever the server answered last. It's
// decided as the cache is written, against what it holds then, so a poll that began before an action and lands after it
// can't undo it [FRESH-04].
export function viewQuery(fetchView: () => Promise<AttentionView>) {
  return {
    queryKey: VIEW_QUERY_KEY,
    queryFn: fetchView,
    structuralSharing: (held: unknown, incoming: unknown) => replaceEqualDeep(held, newerView(held as AttentionView | undefined, incoming as AttentionView)),
  };
}
