import { TextInput } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Chip } from "../shared/attention";
import type { IconName } from "./icons";
import { Button, Meta, TablerIcon, toneColor, useStyles } from "./ui";

// Every card in every list has this anatomy; tabs fill it in with data and slots, not layout [ATT-05].
//
//   [mark]  title (2 lines at most)                 [actions]   ← desktop
//           place · when · signals
//           extra (slot)
//           [actions]                                           ← phone, labelled
//           confirm bar
//
// Colors come only from tones, so a card can't pick a theme color that some themes render plain.

export type Tone = Chip["tone"];

export interface CardAction {
  label: string;
  icon: IconName;
  onPress: () => void;
  // Defaults to the label.
  accessibilityLabel?: string;
}

export interface ConfirmSpec {
  text: string;
  // A comment field whose text each choice receives.
  comment?: boolean;
  choices: { label: string; icon: IconName; solid?: boolean; onConfirm: (comment: string) => void }[];
  onCancel: () => void;
}

export interface CardProps {
  mark: { icon: IconName; tone: Tone };
  title: string;
  // "repo #number", then when it happened, then signals [ATT-05].
  meta: { place: string; when?: string; signals: Chip[] };
  // Defaults to "<title>, more".
  accessibilityLabel?: string;
  // Tapping the card opens its sheet [ATT-06].
  onOpen: () => void;
  // The labelled main action; secondary ones are icon-only (⋯, copy).
  primary?: CardAction;
  secondary: CardAction[];
  // "working…" in place of the actions while a GitHub change runs.
  busy?: boolean;
  // Content only some lists have: tags, a quote, a stack line.
  extra?: ReactNode;
  confirm?: ConfirmSpec | null;
  // Sheets and pickers opened from the card.
  overlay?: ReactNode;
}

export function CardList({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.card}>{children}</View>;
}

export function CardRow({ first, mark, title, meta, accessibilityLabel, onOpen, primary, secondary, busy, extra, confirm, overlay }: CardProps & { first: boolean }) {
  const styles = useStyles();
  const actions = (
    <View style={styles.wrap}>
      {busy ? (
        <Text style={styles.muted}>working…</Text>
      ) : primary ? (
        <Button label={primary.label} accessibilityLabel={primary.accessibilityLabel} icon={primary.icon} variant="calm" onPress={primary.onPress} />
      ) : null}
      {secondary.map((action) => (
        <Button key={action.accessibilityLabel ?? action.label} icon={action.icon} variant="ghost" accessibilityLabel={action.accessibilityLabel ?? action.label} onPress={action.onPress} />
      ))}
    </View>
  );
  return (
    <View style={first ? null : styles.divider}>
      <View style={styles.item}>
        <Mark {...mark} />
        <View style={styles.body}>
          <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${title}, more`} onPress={onOpen} style={{ gap: 6 }}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <Meta facts={meta.when ? [meta.place, meta.when] : [meta.place]} chips={meta.signals} />
            {extra}
          </Pressable>
          {/* On phones the actions sit under the text, labelled, so mixed actions stay readable. */}
          {styles.compact ? actions : null}
          {confirm ? <ConfirmBar {...confirm} /> : null}
        </View>
        {styles.compact ? null : actions}
      </View>
      {overlay}
    </View>
  );
}

// What the card is, as an icon on a softly tinted square.
export function Mark({ icon, tone }: { icon: IconName; tone: Tone }) {
  const styles = useStyles();
  const color = toneColor(styles, tone);
  return (
    <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 8, backgroundColor: color, opacity: 0.16 }} />
      <TablerIcon name={icon} size={17} color={color} />
    </View>
  );
}

// A change on GitHub asks first, on the card [SAFE-01].
export function ConfirmBar({ text, comment, choices, onCancel }: ConfirmSpec) {
  const styles = useStyles();
  const [value, setValue] = useState("");
  return (
    <View style={styles.panel}>
      <Text style={styles.text}>{text}</Text>
      {comment ? (
        <TextInput style={styles.input} placeholder="Closing comment (optional)" placeholderTextColor={styles.c.foregroundMuted} value={value} onChangeText={setValue} multiline />
      ) : null}
      <View style={styles.wrap}>
        {choices.map((choice) => (
          <Button key={choice.label} label={choice.label} icon={choice.icon} variant={choice.solid ? "solid" : "plain"} onPress={() => choice.onConfirm(value)} />
        ))}
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}
