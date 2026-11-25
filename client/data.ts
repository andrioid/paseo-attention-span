import { useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { type AttentionView, type FeedId, newerView } from "../shared/attention";
import { getAttention } from "../shared/rpc";
import { VIEW_QUERY_KEY, viewQuery } from "./view-query";

export { VIEW_QUERY_KEY };
const REFRESH_KEY = ["attention-span", "refresh"] as const;
// History's weeks are the device's, so the server is told its time zone [HIS-01].
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// How often the view is read again: every few seconds while the server refreshes the live feed, so its answer shows as
// soon as it's in; sooner while a change waits on GitHub [FRESH-02]; else every minute, and shortly after the server's
// next refresh of its own is due [FRESH-01, FRESH-04].
const REFRESHING_MS = 5_000;
const PENDING_MS = 10_000;
const IDLE_MS = 60_000;
const AFTER_DUE_MS = 3_000;

function pollInterval(view: AttentionView | undefined, now = Date.now()): number {
  if (view?.feeds.live.refreshing) return REFRESHING_MS;
  const every = view?.pending ? PENDING_MS : IDLE_MS;
  const due = view?.feeds.live.nextAt ? Date.parse(view.feeds.live.nextAt) + AFTER_DUE_MS - now : Infinity;
  return due > 0 ? Math.min(every, due) : every;
}

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
    ...viewQuery(() => fetchAttention({ timeZone })),
    refetchInterval: (query) => pollInterval(query.state.data),
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

// The screen tells the server it just opened, once each time: answered at once, with a live feed a few minutes old
// refreshed behind it, which the view then says runs [FRESH-01]. The sidebar's count doesn't.
export function useScreenOpened() {
  const fetchAttention = useRpc(getAttention);
  const queryClient = useQueryClient();
  useEffect(() => {
    fetchAttention({ opened: true, timeZone })
      .then((view) => writeView(queryClient, view))
      .catch(() => {}); // the view's own poll answers
  }, []);
}
