import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { liftActive, type Section, type SectionId, TAB_FEED, type TabId, type WaitingGroup } from "../shared/attention";
import { nextUpSources } from "../shared/config";
import { ago, linkList } from "../shared/format";
import { historyClear, isClear, nextUpClear, waitingClear } from "../shared/still";
import * as rpc from "../shared/rpc";
import { type FeedbackKind, themeName } from "../shared/feedback";
import { blocks } from "../shared/setup";
import { cleanSingle, unreadChanges, wrapItems } from "../shared/wrap-up";
import { nudgeLead, tabCounts } from "../shared/item-view";
import { useAttention } from "./data";
import type { IconName } from "./icons";
import { type Actions, useItemActions } from "./item-actions";
import { Card } from "./item-row";
import { NextUpList } from "./next-up";
import { CodeRepoPicker, SessionOptions } from "./pickers";
import { Still } from "./still";
import { FeedbackAsk, FeedbackLine, type FeedbackScreen, FeedbackSheet } from "./feedback";
import { NewIssueSheet, type NewIssueRequest, takeNewIssueRequest } from "./new-issue";
import { useItemAgents } from "./sessions";
import { History } from "./history";
import { WrapUp } from "./wrap-up";
import { SetupChecklist } from "./setup";
import { UpdateNotice } from "./update";
import { Avatar, Button, Loading, SectionHeader, SpinningIcon, StylesProvider, TablerIcon, tint, useCopy, useStyles } from "./ui";

const SECTION_ICONS: Record<SectionId, IconName> = {
  reply: "reply",
  answered: "replyArrow",
  review: "review",
  ci: "ci",
  changes: "changes",
  ready: "merge",
  upstream: "branch",
  needs_reviewer: "claim",
  drafts: "pencil",
  wait_review: "review",
  wait_reviewer: "replyArrow",
  wait_ci: "clock",
  wait_answer: "reply",
  wrap: "archive",
  changed: "team",
  done: "merge",
  reviewed: "review",
  handed_off: "team",
};

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: "history", label: "History", icon: "history" },
  { id: "doing", label: "Doing", icon: "tray" },
  { id: "waiting", label: "Waiting", icon: "hourglass" },
  { id: "next", label: "Next up", icon: "nextUp" },
];

// `openSettings` opens the orgs and repos settings [SRC-02].
export function AttentionScreen({ theme, layout, navigation, params, openSettings }: PluginScreenProps & { openSettings?: () => void }) {
  return (
    <StylesProvider theme={theme} compact={layout.compact}>
      <AttentionList navigation={navigation} params={params} openSettings={openSettings} device={{ device: layout.compact ? "phone" : "desktop", platform: layout.platform, theme: themeName(theme.colors.surface0) }} />
    </StylesProvider>
  );
}

