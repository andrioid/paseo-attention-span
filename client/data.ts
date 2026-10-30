import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AttentionView, FeedId } from "../shared/attention";
import { getAttention } from "../shared/rpc";

export const VIEW_QUERY_KEY = ["attention-span", "view"] as const;

// The server owns the GitHub refresh schedule; the app only reads its cache [FRESH-01, GH-01].
export function useAttention() {
  const fetchAttention = useRpc(getAttention);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: VIEW_QUERY_KEY,
    queryFn: () => fetchAttention({}),
    // Sooner while a change waits on GitHub, so the list shows GitHub's own word on it soon after [FRESH-02].
    refetchInterval: (query) => (query.state.data?.pending ? 10_000 : 60_000),
  });
  const setView = useCallback((view: AttentionView) => queryClient.setQueryData(VIEW_QUERY_KEY, view), [queryClient]);
  // ⟳ fetches only the feed behind the tab I'm on.
  const refreshNow = useCallback(async (feed: FeedId) => setView(await fetchAttention({ refresh: feed })), [fetchAttention, setView]);
  return { ...query, setView, refreshNow };
}
