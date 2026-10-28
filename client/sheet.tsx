import { openExternalUrl } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemDetails } from "../shared/attention";
import type { IconName } from "./icons";
import { KeepStyles, TablerIcon, useHover, useStyles } from "./ui";

// Tapping a card opens its sheet: what the card knows, every action saying what it will do, then what's fetched [ATT-06].
// Fetched details go last, so the actions don't move when they arrive. A bottom sheet on phones, a dialog on desktop.

export interface SheetEntry {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
}

export function ActionSheet({ title, top, entries, bottom, onClose }: { title: string; top: ReactNode; entries: SheetEntry[]; bottom: ReactNode; onClose: () => void }) {
  const styles = useStyles();
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <View style={{ gap: 10 }}>{top}</View>
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
  const muted = styles.c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      disabled={entry.disabled}
      onPress={entry.onPress}
      {...hover}
      style={({ pressed }) => [
        styles.row,
        { alignItems: "flex-start", paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed || hovered ? styles.c.border : "transparent" },
        first ? null : { borderTopWidth: 1, borderTopColor: styles.c.surface1 },
      ]}
    >
      <View style={{ paddingTop: 1 }}>
        <TablerIcon name={entry.icon} size={16} color={entry.disabled ? muted : styles.action} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: entry.disabled ? muted : styles.c.foreground, fontSize: 14, fontWeight: "600" }}>{entry.label}</Text>
        {entry.detail ? <Text style={styles.muted}>{entry.detail}</Text> : null}
      </View>
    </Pressable>
  );
}

// The PR's size and the linked issues or PRs, once fetched.
export function DetailLines({ details, loading, error, linkedLabel }: { details?: ItemDetails; loading: boolean; error: unknown; linkedLabel: string }) {
  const styles = useStyles();
  if (loading) return <Text style={styles.muted}>Loading details…</Text>;
  if (!details) return error ? <Text style={styles.muted}>Couldn't load details: {(error as Error).message}</Text> : null;
  return (
    <>
      {details.size ? <Text style={styles.muted}>{sizeText(details.size)}</Text> : null}
      {details.linked.map((link) => (
        <Pressable key={link.url} accessibilityRole="link" onPress={() => void openExternalUrl(link.url)}>
          <Text style={styles.muted} numberOfLines={1}>
            {linkedLabel} #{link.number} {link.title} · {link.state.toLowerCase()}
          </Text>
        </Pressable>
      ))}
    </>
  );
}

const sizeText = (size: ItemDetails["size"]) => (size ? `+${size.additions} −${size.deletions} · ${size.files} file${size.files === 1 ? "" : "s"}` : null);
