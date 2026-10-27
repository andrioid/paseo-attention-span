import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { InboxView } from "../shared/inbox";
import { getInbox } from "../shared/rpc";

export const INBOX_QUERY_KEY = ["github-inbox", "inbox"] as const;

// The server owns the GitHub refresh schedule; the app only reads its cache [FRESH-01].
// The screen asks for data at most a minute old when it opens.
export function useInbox(options: { onOpenMaxAgeSeconds?: number } = {}) {
  const fetchInbox = useRpc(getInbox);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => fetchInbox({ maxAgeSeconds: options.onOpenMaxAgeSeconds }),
    refetchInterval: 60_000,
  });
  const setView = useCallback((view: InboxView) => queryClient.setQueryData(INBOX_QUERY_KEY, view), [queryClient]);
  const refreshNow = useCallback(async () => setView(await fetchInbox({ maxAgeSeconds: 0 })), [fetchInbox, setView]);
  return { ...query, setView, refreshNow };
}
