import { openExternalUrl } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Modal as NativeModal, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { ItemDetails } from "../shared/attention";
import type { IconName } from "./icons";
import { type Anchor, Button, KeepStyles, Loading, TablerIcon, useAnchor, useCopy, useHover, useStyles } from "./ui";

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
  // ▾ at the end of the line: the choices around this action, like a split button [SES-03].
  menu?: { label: string; onPress: (anchor: Anchor | undefined) => void };
  // What the line's split button opens; marked in its menu.
  checked?: boolean;
}

export interface MenuGroup {
  title?: string;
  entries: SheetEntry[];
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
  const copy = useCopy();
  const anchor = useAnchor();
  const muted = styles.c.foregroundMuted;
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
          <TablerIcon name={entry.icon} size={16} color={entry.disabled ? muted : styles.action} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: entry.disabled ? muted : styles.c.foreground, fontSize: 14, fontWeight: "600" }}>{entry.label}</Text>
          {entry.detail ? <Text style={styles.muted}>{entry.detail}</Text> : null}
        </View>
        {entry.checked ? (
          <View style={{ paddingTop: 1 }}>
            <TablerIcon name="check" size={16} color={styles.action} />
          </View>
        ) : null}
      </Pressable>
      {entry.menu ? (
        <View ref={anchor.ref} collapsable={false} style={{ paddingHorizontal: 6, justifyContent: "center", borderLeftWidth: 1, borderLeftColor: styles.c.surface1 }}>
          <Button icon="chevronDown" variant="ghost" accessibilityLabel={entry.menu.label} onPress={() => anchor.measure(entry.menu!.onPress)} />
        </View>
      ) : null}
      {entry.copy ? (
        <View style={{ paddingHorizontal: 6, justifyContent: "center" }}>
          <Button icon="copy" variant="ghost" accessibilityLabel={entry.copy.label} onPress={() => copy(entry.copy!.text, entry.copy!.done)} />
        </View>
      ) : null}
    </View>
  );
}

// A split button's choices: under the button on desktop, a bottom sheet on phones [SES-03].
export function MenuSheet({ title, anchor, groups, onClose }: { title: string; anchor?: Anchor; groups: MenuGroup[]; onClose: () => void }) {
  const styles = useStyles();
  const window = useWindowDimensions();
  const list = (
    <View style={{ gap: 10 }}>
      {groups.map((group, index) => (
        <View key={group.title ?? index} style={{ gap: 6 }}>
          {group.title ? <Text style={[styles.muted, { fontWeight: "600" }]}>{group.title}</Text> : null}
          <View style={[styles.card, { backgroundColor: styles.c.surface2 }]}>
            {group.entries.map((entry, i) => (
              <Entry key={entry.key} entry={entry} first={i === 0} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
  if (styles.compact || !anchor) {
    return (
      <Modal title={title} open onOpenChange={(open) => (open ? null : onClose())}>
        <Modal.Content>
          <KeepStyles styles={styles}>{list}</KeepStyles>
        </Modal.Content>
      </Modal>
    );
  }
  // Right-aligned with the button, below it, or above it in the lower half of the window.
  const width = Math.min(340, window.width - 16);
  const left = Math.max(8, Math.min(anchor.x + anchor.width - width, window.width - width - 8));
  const below = anchor.y + anchor.height < window.height / 2;
  const place = below ? { top: anchor.y + anchor.height + 4 } : { bottom: window.height - anchor.y + 4 };
  return (
    <NativeModal transparent visible animationType="none" onRequestClose={onClose}>
      <KeepStyles styles={styles}>
        <Pressable accessibilityLabel="Close menu" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
        <View
          accessibilityRole="menu"
          accessibilityLabel={title}
          style={[
            styles.card,
            { position: "absolute", left, width, maxHeight: window.height / 2 - 16, padding: 10, ...place },
            { shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
          ]}
        >
          {list}
        </View>
      </KeepStyles>
    </NativeModal>
  );
}

// The PR's size and the linked issues or PRs, once fetched.
export function DetailLines({ details, loading, error, linkedLabel }: { details?: ItemDetails; loading: boolean; error: unknown; linkedLabel: string }) {
  const styles = useStyles();
  if (loading) return <Loading text="Loading details…" />;
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
