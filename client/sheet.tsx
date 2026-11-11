import { openExternalUrl } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";
import { type Chip, type ItemDetails, ownStack, type Target } from "../shared/attention";
import type { IconName } from "./icons";
import { Button, Hint, HintArea, KeepStyles, LINE_HEIGHT, REST_MS, Signal, Skeleton, TablerIcon, toneColor, useCopy, useHover, useStyles } from "./ui";

// Every dialog and sheet in the plugin is Paseo's Modal.
export { Modal };

// Tapping a card opens its sheet at once: what the card knows, every action saying what it will do, then what's fetched.
// Fetched details go last, so the actions don't move when they arrive. A bottom sheet on phones, a dialog on desktop [ATT-06].

export interface SheetEntry {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  // In place of `detail`, a line drawn in parts, like Rerun's count, checks and history [PRS-09].
  detailNode?: ReactNode;
  // Said on hover, and to screen readers, for a line that can't show everything [ATT-19].
  hint?: string;
  // A line that changes while the sheet is open, so screen readers say it when it does.
  live?: boolean;
  disabled?: boolean;
  onPress: () => void;
  // A copy icon at the end of the line, so copying adds no line to the sheet [ATT-15].
  copy?: { text: string; label: string; done: string };
  // A running session's state at the end of the line: the line opens it [SES-03, ATT-07].
  badge?: Chip;
  // Muted, for a line that's there on purpose but rarely wanted, like starting another session.
  quiet?: boolean;
  // Taking the item off my list or giving it up (Dismiss, Unclaim, Close): kept apart below the work, icons quiet.
  housekeeping?: boolean;
}

export function ActionSheet({ title, top, entries, bottom, onClose }: { title: string; top: ReactNode; entries: SheetEntry[]; bottom: ReactNode; onClose: () => void }) {
  const styles = useStyles();
  const work = entries.filter((entry) => !entry.housekeeping);
  const housekeeping = entries.filter((entry) => entry.housekeeping);
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <HintArea style={{ gap: 10 }}>{top}</HintArea>
          <View style={{ gap: 10 }}>
            <EntryGroup entries={work} />
            <EntryGroup entries={housekeeping} />
          </View>
          <View style={{ gap: 10 }}>{bottom}</View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

// One block of lines. It doesn't clip, so a line's hint can float over the lines above it; each line rounds its own corners.
function EntryGroup({ entries }: { entries: SheetEntry[] }) {
  const styles = useStyles();
  if (entries.length === 0) return null;
  return (
    <HintArea style={[styles.card, { backgroundColor: styles.c.surface2, overflow: "visible" }]}>
      {entries.map((entry, index) => (
        <Entry key={entry.key} entry={entry} first={index === 0} last={index === entries.length - 1} />
      ))}
    </HintArea>
  );
}

const INNER_RADIUS = 11;

function Entry({ entry, first, last }: { entry: SheetEntry; first: boolean; last: boolean }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const copy = useCopy();
  const muted = styles.c.foregroundMuted;
  const dim = entry.disabled || entry.quiet;
  // The pressed and hovered fill follows the block's rounded corners; the copy icon has its own at the right.
  const corners = {
    borderTopLeftRadius: first ? INNER_RADIUS : 0,
    borderBottomLeftRadius: last ? INNER_RADIUS : 0,
    borderTopRightRadius: first && !entry.copy ? INNER_RADIUS : 0,
    borderBottomRightRadius: last && !entry.copy ? INNER_RADIUS : 0,
  };
  const detail = entry.detailNode ?? (entry.detail ? <Text style={styles.muted}>{entry.detail}</Text> : null);
  return (
    <View style={[styles.row, { gap: 0, alignItems: "stretch" }, first ? null : { borderTopWidth: 1, borderTopColor: styles.c.surface1 }]}>
      <Pressable
        accessibilityRole="button"
        // The button's name is all a screen reader says of it, so a hint goes in it too.
        accessibilityLabel={entry.hint ? `${entry.label}. ${entry.hint}` : entry.label}
        accessibilityState={{ disabled: !!entry.disabled }}
        disabled={entry.disabled}
        onPress={entry.onPress}
        {...hover}
        style={({ pressed }) => [
          styles.row,
          corners,
          { flex: 1, alignItems: "flex-start", paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed || hovered ? styles.c.border : "transparent" },
        ]}
      >
        <View style={{ paddingTop: 1 }}>
          <TablerIcon name={entry.icon} size={16} color={dim || entry.housekeeping ? muted : styles.action} />
        </View>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text style={{ color: dim ? muted : styles.c.foreground, fontSize: 14, fontWeight: entry.quiet ? "500" : "600" }}>{entry.label}</Text>
          {detail ? (
            <View accessibilityLiveRegion={entry.live ? "polite" : undefined}>
              {entry.hint ? (
                <Hint text={entry.hint} inline>
                  {detail}
                </Hint>
              ) : (
                detail
              )}
            </View>
          ) : null}
        </View>
        {entry.badge ? <Badge {...entry.badge} /> : null}
      </Pressable>
      {entry.copy ? (
        <View style={{ paddingHorizontal: 6, justifyContent: "center" }}>
          <Button icon="copy" variant="ghost" accessibilityLabel={entry.copy.label} onPress={() => copy(entry.copy!.text, entry.copy!.done)} />
        </View>
      ) : null}
    </View>
  );
}

// A state as a pill on a soft tint of its tone.
function Badge(chip: Chip) {
  const styles = useStyles();
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 99, overflow: "hidden" }}>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: toneColor(styles, chip.tone), opacity: 0.16 }} />
      <Signal {...chip} />
    </View>
  );
}

