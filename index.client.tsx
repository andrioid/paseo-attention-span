import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { AttentionScreen } from "./client/attention-screen";
import { CoverageSettings } from "./client/coverage-settings";
import { useAttention } from "./client/data";
import { ICONS } from "./client/icons";

// The count, visible from anywhere in Paseo [ATT-09].
function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useAttention();
  const count = data?.count ?? 0;
  return (
    <SidebarRow
      icon={ICONS.logo}
      label="Attention"
      active={currentScreen?.screenId === "attention"}
      onPress={() => openScreen({ screenId: "attention" })}
      trailing={
        count > 0 ? (
          <Text style={{ color: data?.feeds.live.error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12 }}>{count}</Text>
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
  return () => {};
}
