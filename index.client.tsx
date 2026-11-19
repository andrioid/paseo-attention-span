import { type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps, useHosts } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { AttentionScreen } from "./client/attention-screen";
import { CoverageSettings } from "./client/coverage-settings";
import { useAttention } from "./client/data";
import { returnFromFeedback } from "./client/feedback";
import { ICONS } from "./client/icons";
import { tint } from "./client/ui";
import { newIssueParams } from "./client/new-issue";
import { useItemAgents } from "./client/sessions";
import { withInProgress } from "./shared/in-progress";
import { doingCount, wrapItems } from "./shared/wrap-up";

// The count, visible from anywhere in Paseo [ATT-09].
function SidebarItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useAttention();
  // Wrap up's rows need the sessions, which live in Paseo [ATT-09, ATT-22].
  const agents = useItemAgents();
  const sessions = data?.fixtureAgents ?? agents.data ?? [];
  const wrap = data ? wrapItems(data, sessions) : [];
  // A started issue counts while its session waits on me, as on the screen [SES-11].
  const count = data ? doingCount(withInProgress(data, sessions, wrap), wrap) : 0;
  // Paseo merges every host's row into one, showing the host picked last, so with more than one host a pill says whose
  // count this is [REACH-02]. Paseo only lists the hosts I've configured, not which of them have Attention Span, so a host
  // without it still counts. The pill gives way first, so "Attention" keeps its line in a narrow sidebar.
  const hosts = useHosts();
  const muted = theme.colors.foregroundMuted;
  return (
    <SidebarRow
      icon={ICONS.logo}
      label="Attention"
      active={currentScreen?.screenId === "attention"}
      onPress={() => openScreen({ screenId: "attention" })}
      trailing={
        hosts.length > 1 || count > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
            {hosts.length > 1 ? (
              <View style={{ flexShrink: 1, maxWidth: 72, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 9, backgroundColor: tint(theme.colors.foreground, 0.08) }}>
                <Text numberOfLines={1} accessibilityLabel={`On ${host.label}`} style={{ color: muted, fontSize: 11, fontWeight: "500" }}>
                  {host.label}
                </Text>
              </View>
            ) : null}
            {count > 0 ? <Text style={{ color: data?.feeds.live.error ? theme.colors.statusDanger : muted, fontSize: 12 }}>{count}</Text> : null}
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
  // A new issue from ⌘K anywhere [ISS-01]. ⌘K can't show a sheet, so it opens the screen with the sheet on it. Paseo lists
  // global items everywhere and agent items beside them, so "from this session" is the one that knows where I am.
  client.addCommandCenterItem({
    id: "new-issue",
    title: "New issue…",
    icon: ICONS.issue,
    context: "global",
    keywords: ["issue", "github", "file", "report", "bug", "idea"],
    onSelect: ({ openScreen }) => openScreen({ screenId: "attention", params: newIssueParams({}) }),
  });
  client.addCommandCenterItem({
    id: "new-issue-from-session",
    title: "New issue from this session…",
    icon: ICONS.issue,
    context: "agent",
    keywords: ["issue", "github", "file", "follow-up", "later"],
    onSelect: ({ openScreen, workspace, agent }) => openScreen({ screenId: "attention", params: newIssueParams({ workspaceId: workspace.id, agentId: agent.id }) }),
  });
  return returnFromFeedback(client);
}
