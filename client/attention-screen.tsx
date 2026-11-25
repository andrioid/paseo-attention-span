import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { liftActive, type Section, type SectionId, SECTIONS, TAB_FEED, type TabId, type WaitingGroup } from "../shared/attention";
import { inProgressEntries, type StartedIssue, withInProgress } from "../shared/in-progress";
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
import { type Actions, type Undoable, useItemActions } from "./item-actions";
import { Card } from "./item-row";
import { InProgress } from "./in-progress";
import { type IssueRowProps, NextUpList } from "./next-up";
import { CodeRepoPicker, SessionOptions } from "./pickers";
import { Still } from "./still";
import { FeedbackAsk, FeedbackLine, type FeedbackScreen, FeedbackSheet } from "./feedback";
import { NewIssueSheet, type NewIssueRequest, takeNewIssueRequest } from "./new-issue";
import { useSessions } from "./sessions";
import { History } from "./history";
import { WrapUp } from "./wrap-up";
import { SetupChecklist } from "./setup";
import { UpdateNotice } from "./update";
import { Avatar, Button, BUTTON_HINT_DELAY_MS, Hint, Loading, SectionHeader, SpinningIcon, StylesProvider, TablerIcon, tint, useCopy, useStyles } from "./ui";

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
  const agents = useSessions(attention.data);
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
  const agentsNow = (agents.data ?? []).filter((agent) => !act.archivedSessions.has(agent.id));
  const wrap = wrapItems(view, agentsNow);
  // Issues I started a session on leave Next up for In progress until a card of their own shows them [PRS-05, SES-11].
  const shown = withInProgress(view, agentsNow, wrap);
  // Notes about work Already in Wrap up wait there; archiving acknowledges them [HIS-07, ATT-22].
  const notes = unreadChanges(view.history.filter((item) => item.section === "changed"), wrap);
  // Calm only once a refresh that worked says Doing is empty, Wrap up included [ATT-18, ATT-22].
  // Sessions not known yet, or failing to load, leave Wrap up unknown: no calm on that [ATT-18, ATT-22].
  const sessionsKnown = agents.isSuccess && !agents.isError;
  // A worktree that stayed after its sessions were archived lingers in Wrap up, uncounted, but keeps the calm away [ATT-22].
  const kept = view.kept ?? [];
  const clear = sessionsKnown && isClear(view, !!attention.error, wrap.length + kept.length + shown.started.length);
  // The other tabs' scenes, on the same terms [HIS-08, WAI-04, NXT-13].
  const calm = {
    history: historyClear(view, notes.length, !!attention.error),
    waiting: waitingClear(view, !!attention.error),
    next: nextUpClear(shown, !!attention.error),
  };
  // ⟳ turns for any refresh of this tab's feed, but only my own press locks it: the cached view can still say a background one runs after it's done.
  const pressed = attention.isRefreshing(TAB_FEED[tab]);
  const refreshing = feed.refreshing || attention.isFetching || pressed;
  const counts = tabCounts(shown, wrap);

  const actions = act.itemActions(view, agentsNow);
  // A started issue's card is Next up's, with its sheet's Unclaim and Close issue [SES-11].
  const issueRow: IssueRowProps = { agents: actions.agents, login: view.login, busy: act.busy, fetchDetails: act.fetchDetails, onOpenAgent: act.openAgent, ...act.issueActions };

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
          <Hint text="Refresh now" inline delayMs={BUTTON_HINT_DELAY_MS}>
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
          </Hint>
          {openSettings ? (
            <Hint text="Settings" inline delayMs={BUTTON_HINT_DELAY_MS}>
              {/* Padding, not hitSlop: native only reaches as far as the hint's wrapper, which hugs the icon. */}
              <Pressable accessibilityRole="button" accessibilityLabel="Attention Span settings" onPress={openSettings} style={{ padding: 8, margin: -8 }}>
                <TablerIcon name="settings" size={16} />
              </Pressable>
            </Hint>
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
          {clear ? <Still /> : wrap.length || kept.length || view.doing.length || shown.started.length ? (
            <>
              {wrap.length + kept.length > 0 ? (
                <WrapUp
                  items={wrap}
                  kept={kept}
                  onArchiveWorktree={act.archiveWorktree}
                  onDismissKept={act.dismissKept}
                  busy={act.busy}
                  login={view.login}
                  fixture={!!view.fixture}
                  agents={agentsNow}
                  fetchDetails={act.fetchDetails}
                  openAgent={act.openAgent}
                  {...act.askActions}
                  onArchive={(item, confirm, terminals) => act.archiveRows([item], confirm, item.key, terminals)}
                  onArchiveAll={async () => {
                    const clean = wrap.filter(cleanSingle);
                    if (clean.length === 0) return;
                    const outcome = await act.archiveRows(clean, false);
                    if (outcome && !outcome.ok && outcome.reason === "unsaved") toast.error("Some sessions have unsaved changes or open terminals. Archive them one by one.");
                  }}
                />
              ) : null}
              {view.doing.length || shown.started.length ? <Sections sections={view.doing} started={shown.started} actions={actions} issueRow={issueRow} /> : null}
            </>
          ) : !feed.fetchedAt && !feed.error ? (
            <Loading text="Checking GitHub…" />
          ) : agents.isError ? (
            <Text style={styles.muted}>Couldn't check your sessions, so Wrap up isn't known yet.</Text>
          ) : !sessionsKnown ? (
            <Loading text="Checking your sessions…" />
          ) : null}
          <ShowDismissed count={view.dismissed.doing} undoable={act.undoable} centered={clear} onPress={() => act.restoreDismissed("doing")} />
        </>
      ) : null}
      {tab === "waiting" ? (
        <>
          {calm.waiting ? <Still shore="jetty" title="Nobody's holding you up." line="Nothing to chase." /> : <Waiting groups={view.waiting} actions={actions} />}
          <ShowDismissed count={view.dismissed.waiting} undoable={act.undoable} centered={calm.waiting} onPress={() => act.restoreDismissed("waiting")} />
        </>
      ) : null}
      {tab === "next" ? (
        <NextUpList
          calm={calm.next}
          openSettings={openSettings}
          assigned={shown.assigned}
          unclaimed={shown.unclaimed}
          unclaimedFrom={view.unclaimedFrom}
          selected={view.scopes}
          sources={nextUpSources(view.config)}
          selectedSources={view.sources}
          projects={view.projects}
          selectedProjects={view.projectFilter}
          onFilter={(change) => act.filterNextUp(view, change)}
          byRepo={view.unclaimedByRepo ?? false}
          onByRepo={(on) => act.groupNextUp(view, on)}
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
      {act.options ? <SessionOptions spec={act.options} config={view.config} started={act.startedOn} onClose={act.closeOptions} /> : null}
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

// In progress comes last and holds the started issues too, even with no drafts [PRS-05, SES-11].
function Sections({ sections, started, actions, issueRow }: { sections: Section[]; started: StartedIssue[]; actions: Actions; issueRow: IssueRowProps }) {
  const all = started.length && !sections.some((section) => section.id === "drafts") ? [...sections, { id: "drafts" as const, title: SECTIONS.drafts.title, items: [] }] : sections;
  return all.map((section) =>
    section.id === "drafts" ? (
      <View key={section.id}>
        <SectionHeader icon={SECTION_ICONS[section.id]} title={section.title} count={section.items.length + started.length} />
        <InProgress entries={inProgressEntries(section.items, started, actions.agents)} actions={actions} issueRow={issueRow} />
      </View>
    ) : (
      <View key={section.id}>
        <SectionHeader icon={SECTION_ICONS[section.id]} title={section.title} count={section.items.length} />
        <Card items={section.items} actions={actions} />
      </View>
    ),
  );
}

// A tab's dismissed items, to bring back; not while the Undo of one just dismissed is still offered. Undo rows go when
// the tab changes, so the ones showing are this tab's [ATT-08].
function ShowDismissed({ count, undoable, centered, onPress }: { count: number; undoable: Undoable[]; centered: boolean; onPress: () => void }) {
  const styles = useStyles();
  if (count <= undoable.filter((row) => row.dismissal).length) return null;
  return (
    <Pressable accessibilityRole="button" style={centered ? { alignSelf: "center", opacity: 0.7 } : undefined} onPress={onPress}>
      <Text style={styles.muted}>{count} dismissed · show them again</Text>
    </Pressable>
  );
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
                <Button icon="copy" variant="ghost" accessibilityLabel={`Copy what waits on ${who.login}`} onPress={() => nudge(who.login)} />
              </View>
            ) : null
          }
        />
        <Card items={liftActive(items, actions.agents)} actions={actions} group={group} />
      </View>
    );
  });
}

