import { type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps, usePaseo } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { AttentionScreen } from "./client/attention-screen";
import { CoverageSettings } from "./client/coverage-settings";
import { useAttention } from "./client/data";
import { returnFromFeedback } from "./client/feedback";
import { ICONS } from "./client/icons";
import { AGENTS_QUERY_KEY, itemAgents } from "./client/sessions";
import { doingCount, wrapItems } from "./shared/wrap-up";

// The count, visible from anywhere in Paseo [ATT-09].
function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useAttention();
  const paseo = usePaseo();
  // Wrap up's rows need the sessions, which live in Paseo [ATT-09, ATT-22].
  const agents = useQuery({ queryKey: AGENTS_QUERY_KEY, queryFn: () => itemAgents(paseo), refetchInterval: 15_000 });
  const wrap = data ? wrapItems(data, data.fixtureAgents ?? agents.data ?? []) : [];
  const count = data ? doingCount(data, wrap) : 0;
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
  return returnFromFeedback(client);
}