function AttentionList({
  navigation,
  params,
  openSettings,
  device,
}: Pick<PluginScreenProps, "navigation" | "params"> & { openSettings?: () => void; device: Omit<FeedbackScreen, "tab" | "refreshError"> }) {
  const styles = useStyles();
  const toast = useToast();
  const attention = useAttention();
  const agents = useItemAgents();
  const act = useItemActions(attention, navigation);
  const [tab, setTab] = useState<TabId>("doing");
  // History's Filter sheet: Reviewed and Changed by others per week [HIS-07].
  const [filtering, setFiltering] = useState(false);
  // The feedback sheet, then the first words for the kind picked in it [FB-01].
  const [feedback, setFeedback] = useState<"sheet" | FeedbackKind | null>(null);
  // The New issue sheet, from ⌘K by the screen's params or from Next up [ISS-01].
  const [newIssue, setNewIssue] = useState<Omit<NewIssueRequest, "at"> | null>(null);
  const newIssueAt = params?.newIssue;
  useEffect(() => {
    const request = takeNewIssueRequest(params);
    if (request) setNewIssue(request);
  }, [newIssueAt]);
  const view = attention.data;
  // Only when something fails: is it setup, and what's missing [SET-01]?
  const fetchSetup = useRpc(rpc.setupStatus);
  const failing = !!attention.error || !!view?.feeds.live.error;
  const setup = useQuery({ queryKey: ["attention-span", "setup"], queryFn: () => fetchSetup({}), enabled: failing });
  const [checking, setChecking] = useState(false);

  if (failing && setup.data && blocks(setup.data)) {
    const check = async () => {
      setChecking(true);
      await attention.refreshNow("live").catch(() => {});
      await setup.refetch();
      setChecking(false);
    };
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <SetupChecklist status={setup.data} config={view?.config} onCheck={() => void check()} checking={checking} openSettings={openSettings} />
      </ScrollView>
    );
  }

  if (!view) {
    return (
      <View style={[styles.screen, styles.content]}>
        {attention.error ? <Text style={styles.danger}>Couldn't load Attention Span: {(attention.error as Error).message}</Text> : <Loading text="Loading…" />}
      </View>
    );
  }

  // Each tab shows how fresh its own feed is.
  const feed = view.feeds[TAB_FEED[tab]];
  // Wrap up is made here from the sessions the screen and sidebar already poll; the server archives and acknowledges [ATT-22].
  const agentsNow = (view.fixtureAgents ?? agents.data ?? []).filter((agent) => !act.archivedSessions.has(agent.id));
  const wrap = wrapItems(view, agentsNow);
  // Notes about work Already in Wrap up wait there; archiving acknowledges them [HIS-07, ATT-22].
  const notes = unreadChanges(view.history.filter((item) => item.section === "changed"), wrap);
  // Calm only once a refresh that worked says Doing is empty, Wrap up included [ATT-18, ATT-22].
  // Sessions not known yet, or failing to load, leave Wrap up unknown: no calm on that [ATT-18, ATT-22].
  const sessionsKnown = !!view.fixtureAgents || (agents.isSuccess && !agents.isError);
  const clear = sessionsKnown && isClear(view, !!attention.error, wrap.length);
  // The other tabs' scenes, on the same terms [HIS-08, WAI-04, NXT-13].
  const calm = {
    history: historyClear(view, notes.length, !!attention.error),
    waiting: waitingClear(view, !!attention.error),
    next: nextUpClear(view, !!attention.error),
  };
  // ⟳ turns for any refresh of this tab's feed, but only my own press locks it: the cached view can still say a background one runs after it's done.
  const pressed = attention.isRefreshing(TAB_FEED[tab]);
  const refreshing = feed.refreshing || attention.isFetching || pressed;
  const counts = tabCounts(view, wrap);

  const actions = act.itemActions(view, agentsNow);

  const switchTab = (id: TabId) => {
    setTab(id);
    act.clearUndo();
  };

  return (
    // A clear Doing tab fills the screen, so its scene has room and the rest sits at the bottom [ATT-18].
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, tab === "doing" && clear ? { flexGrow: 1 } : null]}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={styles.row}>
          {TABS.map(({ id, label, icon }) => (
            <Tab key={id} icon={icon} label={label} count={counts[id]} active={tab === id} dot={id === "history" && notes.length > 0} onPress={() => switchTab(id)} />
          ))}
        </View>
        <View style={[styles.row, { gap: 16 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh now"
            accessibilityState={{ busy: refreshing, disabled: pressed }}
            disabled={pressed}
            style={styles.row}
            onPress={() => void attention.refreshNow(TAB_FEED[tab]).catch(() => {})}
          >
            <SpinningIcon name="update" size={14} spinning={refreshing} />
            <Text style={styles.muted}>{feed.fetchedAt ? `${ago(feed.fetchedAt)} ago` : "never"}</Text>
          </Pressable>
          {openSettings ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Attention Span settings" onPress={openSettings} hitSlop={8}>
              <TablerIcon name="settings" size={16} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {feed.error ? <Text style={styles.danger}>{feed.error}</Text> : null}
      <UpdateNotice />

      {act.undoable.map((row) => (
        <View key={row.id} style={[styles.panel, styles.row, { justifyContent: "space-between" }]}>
          <Text style={[styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {row.text}
          </Text>
          <Button label="Undo" variant="calm" onPress={() => act.undo(row)} />
        </View>
      ))}
      {tab === "history" ? (
        <History
          calm={calm.history}
          notes={notes}
          items={view.history}
          filter={view.historyFilter ?? []}
          filtering={filtering}
          onFiltering={setFiltering}
          onFilter={(next) => act.filterHistory(view, next)}
          busy={act.busy}
          onMarkAllRead={actions.gotItAll}
          card={(items) => <Card items={items} actions={actions} />}
        />
      ) : null}
      {tab === "doing" ? (
        <>
          {clear ? <Still /> : wrap.length || view.doing.length ? (
            <>
              {wrap.length > 0 ? (
                <WrapUp
                  items={wrap}
                  busy={act.busy}
                  login={view.login}
                  fixture={!!view.fixtureAgents}
                  openAgent={act.openAgent}
                  onArchive={(item, confirm, terminals) => act.archiveRows([item], confirm, item.key, terminals)}
                  onArchiveAll={async () => {
                    const clean = wrap.filter(cleanSingle);
                    if (clean.length === 0) return;
                    const outcome = await act.archiveRows(clean, false);
                    if (outcome && !outcome.ok && outcome.reason === "unsaved") toast.error("Some sessions have unsaved changes or open terminals. Archive them one by one.");
                  }}
                />
              ) : null}
              {view.doing.length > 0 ? <Sections sections={view.doing} actions={actions} /> : null}
            </>
          ) : !feed.fetchedAt && !feed.error ? (
            <Loading text="Checking GitHub…" />
          ) : agents.isError ? (
            <Text style={styles.muted}>Couldn't check your sessions, so Wrap up isn't known yet.</Text>
          ) : !sessionsKnown ? (
            <Loading text="Checking your sessions…" />
          ) : null}
          {view.dismissedCount > act.undoable.filter((row) => row.dismissal).length ? (
            <Pressable
              accessibilityRole="button"
              style={clear ? { alignSelf: "center", opacity: 0.7 } : undefined}
              onPress={act.restoreDismissed}
            >
              <Text style={styles.muted}>{view.dismissedCount} dismissed · show them again</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "waiting" ? (
        calm.waiting ? <Still shore="jetty" title="Nobody's holding you up." line="Nothing to chase." /> : <Waiting groups={view.waiting} actions={actions} />
      ) : null}
      {tab === "next" ? (
        <NextUpList
          calm={calm.next}
          openSettings={openSettings}
          assigned={view.assigned}
          unclaimed={view.unclaimed}
          unclaimedFrom={view.unclaimedFrom}
          selected={view.scopes}
          sources={nextUpSources(view.config)}
          selectedSources={view.sources}
          projects={view.projects}
          selectedProjects={view.projectFilter}
          onFilter={(change) => act.filterNextUp(view, change)}
          // Narrowed to one repository, a new issue starts there [ISS-01].
          onNewIssue={() => setNewIssue({ nextUp: view.sources.length === 1 && view.sources[0].startsWith("repo:") ? view.sources[0].slice(5) : undefined })}
          agents={actions.agents}
          login={view.login}
          busy={act.busy}
          fetchDetails={act.fetchDetails}
          onOpenAgent={act.openAgent}
          {...act.issueActions}
        />
      ) : null}
      <FeedbackLine onPress={() => setFeedback("sheet")} />
      {feedback === "sheet" ? <FeedbackSheet agents={actions.agents} onOpenAgent={act.openAgent} onAsk={setFeedback} onClose={() => setFeedback(null)} /> : null}
      {feedback && feedback !== "sheet" ? (
        <FeedbackAsk
          kind={feedback}
          config={view.config}
          screen={{ ...device, tab, refreshError: feed.error ?? null }}
          onStarted={act.started}
          onBack={() => setFeedback("sheet")}
          onClose={() => setFeedback(null)}
        />
      ) : null}
      {newIssue ? <NewIssueSheet request={newIssue} view={view} onView={attention.setView} onStarted={act.started} onClose={() => setNewIssue(null)} /> : null}
      {act.options ? <SessionOptions spec={act.options} config={view.config} started={act.started} onClose={act.closeOptions} /> : null}
      {act.placing ? <CodeRepoPicker issueRepo={act.placing.target.repo} missing={act.placing.missing} onPick={act.place} onClose={act.cancelPlacing} /> : null}
    </ScrollView>
  );
}

function Tab({ icon, label, count, active, dot, onPress }: { icon: IconName; label: string; count: number; active: boolean; dot?: boolean; onPress: () => void }) {
  const styles = useStyles();
  const color = active ? styles.c.foreground : styles.c.foregroundMuted;
  // A soft round badge for the count, a shade brighter on the open tab; green marks only where I am. A dot says History
  // has unread changes without adding them to the count [HIS-07].
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${label}, ${count}${dot ? ", unread changes" : ""}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.row, { gap: 6, paddingVertical: 7, paddingHorizontal: styles.compact ? 9 : 12, borderRadius: 9, backgroundColor: active ? styles.c.surface2 : "transparent" }]}
    >
      <TablerIcon name={icon} size={16} color={active ? styles.action : color} />
      {dot ? <View style={{ position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: styles.action }} /> : null}
      {/* On phones only the active tab is labelled, so four tabs fit. */}
      {active || !styles.compact ? <Text style={{ color, fontSize: 14, fontWeight: active ? "600" : "400" }}>{label}</Text> : null}
      <View style={{ minWidth: 20, alignItems: "center", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 9, backgroundColor: tint(styles.c.foreground, active ? 0.14 : 0.08) }}>
        <Text style={{ color, fontSize: 11, fontWeight: "500" }}>{count}</Text>
      </View>
    </Pressable>
  );
}

function Sections({ sections, actions }: { sections: Section[]; actions: Actions }) {
  return sections.map((section) => (
    <View key={section.id}>
      <SectionHeader icon={SECTION_ICONS[section.id]} title={section.title} count={section.items.length} />
      <Card items={section.items} actions={actions} />
    </View>
  ));
}

// Waiting by who it waits on, each with a list to copy for a nudge, oldest first; a bot gets none, as there's nobody to send
// it to. Last, the work no person holds up. Cards with an active session lead their group [WAI-01, WAI-03].
function Waiting({ groups, actions }: { groups: WaitingGroup[]; actions: Actions }) {
  const styles = useStyles();
  const copy = useCopy();
  if (groups.length === 0) return <Text style={styles.text}>Nothing is waiting on others.</Text>;
  return groups.map((group) => {
    const { who, items } = group;
    const links = `${items.length} link${items.length === 1 ? "" : "s"}`;
    const nudge = (login: string) =>
      copy(linkList(items.map((item) => ({ ...item, lead: nudgeLead(item) }))), `Copied ${links} for ${login}`);
    return (
      <View key={who ? `${who.team ? "team" : "user"}:${who.login.toLowerCase()}` : "nobody"}>
        <SectionHeader
          icon={who ? <Avatar url={who.avatarUrl} team={who.team} bot={who.bot} /> : "clock"}
          title={who?.login ?? "Not on a person"}
          count={items.length}
          action={
            who && !who.bot ? (
              <View style={styles.overCard}>
                <Button icon="markdown" variant="ghost" accessibilityLabel={`Copy what waits on ${who.login}`} onPress={() => nudge(who.login)} />
              </View>
            ) : null
          }
        />
        <Card items={liftActive(items, actions.agents)} actions={actions} group={group} />
      </View>
    );
  });
}