// What a sheet fetches when it opens; the card and its sheet share it, so what the card fetched the sheet reuses.
export interface DetailsQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<ItemDetails>;
}

// Details keyed by everything the fetch reads: the item, the PR its actions apply to, and with `checks` the PRs of my stack,
// so the same issue in Doing (acting on its PR) and in Next up (no PR) don't share what each fetched [ATT-06].
export function detailsKey(subject: { kind: "pr" | "issue"; repo: string; number: number }, target: Target | undefined, checks: boolean): readonly unknown[] {
  const pr = target?.kind === "pr" ? `${target.repo}#${target.number}` : null;
  return ["attention-span", "details", subject.kind, `${subject.repo}#${subject.number}`, pr, checks, checks && target ? ownStack(target).map((p) => p.number) : []];
}

// Fetched details stay fresh this long, so a sheet opened again, or after its card was pointed at, is complete at once.
export const DETAILS_STALE_MS = 60_000;

// Resting the pointer on a card fetches its sheet's details ahead, best effort, so on desktop most sheets open complete.
// Tapping opens the sheet at once either way; what isn't in yet fills in [ATT-06, GH-01].
export function usePrefetchOnRest(query: DetailsQuery) {
  const client = useQueryClient();
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(rest.current), []);
  return {
    onHoverIn: () => {
      clearTimeout(rest.current);
      rest.current = setTimeout(() => void client.prefetchQuery({ ...query, staleTime: DETAILS_STALE_MS }), REST_MS);
    },
    onHoverOut: () => clearTimeout(rest.current),
  };
}

// Whether something that was loading while it showed has just come in, rather than being there from the start.
export function useArrived(loading: boolean): boolean {
  const waited = useRef(loading);
  if (loading) waited.current = true;
  return waited.current && !loading;
}

// Lines that came in while the sheet was open fade in, rather than popping over their placeholders.
export function FadeIn({ active, children }: { active: boolean; children: ReactNode }) {
  const opacity = useRef(new Animated.Value(active ? 0 : 1)).current;
  useEffect(() => {
    if (active) Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== "web" }).start();
  }, [active, opacity]);
  return <Animated.View style={{ opacity, gap: 10 }}>{children}</Animated.View>;
}

// Skeletons show only once loading has taken this long, so a quick answer doesn't flash them; their room is held from the start.
const SKELETON_DELAY_MS = 150;

// The PR's size and the linked issues or PRs, once fetched. Until then skeleton lines hold the room of the lines the card
// expects (`expected`: a PR's size, the PRs it knows close an issue), so the sheet doesn't jump when they arrive [ATT-06].
// `sizeOf` names the PR the size is of, where the sheet is an issue's.
export function DetailLines({
  details,
  loading,
  error,
  linkedLabel,
  expected,
  sizeOf,
}: {
  details?: ItemDetails;
  loading: boolean;
  error: unknown;
  linkedLabel: string;
  expected: number;
  sizeOf?: number;
}) {
  const styles = useStyles();
  const arrived = useArrived(loading);
  const line = [styles.muted, { lineHeight: LINE_HEIGHT }];
  if (loading) return <Skeleton lines={expected} label="Loading details" delayMs={SKELETON_DELAY_MS} />;
  if (!details) return error ? <Text style={line}>Couldn't load details: {(error as Error).message}</Text> : null;
  const size = sizeText(details.size);
  return (
    <FadeIn active={arrived}>
      {size ? <Text style={line}>{sizeOf ? `PR #${sizeOf} · ${size}` : size}</Text> : null}
      {details.linked.map((link) => (
        <Pressable key={link.url} accessibilityRole="link" onPress={() => void openExternalUrl(link.url)}>
          <Text style={line} numberOfLines={1}>
            {linkedLabel} #{link.number} {link.title} · {link.state.toLowerCase()}
          </Text>
        </Pressable>
      ))}
    </FadeIn>
  );
}

const sizeText = (size: ItemDetails["size"]) => (size ? `+${size.additions} −${size.deletions} · ${size.files} file${size.files === 1 ? "" : "s"}` : null);
