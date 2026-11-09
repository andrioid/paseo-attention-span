import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AttentionView, FeedId } from "../shared/attention";
import { getAttention } from "../shared/rpc";

export const VIEW_QUERY_KEY = ["attention-span", "view"] as const;
const REFRESH_KEY = ["attention-span", "refresh"] as const;

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
  const refresh = useMutation({ mutationKey: REFRESH_KEY, mutationFn: (feed: FeedId) => fetchAttention({ refresh: feed }), onSuccess: setView });
  const refreshNow = refresh.mutateAsync;
  // The server answers ⟳ only once its refresh is done, so the view can't say it's running; the pending call does.
  // Kept in the query client, so it still shows after leaving the screen and coming back mid-refresh.
  const pendingFeeds = useMutationState({ filters: { mutationKey: REFRESH_KEY, status: "pending" }, select: (mutation) => mutation.state.variables as FeedId });
  const isRefreshing = useCallback((feed: FeedId) => pendingFeeds.includes(feed), [pendingFeeds]);
  return { ...query, setView, refreshNow, isRefreshing };
}
