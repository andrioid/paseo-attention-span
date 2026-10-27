import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useInbox } from "./client/data";
import { ICONS } from "./client/icons";
import { InboxScreen } from "./client/inbox-screen";

// The count, visible from anywhere in Paseo [ATT-09].
function InboxItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useInbox();
  const count = data?.count ?? 0;
  return (
    <SidebarRow
      icon={ICONS.inbox}
      label="GitHub attention"
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
      trailing={
        count > 0 ? (
          <Text style={{ color: data?.error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12 }}>{count}</Text>
        ) : undefined
      }
    />
  );
}

// One screen for everything that needs me [ATT-01].
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "inbox", title: "GitHub attention", Component: InboxScreen });
  client.addSidebarHeaderItem({ id: "inbox", title: "GitHub attention", Component: InboxItem });
  return () => {};
}
