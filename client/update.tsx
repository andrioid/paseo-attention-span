import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import * as rpc from "../shared/rpc";
import type { UpdateNotice as Notice } from "../shared/update";
import { Button, TablerIcon, useCopy, useStyles } from "./ui";

const UPDATE_QUERY_KEY = ["attention-span", "update"] as const;
// The server caches Paseo's answer for 12 hours, so asking it often costs nothing.
const EVERY_MS = 60 * 60 * 1000;
// While an update runs: soon enough to show a failure, and the restart's result.
const UPDATING_MS = 2000;
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
const FROM: Record<Notice["source"], string> = { registry: "the Paseo plugin registry", npm: "npm", git: "GitHub" };

// A newer version, what changed, Update, and Not now until the next one [UPD-01].
// Update runs `paseo plugin update` on the daemon, which installs it and restarts the plugin; the app then loads the new
// version. Once the restart is done, the check says it's current and the notice goes.
export function UpdateNotice() {
  const styles = useStyles();
  const toast = useToast();
  const copy = useCopy();
  const queryClient = useQueryClient();
  const check = useRpc(rpc.checkUpdate);
  const apply = useRpc(rpc.applyUpdate);
  const skip = useRpc(rpc.skipUpdate);
  const [updating, setUpdating] = useState(false);
  const { data: notice } = useQuery({
    queryKey: UPDATE_QUERY_KEY,
    // While the plugin restarts, its server isn't there to answer: keep what's on screen.
    queryFn: () => check({}).catch((error: Error) => (updating ? (queryClient.getQueryData<Notice | null>(UPDATE_QUERY_KEY) ?? null) : Promise.reject(error))),
    staleTime: updating ? 0 : EVERY_MS,
    refetchInterval: (query) => (updating && !query.state.data?.error ? UPDATING_MS : EVERY_MS),
  });
  if (!notice) return null;
  const busy = updating && !notice.error;

  const update = async () => {
    setUpdating(true);
    try {
      await apply({ latest: notice.latest });
      await queryClient.invalidateQueries({ queryKey: UPDATE_QUERY_KEY });
    } catch (error) {
      setUpdating(false);
      toast.error(`Updating failed: ${(error as Error).message}`);
    }
  };

  const notNow = () => {
    queryClient.setQueryData(UPDATE_QUERY_KEY, null);
    skip({ latest: notice.latest }).catch((error: Error) => toast.error(`Couldn't put it off: ${error.message}`));
  };

  return (
    <View style={styles.panel} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <TablerIcon name="update" size={16} color={styles.action} />
        <Text style={styles.title}>Attention Span {notice.latest} is out</Text>
      </View>
      {notice.error ? (
        <>
          <Text style={styles.danger}>Updating failed: {notice.error}</Text>
          <Text style={styles.muted}>To see more, run this where Paseo's daemon runs:</Text>
          <Text selectable style={[styles.text, { fontFamily: MONO, fontSize: 13 }]}>
            {notice.command}
          </Text>
        </>
      ) : (
        <Text style={styles.muted}>
          {busy
            ? `Installing it from ${FROM[notice.source]}. Attention Span restarts when it's done.`
            : `You have ${notice.current}. Update installs it from ${FROM[notice.source]} and restarts Attention Span, which takes a few seconds.`}
        </Text>
      )}
      <View style={styles.wrap}>
        <Button label={busy ? "Updating…" : notice.error ? "Try again" : "Update"} icon="update" variant="solid" busy={busy} onPress={() => void update()} />
        {notice.error ? <Button label="Copy command" icon="copy" onPress={() => copy(notice.command, "Copied the update command")} /> : null}
        <Button label="What's new" icon="github" onPress={() => void openExternalUrl(notice.notes)} />
        {busy ? null : <Button label="Not now" variant="ghost" accessibilityLabel={`Not now: hide until a version newer than ${notice.latest}`} onPress={notNow} />}
      </View>
    </View>
  );
}
