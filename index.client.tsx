import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { AttentionScreen } from "./client/attention-screen";
import { useAttention } from "./client/data";
import { ICONS } from "./client/icons";

// The count, visible from anywhere in Paseo [ATT-09].
function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useAttention();
  const count = data?.count ?? 0;
  return (
    <SidebarRow
      icon={ICONS.tray}
      label="Attention"
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
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
  client.addScreen({ id: "inbox", title: "Attention Span", Component: AttentionScreen });
  client.addSidebarHeaderItem({ id: "inbox", title: "Attention Span", Component: SidebarItem });
  return () => {};
}
