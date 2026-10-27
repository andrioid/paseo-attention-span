import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { Chip as ChipData } from "../shared/inbox";
import { ICONS, type IconName } from "./icons";

// Shared look: theme colors only, tighter on compact layouts [REACH-01].

type Theme = PluginScreenProps["theme"];

export function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 12 : 16;
  return {
    c,
    compact,
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 12 : 24, gap: compact ? 18 : 24, paddingBottom: 48, maxWidth: 1100, width: "100%" as const, alignSelf: "center" as const },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    text: { color: c.foreground, fontSize: 14 },
    muted: { color: c.foregroundMuted, fontSize: 13 },
    danger: { color: c.statusDanger, fontSize: 13 },
    title: { color: c.foreground, fontSize: 15, fontWeight: "500" as const, flexShrink: 1 },
    sectionTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const, letterSpacing: 0.8 },
    badge: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 9, backgroundColor: c.surface2 },
    card: { backgroundColor: c.surface1, borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    item: { padding: pad, gap: 8, flexDirection: "row" as const, alignItems: "flex-start" as const },
    divider: { borderTopWidth: 1, borderTopColor: c.border },
    body: { flex: 1, gap: 6, minWidth: 0 },
    quote: { borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 10, paddingVertical: 2, gap: 4 },
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

export function TablerIcon({ name, size = 16, color }: { name: IconName; size?: number; color?: string }) {
  const { c } = useStyles();
  return <Icon icon={ICONS[name]} size={size} color={color ?? c.foregroundMuted} />;
}

export function toneColor(styles: Styles, tone: ChipData["tone"]): string {
  return { good: styles.c.statusSuccess, bad: styles.c.statusDanger, warn: styles.c.statusWarning, neutral: styles.c.foregroundMuted }[tone];
}

export function Chip({ text, tone = "neutral" }: { text: string; tone?: ChipData["tone"] }) {
  const styles = useStyles();
  const color = toneColor(styles, tone);
  return (
    <View style={{ borderWidth: 1, borderColor: tone === "neutral" ? styles.c.border : color, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 12 }}>{text}</Text>
    </View>
  );
}

export function Avatar({ url, bot, size = 18 }: { url?: string; bot?: boolean; size?: number }) {
  const styles = useStyles();
  if (bot || !url) return <TablerIcon name={bot ? "bot" : "issue"} size={size} />;
  return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: styles.c.surface2 }} />;
}

export function Button({ label, icon, onPress, primary, disabled }: { label?: string; icon?: IconName; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const styles = useStyles();
  const [hovered, setHovered] = useState(false);
  const color = primary ? styles.c.accentForeground : styles.c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? icon}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: label ? 11 : 7,
        borderRadius: 8,
        backgroundColor: primary ? styles.c.accent : hovered || pressed ? styles.c.border : styles.c.surface2,
        opacity: disabled ? 0.5 : pressed && primary ? 0.85 : 1,
      })}
    >
      {icon ? <TablerIcon name={icon} size={15} color={color} /> : null}
      {label ? <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{label}</Text> : null}
    </Pressable>
  );
}

export function SectionHeader({ icon, title, count }: { icon: IconName; title: string; count: number }) {
  const styles = useStyles();
  return (
    <View style={[styles.row, { marginBottom: 8 }]}>
      <TablerIcon name={icon} size={15} />
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.badge}>
        <Text style={[styles.muted, { fontSize: 11 }]}>{count}</Text>
      </View>
    </View>
  );
}

// Choice chips for options and filters.
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
