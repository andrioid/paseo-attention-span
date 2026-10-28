import { openExternalUrl } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ItemDetails } from "../shared/inbox";
import type { IconName } from "./icons";
import { KeepStyles, TablerIcon, useHover, useStyles } from "./ui";

// Tapping a card opens its sheet: details on top, then every action, each saying what it will do [ATT-06].
// A bottom sheet on phones, a dialog on desktop.

export interface SheetEntry {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
}

export function ActionSheet({ title, top, entries, onClose }: { title: string; top: ReactNode; entries: SheetEntry[]; onClose: () => void }) {
  const styles = useStyles();
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <View style={{ gap: 10 }}>{top}</View>
          <View style={styles.card}>
            {entries.map((entry, index) => (
              <Entry key={entry.key} entry={entry} first={index === 0} />
            ))}
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

function Entry({ entry, first }: { entry: SheetEntry; first: boolean }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const color = entry.disabled ? styles.c.foregroundMuted : styles.c.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      disabled={entry.disabled}
      onPress={entry.onPress}
      {...hover}
      style={({ pressed }) => [
        styles.row,
        { alignItems: "flex-start", paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed || hovered ? styles.c.surface2 : "transparent" },
        first ? null : styles.divider,
      ]}
    >
      <View style={{ paddingTop: 1 }}>
        <TablerIcon name={entry.icon} size={16} color={color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color, fontSize: 14, fontWeight: "600" }}>{entry.label}</Text>
        {entry.detail ? <Text style={styles.muted}>{entry.detail}</Text> : null}
      </View>
    </Pressable>
  );
}

// The description's opening and the linked issues or PRs, once fetched.
export function DetailLines({ details, loading, error, linkedLabel }: { details?: ItemDetails; loading: boolean; error: unknown; linkedLabel: string }) {
  const styles = useStyles();
  if (loading) return <Text style={styles.muted}>Loading details…</Text>;
  if (!details) return error ? <Text style={styles.muted}>Couldn't load details: {(error as Error).message}</Text> : null;
  return (
    <>
      {details.excerpt ? (
        <Text style={{ color: styles.c.foreground, fontSize: 13, lineHeight: 19 }} numberOfLines={8}>
          {details.excerpt}
        </Text>
      ) : (
        <Text style={styles.muted}>No description.</Text>
      )}
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

export const sizeText = (size: ItemDetails["size"]) => (size ? `+${size.additions} −${size.deletions} · ${size.files} file${size.files === 1 ? "" : "s"}` : null);
