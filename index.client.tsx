import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { AttentionScreen } from "./client/attention-screen";
import { CoverageSettings } from "./client/coverage-settings";
import { useAttention } from "./client/data";
import { returnFromFeedback } from "./client/feedback";
import { useHostLabel } from "./client/host";
import { ICONS } from "./client/icons";

// The count, visible from anywhere in Paseo [ATT-09], beside the host's name when there are several [REACH-02].
function SidebarItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useAttention();
  const hostLabel = useHostLabel(host);
  const count = data?.count ?? 0;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <SidebarRow
      icon={ICONS.logo}
      label="Attention"
      active={currentScreen?.screenId === "attention"}
      onPress={() => openScreen({ screenId: "attention" })}
      trailing={
        hostLabel || count > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {hostLabel ? (
              <Text style={[muted, { maxWidth: 120 }]} numberOfLines={1}>
                {hostLabel}
              </Text>
            ) : null}
            {count > 0 ? <Text style={[muted, data?.feeds.live.error ? { color: theme.colors.statusDanger } : null]}>{count}</Text> : null}
          </View>
        ) : undefined
      }
    />
  );
}

// One screen for everything that needs me [ATT-01].
export default function contribute(client: PluginClientContext) {
  // Settings → Plugins → Attention Span, also opened from the screen's gear and the setup checklist [SRC-02].
  client.addSettingsScreen({ id: "coverage", title: "Attention Span", icon: ICONS.logo, Component: CoverageSettings });
  const Screen = (props: PluginScreenProps) => <AttentionScreen {...props} openSettings={() => client.openSettings("coverage")} />;
  client.addScreen({ id: "attention", title: "Attention Span", Component: Screen });
  client.addSidebarHeaderItem({ id: "attention", title: "Attention Span", Component: SidebarItem });
  return returnFromFeedback(client);
}
