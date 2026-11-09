import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Text, View } from "react-native";
import { themeName } from "../shared/feedback";
import { type Scene, sceneAt } from "../shared/still";
import { useStyles } from "./ui";

// Doing with nothing in it: a horizon that follows the clock, and nothing that asks for anything [ATT-18].
// It settles in on every arrival, then stays still; the hour changing crossfades it.

// One tint per time of day, darker on light themes so it holds up on white.
const TINTS: Record<"dark" | "light", Record<Scene, string>> = {
  dark: { morning: "#d4b47c", midday: "#8fbf9f", evening: "#d49a7e", night: "#a6a1cf" },
  light: { morning: "#c49a4e", midday: "#5f9f76", evening: "#c97b5a", night: "#7f78b8" },
};

// Drawn on a 240 × 110 canvas; the waterline is at y = 66. Each layer is its own SVG so it can move on its own.
const W = 240;
const H = 110;
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${body}</svg>`;

const SKY: Record<Scene, string> = {
  morning: svg(`<path d="M100 66a20 20 0 0 1 40 0"/>`),
  midday: svg(`<circle cx="120" cy="30" r="16"/>`),
  evening: svg(`<path d="M88 66a32 32 0 0 1 64 0"/>`),
  night: svg(
    `<path d="M126 18a16 16 0 1 0 14 22a12.5 12.5 0 0 1 -14 -22z"/>` +
      [
        [70, 24],
        [168, 16],
        [190, 40],
        [52, 46],
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1" fill="currentColor" stroke="none" opacity=".6"/>`)
        .join(""),
  ),
};

// The sun's light on the water, fading downwards; wider under a low sun.
const WIDTHS: Record<Scene, number[]> = { morning: [40, 26, 12], midday: [24, 16, 8], evening: [56, 40, 20], night: [30, 18, 8] };
const WATER: Record<Scene, string> = Object.fromEntries(
  (Object.keys(WIDTHS) as Scene[]).map((scene) => [
    scene,
    svg(WIDTHS[scene].map((width, i) => `<path d="M${W / 2 - width / 2} ${76 + i * 8}h${width}" stroke-opacity="${[0.45, 0.28, 0.15][i]}"/>`).join("")),
  ]),
) as Record<Scene, string>;

const LINE = { svg: svg(`<path d="M20 66h200"/>`) };

const SETTLE_MS = 700;
const CROSSFADE_MS = 4000;
const native = Platform.OS !== "web";

export function Still() {
  const styles = useStyles();
  const theme = themeName(styles.c.surface0);
  const width = styles.compact ? 200 : 240;
  const height = Math.round((width * H) / W);

  // Arrival: the sky drifts up as it fades in, then the reflections draw in; skipped for reduced motion.
  const arrive = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let cancelled = false;
    const settle = Animated.timing(arrive, { toValue: 1, duration: SETTLE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: native });
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled) return;
        if (reduce) arrive.setValue(1);
        else settle.start();
      });
    return () => {
      cancelled = true;
      settle.stop();
    };
  }, [arrive]);

  // The clock: checked every minute, and a new hour crossfades in slowly.
  const [scene, setScene] = useState<Scene>(() => sceneAt(new Date()));
  const [previous, setPrevious] = useState<Scene | null>(null);
  const shown = useRef(scene);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const timer = setInterval(() => {
      const next = sceneAt(new Date());
      if (next === shown.current) return;
      setPrevious(shown.current);
      setScene((shown.current = next));
      fade.setValue(0);
      Animated.timing(fade, { toValue: 1, duration: CROSSFADE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: native }).start(({ finished }) => finished && setPrevious(null));
    }, 60_000);
    return () => clearInterval(timer);
  }, [fade]);

  const skyIn = { opacity: arrive.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0, 1, 1] }), transform: [{ translateY: arrive.interpolate({ inputRange: [0, 0.65, 1], outputRange: [6, 0, 0] }) }] };
  const waterIn = { opacity: arrive.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] }) };
  const fadeOut = fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  // SvgXml draws a size × size square; the canvas sits in its middle, so crop the square to the canvas.
  const layer = (icon: { svg: string }, color: string) => (
    <View style={{ position: "absolute", left: 0, right: 0, top: -(width - height) / 2 }}>
      <Icon icon={icon} size={width} color={color} />
    </View>
  );
  const scenery = (shown: Scene, opacity: Animated.AnimatedInterpolation<number> | Animated.Value) => (
    <Animated.View key={shown} style={{ position: "absolute", inset: 0, opacity }}>
      <Animated.View style={[{ position: "absolute", inset: 0 }, skyIn]}>{layer({ svg: SKY[shown] }, TINTS[theme][shown])}</Animated.View>
      <Animated.View style={[{ position: "absolute", inset: 0 }, waterIn]}>{layer({ svg: WATER[shown] }, TINTS[theme][shown])}</Animated.View>
    </Animated.View>
  );

  return (
    // Upper two-fifths: a little above the middle, so it reads as a place, not a floating notice.
    <View style={{ flex: 1, minHeight: styles.compact ? 300 : 360 }}>
      <View style={{ flex: 2 }} />
      <View accessible accessibilityLabel="Nothing needs you right now." style={{ alignItems: "center", gap: 12 }}>
        <View style={{ width, height, overflow: "hidden" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <View style={{ position: "absolute", inset: 0, opacity: 0.6 }}>{layer(LINE, styles.c.foregroundMuted)}</View>
          {previous ? scenery(previous, fadeOut) : null}
          {scenery(scene, fade)}
        </View>
        <Text style={{ color: styles.c.foreground, fontSize: 17, fontWeight: "600", marginTop: 6 }}>Nothing's on you.</Text>
        <Text style={[styles.muted, { fontSize: 13 }]}>Enjoy the quiet.</Text>
      </View>
      <View style={{ flex: 3 }} />
    </View>
  );
}
