import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { Chip } from "../shared/inbox";
import { ICONS, type IconName } from "./icons";

// Shared look: theme colors only, tighter on compact layouts [REACH-01].
// Color is for signals; facts stay quiet.

type Theme = PluginScreenProps["theme"];

export function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    c,
    compact,
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 12 : 24, gap: compact ? 20 : 28, paddingBottom: 48, maxWidth: 860, width: "100%" as const, alignSelf: "center" as const },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    text: { color: c.foreground, fontSize: 14 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    danger: { color: c.statusDanger, fontSize: 13 },
    title: { color: c.foreground, fontSize: 16, fontWeight: "600" as const, flexShrink: 1 },
    card: { backgroundColor: c.surface1, borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    item: { padding: compact ? 12 : 16, gap: 10, flexDirection: "row" as const, alignItems: "flex-start" as const },
    divider: { borderTopWidth: 1, borderTopColor: c.border },
    body: { flex: 1, gap: 6, minWidth: 0 },
    quote: { backgroundColor: c.surface2, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, gap: 4 },
    panel: { gap: 10, padding: 12, borderRadius: 10, backgroundColor: c.surface2 },
    input: { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13 },
  };
}
export type Styles = ReturnType<typeof makeStyles>;

const StylesContext = createContext<Styles | null>(null);
export const useStyles = () => useContext(StylesContext)!;

export function StylesProvider({ theme, compact, children }: { theme: Theme; compact: boolean; children: ReactNode }) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  return <StylesContext.Provider value={styles}>{children}</StylesContext.Provider>;
}

// Modals can render outside this tree (a bottom sheet on phones), so they take the styles along.
export function KeepStyles({ styles, children }: { styles: Styles; children: ReactNode }) {
  return <StylesContext.Provider value={styles}>{children}</StylesContext.Provider>;
}

export function TablerIcon({ name, size = 16, color }: { name: IconName; size?: number; color?: string }) {
  const { c } = useStyles();
  return <Icon icon={ICONS[name]} size={size} color={color ?? c.foregroundMuted} />;
}

export function toneColor(styles: Styles, tone: Chip["tone"]): string {
  return { good: styles.c.statusSuccess, bad: styles.c.statusDanger, warn: styles.c.statusWarning, neutral: styles.c.foregroundMuted }[tone];
}

// A state that matters, as a colored dot and text.
export function Signal({ text, tone }: Chip) {
  const styles = useStyles();
  const color = toneColor(styles, tone);
  return (
    <View style={[styles.row, { gap: 5 }]}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

// The line under a title: facts as quiet text joined by "·", then signals [ATT-05].
export function Meta({ facts, chips }: { facts: string[]; chips: Chip[] }) {
  const styles = useStyles();
  const text = [...facts, ...chips.filter((chip) => chip.tone === "neutral").map((chip) => chip.text)];
  const signals = chips.filter((chip) => chip.tone !== "neutral");
  return (
    <View style={[styles.wrap, { columnGap: 10, rowGap: 4 }]}>
      {text.length ? <Text style={styles.muted}>{text.join(" · ")}</Text> : null}
      {signals.map((chip) => (
        <Signal key={chip.text} {...chip} />
      ))}
    </View>
  );
}

export function Avatar({ url, bot, size = 18 }: { url?: string; bot?: boolean; size?: number }) {
  const styles = useStyles();
  if (bot || !url) return <TablerIcon name={bot ? "bot" : "issue"} size={size} />;
  return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: styles.c.surface2 }} />;
}

// ghost: no background until hovered or pressed, for secondary icons on every row.
type Variant = "calm" | "solid" | "plain" | "ghost";

export function useHover() {
  const [hovered, setHovered] = useState(false);
  return { hovered, hover: { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) } };
}

// Calm by default: accent text on a subtle surface. Solid accent is for confirmations.
export function Button({
  label,
  icon,
  onPress,
  variant = "plain",
  disabled,
  accessibilityLabel,
}: {
  label?: string;
  icon?: IconName;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const { c } = styles;
  const color = variant === "solid" ? c.accentForeground : variant === "calm" ? c.accent : variant === "ghost" ? c.foregroundMuted : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? icon}
      disabled={disabled}
      onPress={onPress}
      {...hover}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 30,
        paddingHorizontal: label ? 11 : 8,
        borderRadius: 8,
        backgroundColor: variant === "solid" ? c.accent : hovered || (pressed && variant === "ghost") ? c.border : variant === "ghost" ? "transparent" : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <TablerIcon name={icon} size={15} color={color} /> : null}
      {label ? <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text> : null}
    </Pressable>
  );
}

// Sentence case, with the count as quiet text.
export function SectionHeader({ icon, title, count }: { icon: IconName; title: string; count: number }) {
  const styles = useStyles();
  return (
    <View style={[styles.row, { marginBottom: 10 }]}>
      <TablerIcon name={icon} size={15} />
      <Text style={{ color: styles.c.foreground, fontSize: 13, fontWeight: "600" }}>
        {title}
        <Text style={{ color: styles.c.foregroundMuted, fontWeight: "400" }}> · {count}</Text>
      </Text>
    </View>
  );
}

// Choice chips for options and filters: the only pills, because they're tappable.
export function Toggle({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { c } = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: active ? c.accent : c.border, backgroundColor: active ? c.accent : "transparent" }}
    >
      <Text style={{ color: active ? c.accentForeground : c.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}
