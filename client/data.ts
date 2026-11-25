import { useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AttentionView, type FeedId, newerView } from "../shared/attention";
import { getAttention } from "../shared/rpc";

export const VIEW_QUERY_KEY = ["attention-span", "view"] as const;
const REFRESH_KEY = ["attention-span", "refresh"] as const;
// History's weeks are the device's, so the server is told its time zone [HIS-01].
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Every write of the view: an action's answer, ⟳'s, a poll's, keeps whichever the server answered last, so one answered
// before an action finished can't undo it, however late it arrives [FRESH-04].
export function writeView(queryClient: QueryClient, view: AttentionView) {
  queryClient.setQueryData<AttentionView>(VIEW_QUERY_KEY, (held) => newerView(held, view));
}

// The server owns the GitHub refresh schedule; the app only reads its cache [FRESH-01, GH-01].
export function useAttention() {
  const fetchAttention = useRpc(getAttention);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: VIEW_QUERY_KEY,
    // A poll's answer too [FRESH-04].
    queryFn: async () => newerView(queryClient.getQueryData<AttentionView>(VIEW_QUERY_KEY), await fetchAttention({ timeZone })),
    // Sooner while a change waits on GitHub, so the list shows GitHub's own word on it soon after [FRESH-02].
    refetchInterval: (query) => (query.state.data?.pending ? 10_000 : 60_000),
  });
  const setView = useCallback((view: AttentionView) => writeView(queryClient, view), [queryClient]);
  // ⟳ fetches only the feed behind the tab I'm on.
  const refresh = useMutation({ mutationKey: REFRESH_KEY, mutationFn: (feed: FeedId) => fetchAttention({ refresh: feed, timeZone }), onSuccess: setView });
  const refreshNow = refresh.mutateAsync;
  // The server answers ⟳ only once its refresh is done, so the view can't say it's running; the pending call does.
  // Kept in the query client, so it still shows after leaving the screen and coming back mid-refresh.
  const pendingFeeds = useMutationState({ filters: { mutationKey: REFRESH_KEY, status: "pending" }, select: (mutation) => mutation.state.variables as FeedId });
  const isRefreshing = useCallback((feed: FeedId) => pendingFeeds.includes(feed), [pendingFeeds]);
  return { ...query, refreshNow, isRefreshing };
}
