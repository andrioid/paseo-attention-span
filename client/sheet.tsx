import { openExternalUrl } from "@getpaseo/plugin/client";
import { Modal as PaseoModal, type ModalComponent, type ModalProps } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Chip, type ItemDetails, ownStack, type Target } from "../shared/attention";
import { LatestOnly, type PendingOpen } from "../shared/opening";
import type { IconName } from "./icons";
import { Button, HintArea, KeepStyles, LINE_HEIGHT, REST_MS, Signal, Skeleton, TablerIcon, toneColor, useCopy, useHover, useStyles } from "./ui";

// Tapping a card opens its sheet: what the card knows, every action saying what it will do, then what's fetched [ATT-06].
// Fetched details go last, so the actions don't move when they arrive. A bottom sheet on phones, a dialog on desktop.

export interface SheetEntry {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
  // A copy icon at the end of the line, so copying adds no line to the sheet [ATT-15].
  copy?: { text: string; label: string; done: string };
  // A running session's state at the end of the line: the line opens it [SES-03, ATT-07].
  badge?: Chip;
  // Muted, for a line that's there on purpose but rarely wanted, like starting another session.
  quiet?: boolean;
}

export function ActionSheet({ title, top, entries, bottom, onClose }: { title: string; top: ReactNode; entries: SheetEntry[]; bottom: ReactNode; onClose: () => void }) {
  const styles = useStyles();
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <HintArea style={{ gap: 10 }}>{top}</HintArea>
          <View style={[styles.card, { backgroundColor: styles.c.surface2 }]}>
            {entries.map((entry, index) => (
              <Entry key={entry.key} entry={entry} first={index === 0} />
            ))}
          </View>
          <View style={{ gap: 10 }}>{bottom}</View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

function Entry({ entry, first }: { entry: SheetEntry; first: boolean }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const copy = useCopy();
  const muted = styles.c.foregroundMuted;
  const dim = entry.disabled || entry.quiet;
  return (
    <View style={[styles.row, { gap: 0, alignItems: "stretch" }, first ? null : { borderTopWidth: 1, borderTopColor: styles.c.surface1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.label}
        disabled={entry.disabled}
        onPress={entry.onPress}
        {...hover}
        style={({ pressed }) => [
          styles.row,
          { flex: 1, alignItems: "flex-start", paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed || hovered ? styles.c.border : "transparent" },
        ]}
      >
        <View style={{ paddingTop: 1 }}>
          <TablerIcon name={entry.icon} size={16} color={dim ? muted : styles.action} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: dim ? muted : styles.c.foreground, fontSize: 14, fontWeight: entry.quiet ? "500" : "600" }}>{entry.label}</Text>
          {entry.detail ? <Text style={styles.muted}>{entry.detail}</Text> : null}
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

// Fetched details stay fresh this long, so a sheet opened again, or after its card was pointed at, opens at once.
export const DETAILS_STALE_MS = 60_000;
// Tapped, a card waits this long at most for its details before its sheet opens anyway.
const OPEN_WAIT_MS = 1_500;
// Every card's pending open, so the newest tap wins.
const PENDING_OPENS = new LatestOnly();

// Another way into a sheet, like a card's own action opening its picker, takes over from a card still waiting to open its
// details sheet, which then doesn't open over it [ATT-06].
export function cancelPendingOpen(): void {
  PENDING_OPENS.cancel();
}

// Every dialog and sheet in the plugin: Paseo's Modal, which also takes over from a card still waiting to open its details
// sheet as it appears, so Filter, feedback or any other dialog never ends up under one that opened late [ATT-06]. A
// details sheet opening for itself is done waiting by then, so it cancels nothing.
function TakingOverModal(props: ModalProps) {
  useEffect(cancelPendingOpen, []);
  return <PaseoModal {...props} />;
}
export const Modal: ModalComponent = Object.assign(TakingOverModal, { Content: PaseoModal.Content });

// Opens a card's sheet once its details are in, so the sheet doesn't change once open; meanwhile the card says it's
// loading. Past OPEN_WAIT_MS it opens anyway and the skeletons hold the room; a failure opens it with its error line.
// Resting the pointer on the card fetches them ahead, best effort [ATT-06, GH-01].
// Another card tapped while one waits supersedes it, so only one sheet opens.
export function useSheetOpener(query: DetailsQuery, show: () => void) {
  const client = useQueryClient();
  const [opening, setOpening] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<PendingOpen | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(rest.current);
      pending.current?.done();
    };
  }, []);
  const fetch = () => client.fetchQuery({ ...query, staleTime: DETAILS_STALE_MS });
  const open = () => {
    if (opening) return;
    setOpening(true);
    const turn = PENDING_OPENS.start(() => alive.current && setOpening(false));
    pending.current = turn;
    const waited = new Promise((done) => setTimeout(done, OPEN_WAIT_MS));
    void Promise.race([fetch().catch(() => undefined), waited]).then(() => {
      if (!turn.isCurrent() || !alive.current) return;
      turn.done();
      setOpening(false);
      show();
    });
  };
  const hover = {
    onHoverIn: () => {
      clearTimeout(rest.current);
      rest.current = setTimeout(() => void fetch().catch(() => undefined), REST_MS);
    },
    onHoverOut: () => clearTimeout(rest.current),
  };
  return { opening, open, hover };
}

// The PR's size and the linked issues or PRs, once fetched. Until then skeleton lines hold the room of the lines the card
// expects (`expected`: a PR's size, the PRs it knows close an issue), so the sheet doesn't jump when they arrive [ATT-06].
export function DetailLines({ details, loading, error, linkedLabel, expected }: { details?: ItemDetails; loading: boolean; error: unknown; linkedLabel: string; expected: number }) {
  const styles = useStyles();
  const line = [styles.muted, { lineHeight: LINE_HEIGHT }];
  if (loading) return <Skeleton lines={expected} label="Loading details" />;
  if (!details) return error ? <Text style={line}>Couldn't load details: {(error as Error).message}</Text> : null;
  return (
    <>
      {details.size ? <Text style={line}>{sizeText(details.size)}</Text> : null}
      {details.linked.map((link) => (
        <Pressable key={link.url} accessibilityRole="link" onPress={() => void openExternalUrl(link.url)}>
          <Text style={line} numberOfLines={1}>
            {linkedLabel} #{link.number} {link.title} · {link.state.toLowerCase()}
          </Text>
        </Pressable>
      ))}
    </>
  );
}

const sizeText = (size: ItemDetails["size"]) => (size ? `+${size.additions} −${size.deletions} · ${size.files} file${size.files === 1 ? "" : "s"}` : null);
