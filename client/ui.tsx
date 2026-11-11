import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Dimensions, Easing, Image, Platform, Pressable, type StyleProp, Text, View, type ViewStyle } from "react-native";
import type { Chip } from "../shared/attention";
import { HINT_GAP, type HintPlacement, hintPlacement } from "../shared/hint";
import { ICONS, type IconName } from "./icons";

// Shared look: theme colors only, tighter on compact layouts [REACH-01].
// Color is for signals; facts stay quiet.

type Theme = PluginScreenProps["theme"];

export function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    c,
    compact,
    // Themes don't say whether they're dark; their base surface does. Picks the shade of a color that reads on it.
    dark: (luminance(c.surface0) ?? 0) < 0.5,
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

// "#rgb", "#rrggbb" or "rgb(…)" as 0–255 channels; null for anything else.
function channels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((ch) => ch + ch).join("") : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function luminance(color: string): number | null {
  const rgb = channels(color);
  return rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : null;
}

// `a` with `share` of it kept and the rest `b`; just `a` when either isn't a color this can read.
export function mix(a: string, b: string, share: number): string {
  const [x, y] = [channels(a), channels(b)];
  if (!x || !y) return a;
  return `#${x.map((value, i) => Math.round(value * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

// A fact as an icon half and a value half: the icon, with an optional label, says what the value is, in words on hover and
// to screen readers. A color softly fills the value half. What goes in one is up to entity.tsx.
export function Pill({ icon, label, value, color, hint }: { icon: IconName; label?: string; value?: string; color?: string; hint: string }) {
  const styles = useStyles();
  const text = { fontSize: 11, lineHeight: 16 };
  return (
    <Hint text={hint} inline>
      <View accessibilityLabel={hint} style={{ flexDirection: "row", alignItems: "stretch", borderWidth: 1, borderColor: styles.c.border, borderRadius: 999, overflow: "hidden" }}>
        <View style={[styles.row, { gap: 4, paddingLeft: 7, paddingRight: label ? 7 : 6 }]}>
          <TablerIcon name={icon} size={12} />
          {label ? <Text style={[text, { color: styles.c.foregroundMuted }]}>{label}</Text> : null}
        </View>
        {value ? (
          <View style={{ borderLeftWidth: 1, borderLeftColor: styles.c.border, paddingHorizontal: 7, justifyContent: "center" }}>
            {color ? <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color, opacity: 0.08 }} /> : null}
            <Text style={[text, { color: color ? mix(color, styles.c.foreground, 0.75) : mix(styles.c.foreground, styles.c.foregroundMuted, 0.8) }]}>{value}</Text>
          </View>
        ) : null}
      </View>
    </Hint>
  );
}

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

// Lines of quiet text that may arrive later keep this height, so a Skeleton can hold their place exactly.
export const LINE_HEIGHT = 16;

// Where lines of text will be once they've loaded: quiet bars, gently pulsing, each the height of the line it stands in for,
// so nothing moves when the text replaces them. Widths vary so they read as text, not boxes.
export function Skeleton({ lines, label }: { lines: number; label: string }) {
  const styles = useStyles();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const native = Platform.OS !== "web";
    const half = (toValue: number) => Animated.timing(pulse, { toValue, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: native });
    const loop = Animated.loop(Animated.sequence([half(1), half(0)]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  if (lines <= 0) return null;
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  return (
    <View accessibilityLabel={label} style={{ gap: 10 }}>
      {Array.from({ length: lines }, (_, index) => (
        <View key={index} style={{ height: LINE_HEIGHT, justifyContent: "center" }}>
          <Animated.View style={{ height: 10, borderRadius: 5, width: `${[42, 68, 55][index % 3]}%`, backgroundColor: styles.c.surface2, opacity }} />
        </View>
      ))}
    </View>
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

// A state that matters, as a colored dot (or its icon) and text, explained on hover where it has a hint.
export function Signal({ text, tone, icon, hint }: Chip) {
  const styles = useStyles();
  const color = toneColor(styles, tone);
  const signal = (
    <View style={[styles.row, { gap: 5 }]}>
      {icon ? <TablerIcon name={icon} size={13} color={color} /> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />}
      <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{text}</Text>
    </View>
  );
  return hint ? (
    <Hint text={hint} inline>
      {signal}
    </Hint>
  ) : (
    signal
  );
}

// Where hints may spread: a card's text column, a sheet's top. Whatever holds it clips what runs past, so a hint stays inside.
const HintBounds = createContext<RefObject<View | null> | null>(null);

export function HintArea({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const ref = useRef<View>(null);
  return (
    <HintBounds.Provider value={ref}>
      <View ref={ref} style={style}>
        {children}
      </View>
    </HintBounds.Provider>
  );
}

// Resting the pointer this long shows a hint, or fetches a card's details ahead; passing over does neither.
export const REST_MS = 300;
const HINT_DELAY_MS = REST_MS;

// What something means, in words: on hover after a moment, and always to screen readers. It floats over the layout rather
// than in it, so showing it moves nothing, and it's sized to the room left in its HintArea: beside the content, wrapping
// upward, or above it where there's too little room beside. Touch has no hover, so there the label is all [ATT-19, ATT-11].
export function Hint({ text, inline, children }: { text: string; inline?: boolean; children: ReactNode }) {
  const styles = useStyles();
  const bounds = useContext(HintBounds);
  const self = useRef<View>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [placement, setPlacement] = useState<HintPlacement | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      self.current?.measureInWindow((x, _y, width) => {
        const place = (left: number, right: number) => setPlacement(hintPlacement(x, width, left, right));
        if (bounds?.current) bounds.current.measureInWindow((left, _top, boundsWidth) => place(left, left + boundsWidth));
        else place(HINT_GAP, Dimensions.get("window").width - HINT_GAP);
      });
    }, HINT_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPlacement(null);
  };
  const where: ViewStyle =
    placement?.side === "beside" ? { left: "100%", marginLeft: HINT_GAP, bottom: -2 } : { left: placement?.offset ?? 0, bottom: "100%", marginBottom: 4 };
  return (
    // Raised while shown: every view is its own layer here, so the words would otherwise sit under whatever follows.
    <View ref={self} accessibilityLabel={text} onPointerEnter={show} onPointerLeave={hide} style={[inline ? null : { alignSelf: "flex-start" }, placement ? { zIndex: 10 } : null]}>
      {children}
      {placement ? (
        <View pointerEvents="none" style={[{ position: "absolute", width: placement.width, alignItems: "flex-start", zIndex: 10 }, where]}>
          <View style={{ backgroundColor: styles.c.surface2, borderColor: styles.c.border, borderWidth: 1, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
            <Text style={{ color: styles.c.foreground, fontSize: 12, lineHeight: 16 }}>{text}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Quiet text that stands out a little within it, like an item's number among its facts.
export function useStrongText() {
  const styles = useStyles();
  return { color: mix(styles.c.foreground, styles.c.foregroundMuted, 0.85), fontWeight: "500" as const };
}

// The line under a title: what leads it (which item it is, as text), then facts as quiet text joined by "·", then
// signals [ATT-05].
export function Meta({ lead, facts, chips }: { lead?: ReactNode; facts: string[]; chips: Chip[] }) {
  const styles = useStyles();
  const quiet = (chip: Chip) => chip.tone === "neutral" && !chip.icon && !chip.hint;
  const text = [...facts, ...chips.filter(quiet).map((chip) => chip.text)];
  const signals = chips.filter((chip) => !quiet(chip));
  return (
    <View style={[styles.wrap, { columnGap: 10, rowGap: 4 }]}>
      {lead || text.length ? (
        <Text style={styles.muted}>
          {lead}
          {lead && text.length ? " · " : null}
          {text.join(" · ")}
        </Text>
      ) : null}
      {signals.map((chip) => (
        <Signal key={chip.text} {...chip} />
      ))}
    </View>
  );
}

export function Avatar({ url, bot, team, size = 18 }: { url?: string; bot?: boolean; team?: boolean; size?: number }) {
  const styles = useStyles();
  if (bot || !url) return <TablerIcon name={bot ? "bot" : team ? "team" : "issue"} size={size} />;
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
}: {
  label?: string;
  icon?: IconName;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
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
        backgroundColor: variant === "solid" ? c.accent : hovered || (pressed && variant === "ghost") ? c.border : variant === "ghost" ? "transparent" : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={color} style={{ width: 15, height: 15 }} /> : icon ? <TablerIcon name={icon} size={15} color={color} /> : null}
      {label ? <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text> : null}
    </Pressable>
  );
}

// Sentence case, with the count as quiet text.
// The icon may be a picture instead, like the avatar of whom Waiting's work waits on.
export function SectionHeader({ icon, title, count, action }: { icon: IconName | ReactNode; title: string; count: number; action?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={[styles.row, { marginBottom: 10 }]}>
      {typeof icon === "string" ? <TablerIcon name={icon as IconName} size={15} /> : icon}
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

// Choice chips for options and filters: tappable, filled when chosen. Next up's fact pills (Pill) aren't tappable, and lead
// with an icon half instead.
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
