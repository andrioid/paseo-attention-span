import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Image, Platform, Pressable, Text, View } from "react-native";
import type { Chip } from "../shared/attention";
import { ICONS, type IconName } from "./icons";

// Shared look: theme colors only, tighter on compact layouts [REACH-01].
// Color is for signals; facts stay quiet.

type Theme = PluginScreenProps["theme"];

export function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    c,
    compact,
    // Action text and icons. The accent is a fill: as text on a dark theme it's 2.5:1; this green is 5–6:1 on every surface.
    action: c.statusSuccess,
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

// An icon that turns while something runs, like ⟳ while its feed is fetched.
export function SpinningIcon({ name, size = 16, color, spinning }: { name: IconName; size?: number; color?: string; spinning: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }));
    loop.start();
    return () => (loop.stop(), turn.setValue(0));
  }, [spinning, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <TablerIcon name={name} size={size} color={color} />
    </Animated.View>
  );
}

// What's loading, with a spinner so it doesn't read as stuck.
export function Loading({ text }: { text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <ActivityIndicator size="small" color={styles.c.foregroundMuted} />
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

export function toneColor(styles: Styles, tone: Chip["tone"]): string {
  return { good: styles.c.statusSuccess, bad: styles.c.statusDanger, warn: styles.c.statusWarning, neutral: styles.c.foregroundMuted }[tone];
}

// A state that matters, as a colored dot (or its icon) and text.
export function Signal({ text, tone, icon }: Chip) {
  const styles = useStyles();
  const color = toneColor(styles, tone);
  return (
    <View style={[styles.row, { gap: 5 }]}>
      {icon ? <TablerIcon name={icon} size={13} color={color} /> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />}
      <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

// The line under a title: facts as quiet text joined by "·", then signals [ATT-05].
export function Meta({ facts, chips }: { facts: string[]; chips: Chip[] }) {
  const styles = useStyles();
  const quiet = (chip: Chip) => chip.tone === "neutral" && !chip.icon;
  const text = [...facts, ...chips.filter(quiet).map((chip) => chip.text)];
  const signals = chips.filter((chip) => !quiet(chip));
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
// Busy: a spinner in place of the icon, and no second press while it runs.
export function Button({
  label,
  icon,
  onPress,
  variant = "plain",
  disabled,
  busy,
  accessibilityLabel,
  joined,
}: {
  label?: string;
  icon?: IconName;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  // One half of a split button: square on the side it joins.
  joined?: "start" | "end";
}) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const { c } = styles;
  const color = variant === "solid" ? c.accentForeground : variant === "calm" ? styles.action : variant === "ghost" ? c.foregroundMuted : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? icon}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      {...hover}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 30,
        paddingHorizontal: label ? 11 : 8,
        borderRadius: 8,
        ...(joined === "start" ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : joined === "end" ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingHorizontal: 6 } : null),
        backgroundColor: variant === "solid" ? c.accent : hovered || (pressed && variant === "ghost") ? c.border : variant === "ghost" ? "transparent" : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={color} style={{ width: 15, height: 15 }} /> : icon ? <TablerIcon name={icon} size={15} color={color} /> : null}
      {label ? <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text> : null}
    </Pressable>
  );
}

// Where a menu opens from, in window coordinates.
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Measures a view, for a menu that opens under it.
export function useAnchor() {
  const ref = useRef<View>(null);
  const measure = (then: (anchor: Anchor | undefined) => void) => {
    if (!ref.current) return then(undefined);
    ref.current.measureInWindow((x, y, width, height) => then(width || height ? { x, y, width, height } : undefined));
  };
  return { ref, measure };
}

// The action, and ▾ for the choices around it [SES-03].
export function SplitButton({
  label,
  icon,
  onPress,
  onMenu,
  menuLabel,
  busy,
  accessibilityLabel,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  onMenu: (anchor: Anchor | undefined) => void;
  menuLabel: string;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  const { ref, measure } = useAnchor();
  return (
    <View ref={ref} collapsable={false} style={{ flexDirection: "row", gap: 1 }}>
      <Button label={label} icon={icon} variant="calm" busy={busy} accessibilityLabel={accessibilityLabel} onPress={onPress} joined="start" />
      <Button icon="chevronDown" variant="calm" disabled={busy} accessibilityLabel={menuLabel} onPress={() => measure(onMenu)} joined="end" />
    </View>
  );
}

// Sentence case, with the count as quiet text.
export function SectionHeader({ icon, title, count, action }: { icon: IconName; title: string; count: number; action?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={[styles.row, { marginBottom: 10 }]}>
      <TablerIcon name={icon} size={15} />
      <Text style={{ color: styles.c.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
        {title}
        <Text style={{ color: styles.c.foregroundMuted, fontWeight: "400" }}> · {count}</Text>
      </Text>
      {action}
    </View>
  );
}

// Copy text and say so, since an icon-only button gives no other sign it worked.
export function useCopy() {
  const toast = useToast();
  return (text: string, done: string) =>
    void copyText(text).then(
      () => toast.show(done, { variant: "success" }),
      () => toast.error("Couldn't copy"),
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
