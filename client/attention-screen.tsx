import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Markdown, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type ActionId, type AgentSummary, type AttentionView, type Chip, checkoutPr, type FailingChecks, type Item, itemSessions, liftActive, looseSessions, type NextUpIssue, ownStack, type PersonRole, type Reviewer, type Section, type SectionId, SECTIONS, type SubRow, TAB_FEED, type TabId, type Target, type WaitingGroup, type WaitingOn } from "../shared/attention";
import { type AttentionConfig, nextUpSources, type SessionKind } from "../shared/config";
import { failingList, groupLabel, rerunHistory, summarizeRerun } from "../shared/checks";
import { ago, linkList } from "../shared/format";
import { isClear } from "../shared/still";
import { workEmoji } from "../shared/work";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import { type FeedbackKind, themeName } from "../shared/feedback";
import { blocks } from "../shared/setup";
import { useAttention } from "./data";
import { CardList, CardRow, type CardProps } from "./card";
import type { IconName } from "./icons";
import { NumberText, PlaceText } from "./entity";
import { NextUpList } from "./next-up";
import { Still } from "./still";
import { agentSignal, sessionEntry, startAnotherEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, type DetailsQuery, detailsKey, FadeIn, Modal, type SheetEntry, useArrived, usePrefetchOnRest } from "./sheet";
import { FeedbackAsk, FeedbackLine, type FeedbackScreen, FeedbackSheet } from "./feedback";
import { branchWorkspaces, type FetchProviders, findCheckout, githubProjects, itemAgents, listProfiles, noProjectMessage, resolveAgentConfig, startSession } from "./sessions";
import { SetupChecklist } from "./setup";
import { UpdateNotice } from "./update";
import { Avatar, Button, Hint, KeepStyles, LINE_HEIGHT, Loading, Meta, mix, SectionHeader, SpinningIcon, StylesProvider, TablerIcon, Toggle, useCopy, useHover, useStrongText, useStyles } from "./ui";

// The agent icon marks every action that starts an agent session; the rest act on GitHub right away [ATT-13].
const ACTION_ICONS: Record<ActionId, IconName> = {
  reply: "replyArrow",
  acknowledge: "thumbUp",
  review: "agent",
  fix: "agent",
  rerun: "reload",
  address: "agent",
  update: "update",
  rebase: "agent",
  refresh: "agent",
  ready: "pr",
  request_review: "claim",
  automerge: "clock",
  merge: "merge",
  close: "close",
  start: "agent",
};

function actionLabel(action: ActionId, item: Item): string {
  // Review takes the whole stack; Rebase, my PRs in it [ATT-04].
  const stacked = ownStack(item.target).length > 1;
  return {
    reply: "Reply ↗",
    acknowledge: "Acknowledge",
    review: (item.target.stack?.length ?? 0) > 1 ? "Review stack" : "Review",
    fix: "Fix CI",
    rerun: "Rerun failed jobs",
    address: "Address comments",
    update: "Update branch",
    rebase: stacked ? "Rebase stack" : "Rebase",
    refresh: "Refresh draft",
    ready: "Ready for review",
    request_review: "Request review",
    automerge: "Auto-merge",
    merge: "Merge",
    close: "Close draft",
    start: "Start",
  }[action];
}

// What an action will do, in the sheet, so pressing it makes sense [ATT-06]. Rerun's comes from the fetched checks.
function actionDetail(action: Exclude<ActionId, "rerun">, item: Item): string {
  const { target } = item;
  const pr = `#${target.number}`;
  const base = target.baseRefName ?? target.defaultBranch ?? "its base";
  const stacked = ownStack(target).length > 1;
  const asking = (target.stack ?? []).filter((p) => p.review);
  const comments = item.person?.comments ?? [];
  return {
    reply: item.person ? `Opens ${item.person.login}'s comment on GitHub` : "Opens it on GitHub",
    acknowledge:
      comments.length === 1 ? `Reacts to ${comments[0].author}'s comment, which clears it` : `Pick which of the ${comments.length} waiting comments to react to`,
    review:
      (target.stack?.length ?? 0) > 1
        ? `An agent reviews ${asking.map((p) => `#${p.number}`).join(", ") || "the stack"} in a checkout of the stack's top and reports back. Nothing is posted`
        : "An agent reviews the PR in a checkout and reports back. Nothing is posted",
    fix: "An agent reads the failing logs and commits a fix, without pushing",
    address: "An agent works through the unresolved comments and applies the trivial ones, without pushing",
    update: `GitHub rebases ${pr} onto ${base}`,
    rebase: `An agent rebases ${stacked ? "the stack" : pr} onto ${base}. It pushes only if there were no conflicts`,
    refresh: `An agent rebases the draft onto ${base} and says what it still needs`,
    ready: `Takes ${pr} out of draft, then asks who should review it`,
    request_review: `Pick people or teams to review ${pr}`,
    automerge: `GitHub merges ${pr} into ${base} (${target.mergeMethod}) once checks pass`,
    merge: `Merges ${pr} into ${base} (${target.mergeMethod}) now`,
    close: `Closes ${pr}. A comment is posted only if you write one`,
    start: "An agent reads the issue and proposes a plan",
  }[action];
}

// Rerun failed jobs as a sheet line: which checks failed and whether they were rerun before, flaky or real? [PRS-09]
// It can be pressed before the checks are in: the sheet closes, and the rerun goes ahead once they are.
function rerunEntry(label: string, details: SheetDetails | undefined, rerun: (runIds?: number[]) => void): SheetEntry {
  const base = { key: "rerun", icon: ACTION_ICONS.rerun, label, live: true };
  if (!details || details.isLoading) return { ...base, detail: "Checking which checks failed…", onPress: () => rerun() };
  const failing = details.data?.failing;
  if (!failing) return { ...base, detail: "Couldn't find the failing checks", disabled: true, onPress: () => {} };
  const summary = summarizeRerun(failing);
  if (summary.failed === 0) return { ...base, detail: "No failed checks on the latest commit", disabled: true, onPress: () => {} };
  if (summary.runIds.length === 0)
    return { ...base, detail: `${summary.failed} failed, none in GitHub Actions, so none can be rerun here`, hint: failingList(failing), disabled: true, onPress: () => {} };
  return { ...base, detailNode: <RerunDetail failing={failing} arrived={!!details.arrived} />, hint: failingList(failing), onPress: () => rerun(summary.runIds) };
}

// What an item's sheet has fetched, as its lines need it; `arrived` once it came in while the sheet was open.
interface SheetDetails {
  data?: { failing: FailingChecks[] };
  isLoading: boolean;
  arrived?: boolean;
}

// "7 failed · lint, e2e ×3, unit ×2 · ↻ rerun once": the count and names quiet, as the card's red already says CI failed; checks
// that can't rerun dimmer; the history amber once rerun, a hint it may not be flaky. One line on desktop, where the names give way
// and the hint has them all; two on phones, which can't point at a hint [PRS-09].
function RerunDetail({ failing, arrived }: { failing: FailingChecks[]; arrived: boolean }) {
  const styles = useStyles();
  const summary = summarizeRerun(failing);
  const strong = useStrongText();
  // Dimmer than the quiet text, on the line's own background, so it reads in any theme.
  const dimmer = { color: mix(styles.c.foregroundMuted, styles.c.surface2, 0.55) };
  const stack = summary.prs.length > 1;
  const names = summary.prs.map(({ pr, groups }, index) => (
    <Text key={pr}>
      {index > 0 ? " · " : null}
      {stack ? <Text style={strong}>#{pr} </Text> : null}
      {groups.map((group, at) => (
        <Text key={`${group.name}-${group.rerunnable}`} style={group.rerunnable ? null : dimmer}>
          {at > 0 ? ", " : null}
          {groupLabel(group)}
        </Text>
      ))}
    </Text>
  ));
  const history = (
    <Text style={summary.reruns ? { color: styles.c.statusWarning, fontWeight: "500" } : null}>{summary.reruns ? `↻ ${rerunHistory(summary.reruns)}` : rerunHistory(0)}</Text>
  );
  const line = [styles.muted, { lineHeight: LINE_HEIGHT }];
  return (
    <FadeIn active={arrived}>
      {styles.compact ? (
        <Text style={line} numberOfLines={2}>
          {summary.failed} failed · {names} · {history}
        </Text>
      ) : (
        <View style={{ flexDirection: "row", minWidth: 0 }}>
          <Text style={line}>{summary.failed} failed · </Text>
          <Text style={[line, { flexShrink: 1 }]} numberOfLines={1}>
            {names}
          </Text>
          <Text style={line}> · {history}</Text>
        </View>
      )}
    </FadeIn>
  );
}

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
  done: "merge",
  reviewed: "review",
};

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: "history", label: "History", icon: "history" },
  { id: "doing", label: "Doing", icon: "tray" },
  { id: "waiting", label: "Waiting", icon: "hourglass" },
  { id: "next", label: "Next up", icon: "nextUp" },
];

const AGENTS_QUERY_KEY = ["attention-span", "agents"] as const;
type FetchContext = (input: RpcInput<typeof rpc.sessionContext>) => Promise<RpcOutput<typeof rpc.sessionContext>>;
export type FetchDetails = (input: RpcInput<typeof rpc.itemDetails>) => Promise<RpcOutput<typeof rpc.itemDetails>>;
type DefaultBranch = (repo: string) => Promise<string | null>;
type FetchReviewers = (input: RpcInput<typeof rpc.reviewerChoices>) => Promise<RpcOutput<typeof rpc.reviewerChoices>>;

// A start held back until I say where the issue's code lives [SES-07].
interface Placing {
  itemKey: string;
  kind: SessionKind;
  target: Target;
  missing: string;
  before?: () => Promise<unknown>;
}

// Session options, before it starts [SES-02].
export interface OptionsSpec {
  itemKey: string;
  title: string;
  kind: SessionKind;
  target: Target;
  // Claims an issue first [NXT-05].
  before?: () => Promise<unknown>;
}

// Something I just did, offered for undo until the tab changes [ATT-08, ATT-14].
interface Undoable {
  id: number;
  text: string;
  dismissal?: boolean;
  undo: () => Promise<unknown>;
}

// `openSettings` opens the orgs and repos settings [SRC-02].
export function AttentionScreen({ theme, layout, navigation, openSettings }: PluginScreenProps & { openSettings?: () => void }) {
  return (
    <StylesProvider theme={theme} compact={layout.compact}>
      <AttentionList navigation={navigation} openSettings={openSettings} device={{ device: layout.compact ? "phone" : "desktop", platform: layout.platform, theme: themeName(theme.colors.surface0) }} />
    </StylesProvider>
  );
}

function AttentionList({
  navigation,
  openSettings,
  device,
}: Pick<PluginScreenProps, "navigation"> & { openSettings?: () => void; device: Omit<FeedbackScreen, "tab" | "refreshError"> }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const attention = useAttention();
  const agents = useQuery({ queryKey: AGENTS_QUERY_KEY, queryFn: () => itemAgents(paseo), refetchInterval: 15_000 });
  const fetchContext = useRpc(rpc.sessionContext);
  const dismiss = useRpc(rpc.dismissItem);
  const undismiss = useRpc(rpc.undismissItem);
  const restore = useRpc(rpc.restoreDismissed);
  const saveScopes = useRpc(rpc.setScopes);
  const saveSources = useRpc(rpc.setSources);
  const saveProjects = useRpc(rpc.setProjectFilter);
  const closeIssue = useRpc(rpc.closeIssue);
  const reopenIssue = useRpc(rpc.reopenIssue);
  const update = useRpc(rpc.updateBranch);
  const merge = useRpc(rpc.mergePullRequest);
  const close = useRpc(rpc.closePullRequest);
  const claim = useRpc(rpc.claimIssue);
  const unclaim = useRpc(rpc.unclaimIssue);
  const setReady = useRpc(rpc.setReady);
  const setAutoMerge = useRpc(rpc.setAutoMerge);
  const react = useRpc(rpc.react);
  const requestReviewers = useRpc(rpc.requestReviewers);
  const fetchReviewers = useRpc(rpc.reviewerChoices);
  const rerunFailed = useRpc(rpc.rerunFailed);
  const fetchDetails = useRpc(rpc.itemDetails);
  const setCodeRepo = useRpc(rpc.setCodeRepo);
  const fetchDefaultBranch = useRpc(rpc.defaultBranch);
  const fetchReadyProviders = useRpc(rpc.readyProviders);
  const fetchProviders: FetchProviders = () => fetchReadyProviders({}).then((result) => result.providers);
  const defaultBranch: DefaultBranch = async (repo) => (await fetchDefaultBranch({ repo })).name;
  const [tab, setTab] = useState<TabId>("doing");
  // Every card with a change still running: each runs on its own.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<Undoable[]>([]);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [options, setOptions] = useState<OptionsSpec | null>(null);
  // The feedback sheet, then the first words for the kind picked in it [FB-01].
  const [feedback, setFeedback] = useState<"sheet" | FeedbackKind | null>(null);
  const view = attention.data;
  // Only when something fails: is it setup, and what's missing [SET-01]?
  const fetchSetup = useRpc(rpc.setupStatus);
  const failing = !!attention.error || !!view?.feeds.live.error;
  const setup = useQuery({ queryKey: ["attention-span", "setup"], queryFn: () => fetchSetup({}), enabled: failing });
  const [checking, setChecking] = useState(false);

  async function run(key: string, label: string, work: () => Promise<unknown>) {
    setBusy((keys) => new Set(keys).add(key));
    try {
      await work();
    } catch (error) {
      toast.error(`${label} failed: ${(error as Error).message}`);
    } finally {
      setBusy((keys) => new Set([...keys].filter((other) => other !== key)));
    }
  }

  // A change from one tap, without confirming: Undo instead, where it can be taken back [SAFE-01, ATT-08, ATT-14].
  // The server answers each with the list after it, so nothing needs a refresh.
  function change(key: string, label: string, work: () => Promise<AttentionView>, done: string, undo?: () => Promise<AttentionView>, dismissal?: boolean) {
    void run(key, label, async () => {
      attention.setView(await work());
      if (!undo) return toast.show(done, { variant: "success" });
      const id = Date.now() + Math.random();
      setUndoable((rows) => [...rows, { id, text: done, undo: async () => attention.setView(await undo()), dismissal }]);
    });
  }

  function openAgent(agentId: string) {
    if (navigation?.openAgent) navigation.openAgent({ agentId });
    else toast.show("Session started. Open it from the sidebar.", { variant: "success" });
  }

  async function started(agentId: string) {
    await queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    openAgent(agentId);
  }

  // One tap: start a session with defaults [SES-01]. An open one is offered first, by the card [SES-03].
  async function startWithDefaults(itemKey: string, kind: SessionKind, target: Target, before?: () => Promise<unknown>) {
    if (!view) return;
    await run(itemKey, "Starting the session", () => startNow(itemKey, kind, target, view.config, before));
  }

  async function startNow(itemKey: string, kind: SessionKind, target: Target, config: AttentionConfig, before?: () => Promise<unknown>) {
    const checkout = await findCheckout(paseo, config, target, defaultBranch);
    // Ask where an issue's code lives before claiming it, so a failed start doesn't leave it taken [SES-07].
    if (!checkout.project && target.kind === "issue") return setPlacing({ itemKey, kind, target, missing: checkout.repo, before });
    await before?.();
    const { context } = await fetchContext({ kind, target });
    const prompt = renderPrompt(kind, target, context, config);
    await started(await startSession(paseo, { itemKey, kind, target, prompt, config, fetchProviders, checkout }));
  }

  function place(codeRepo: string) {
    if (!placing) return;
    const { itemKey, kind, target, before } = placing;
    setPlacing(null);
    void run(itemKey, "Starting the session", async () => {
      const next = await setCodeRepo({ issueRepo: target.repo, codeRepo });
      attention.setView(next);
      await startNow(itemKey, kind, target, next.config, before);
    });
  }

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
  // Calm only once a refresh that worked says Doing is empty [ATT-18].
  const clear = isClear(view, !!attention.error);
  // ⟳ turns for any refresh of this tab's feed, but only my own press locks it: the cached view can still say a background one runs after it's done.
  const pressed = attention.isRefreshing(TAB_FEED[tab]);
  const refreshing = feed.refreshing || attention.isFetching || pressed;
  const counts: Record<TabId, number> = {
    history: view.history.filter((item) => item.section === "done").length,
    doing: view.count,
    // Work waiting on several people counts once.
    waiting: new Set(view.waiting.flatMap((group) => group.items.map((item) => item.key))).size,
    next: view.assigned.length + view.unclaimed.length,
  };

  const actions: Actions = {
    agents: view.fixtureAgents ?? agents.data ?? [],
    startWithOptions: setOptions,
    busy,
    config: view.config,
    login: view.login,
    fetchContext,
    fetchDetails,
    fetchReviewers,
    defaultBranch,
    fetchProviders,
    openAgent,
    started,
    act: (item, action) => {
      const session = ACTION_SESSION[action];
      const { target } = item;
      if (action === "reply") return void openExternalUrl(item.person?.url ?? item.url);
      if (session) return void startWithDefaults(item.key, session, target);
      if (action === "update") change(item.key, "Update", () => update({ key: item.key, target }), `Updating PR ${target.number} with ${target.baseRefName}`);
      // [PRS-11]
      if (action === "ready")
        change(item.key, "Ready for review", () => setReady({ key: item.key, target, ready: true }), `PR ${target.number} is ready for review`, () => setReady({ key: item.key, target, ready: false }));
      // [PRS-10]
      if (action === "automerge")
        change(item.key, "Auto-merge", () => setAutoMerge({ key: item.key, target, on: true }), `PR ${target.number} merges once checks pass`, () => setAutoMerge({ key: item.key, target, on: false }));
    },
    // [PRS-09]
    rerun: (item, known) => {
      if (!known) toast.show("Finding the failed jobs to rerun…");
      change(
        item.key,
        "Rerun",
        async () => {
          const runIds = known ?? summarizeRerun((await queryClient.fetchQuery({ ...itemDetailsQuery(item, fetchDetails), staleTime: DETAILS_STALE_MS })).failing).runIds;
          if (runIds.length === 0) throw new Error("no failed GitHub Actions jobs to rerun");
          return rerunFailed({ key: item.key, repo: item.target.repo, runIds });
        },
        `Rerunning the failed jobs of PR ${item.target.number}`,
      );
    },
    // [PRS-12]
    requestReviewers: (item, reviewers) => {
      const { target } = item;
      const names = reviewers.length === 1 ? reviewers[0] : `${reviewers.length} reviewers`;
      change(item.key, "Request review", () => requestReviewers({ key: item.key, target, reviewers, on: true }), `Asked ${names} to review PR ${target.number}`, () =>
        requestReviewers({ key: item.key, target, reviewers, on: false }),
      );
    },
    // [MEN-07]
    acknowledge: (item, ids) =>
      change(item.key, "Acknowledge", () => react({ key: item.key, subjectIds: ids, on: true }), `Acknowledged ${ids.length === 1 ? "a comment" : `${ids.length} comments`} on #${item.number}`, () =>
        react({ key: item.key, subjectIds: ids, on: false }),
      ),
    confirm: (item, action, comment) =>
      action === "merge"
        ? change(item.key, "Merge", () => merge({ key: item.key, target: item.target }), `PR ${item.target.number} merged`)
        : change(item.key, "Close", () => close({ key: item.key, target: item.target, comment }), `PR ${item.target.number} closed`),
    dismiss: (item) => change(item.key, "Dismiss", () => dismiss({ key: item.key }), `Dismissed “${item.title}”`, () => undismiss({ key: item.key }), true),
  };

  const switchTab = (id: TabId) => {
    setTab(id);
    setUndoable([]);
  };

  return (
    // A clear Doing tab fills the screen, so its scene has room and the rest sits at the bottom [ATT-18].
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, tab === "doing" && clear ? { flexGrow: 1 } : null]}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={styles.row}>
          {TABS.map(({ id, label, icon }) => (
            <Tab key={id} icon={icon} label={label} count={counts[id]} active={tab === id} onPress={() => switchTab(id)} />
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

      {undoable.map((row) => (
        <View key={row.id} style={[styles.panel, styles.row, { justifyContent: "space-between" }]}>
          <Text style={[styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {row.text}
          </Text>
          <Button
            label="Undo"
            variant="calm"
            onPress={() =>
              void run(String(row.id), "Undo", async () => {
                await row.undo();
                setUndoable((rows) => rows.filter((other) => other.id !== row.id));
              })
            }
          />
        </View>
      ))}
      {tab === "history" ? <History items={view.history} actions={actions} /> : null}
      {tab === "doing" ? (
        <>
          {clear ? <Still /> : view.doing.length ? <Sections sections={view.doing} actions={actions} /> : !feed.fetchedAt && !feed.error ? <Loading text="Checking GitHub…" /> : null}
          {view.dismissedCount > undoable.filter((row) => row.dismissal).length ? (
            <Pressable
              accessibilityRole="button"
              style={clear ? { alignSelf: "center", opacity: 0.7 } : undefined}
              onPress={() => void run("restore", "Restore", async () => (attention.setView(await restore({})), setUndoable([])))}
            >
              <Text style={styles.muted}>{view.dismissedCount} dismissed · show them again</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "waiting" ? <Waiting groups={view.waiting} actions={actions} /> : null}
      {tab === "next" ? (
        <NextUpList
          assigned={view.assigned}
          unclaimed={view.unclaimed}
          unclaimedFrom={view.unclaimedFrom}
          selected={view.scopes}
          sources={nextUpSources(view.config)}
          selectedSources={view.sources}
          projects={view.projects}
          selectedProjects={view.projectFilter}
          // One setView for all, so clearing them together can't put any back.
          onFilter={(change) => {
            attention.setView({ ...view, ...change });
            const failed = (error: Error) => toast.error(`Saving the filter failed: ${error.message}`);
            if (change.scopes) saveScopes({ scopes: change.scopes }).catch(failed);
            if (change.sources) saveSources({ sources: change.sources }).catch(failed);
            if (change.projectFilter) saveProjects({ projects: change.projectFilter }).catch(failed);
          }}
          agents={actions.agents}
          login={view.login}
          busy={busy}
          fetchDetails={fetchDetails}
          onOpenAgent={openAgent}
          onStart={(issue, claimFirst) => {
            const target = issueTarget(issue);
            void startWithDefaults(issue.key, "start", target, claimFirst ? async () => attention.setView(await claim({ key: issue.key, target })) : undefined);
          }}
          onOptions={(issue, claimFirst, label) => {
            const target = issueTarget(issue);
            setOptions({ itemKey: issue.key, title: `${label}: ${issue.title}`, kind: "start", target, before: claimFirst ? async () => attention.setView(await claim({ key: issue.key, target })) : undefined });
          }}
          // Claim without starting, or give it back; each undoes the other [NXT-07].
          onClaim={(issue, on) => {
            const target = issueTarget(issue);
            const [take, giveBack] = [() => claim({ key: issue.key, target }), () => unclaim({ key: issue.key, target })];
            change(issue.key, on ? "Claim" : "Unclaim", on ? take : giveBack, `${on ? "Claimed" : "Unclaimed"} #${issue.number}`, on ? giveBack : take);
          }}
          // Undo reopens; a comment already posted stays [NXT-11].
          onCloseIssue={(issue, reason, comment) => {
            const target = issueTarget(issue);
            const done = `Closed #${issue.number} as ${reason === "completed" ? "completed" : "not planned"}`;
            change(issue.key, "Close", () => closeIssue({ key: issue.key, target, reason, comment: comment || undefined }), done, () => reopenIssue({ key: issue.key, target }));
          }}
        />
      ) : null}
      <FeedbackLine onPress={() => setFeedback("sheet")} />
      {feedback === "sheet" ? <FeedbackSheet agents={actions.agents} onOpenAgent={openAgent} onAsk={setFeedback} onClose={() => setFeedback(null)} /> : null}
      {feedback && feedback !== "sheet" ? (
        <FeedbackAsk
          kind={feedback}
          config={view.config}
          screen={{ ...device, tab, refreshError: feed.error ?? null }}
          onStarted={started}
          onBack={() => setFeedback("sheet")}
          onClose={() => setFeedback(null)}
        />
      ) : null}
      {options ? <SessionOptions spec={options} actions={actions} onClose={() => setOptions(null)} /> : null}
      {placing ? <CodeRepoPicker issueRepo={placing.target.repo} missing={placing.missing} onPick={place} onClose={() => setPlacing(null)} /> : null}
    </ScrollView>
  );
}

function Tab({ icon, label, count, active, onPress }: { icon: IconName; label: string; count: number; active: boolean; onPress: () => void }) {
  const styles = useStyles();
  const color = active ? styles.c.foreground : styles.c.foregroundMuted;
  // A soft round badge for the count, a shade brighter on the open tab; green marks only where I am.
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.row, { gap: 6, paddingVertical: 7, paddingHorizontal: styles.compact ? 9 : 12, borderRadius: 9, backgroundColor: active ? styles.c.surface2 : "transparent" }]}
    >
      <TablerIcon name={icon} size={16} color={active ? styles.action : color} />
      {/* On phones only the active tab is labelled, so four tabs fit. */}
      {active || !styles.compact ? <Text style={{ color, fontSize: 14, fontWeight: active ? "600" : "400" }}>{label}</Text> : null}
      <View style={{ minWidth: 20, alignItems: "center", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 9, backgroundColor: tint(styles.c.foreground, active ? 0.14 : 0.08) }}>
        <Text style={{ color, fontSize: 11, fontWeight: "500" }}>{count}</Text>
      </View>
    </Pressable>
  );
}

// A theme colour, see-through, so a badge reads on any surface; colours that aren't #rrggbb fall back to none.
function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1];
  if (!hex) return "transparent";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface Actions {
  agents: AgentSummary[];
  startWithOptions: (spec: OptionsSpec) => void;
  busy: ReadonlySet<string>;
  config: AttentionConfig;
  login: string | null;
  fetchContext: FetchContext;
  fetchDetails: FetchDetails;
  fetchReviewers: FetchReviewers;
  defaultBranch: DefaultBranch;
  fetchProviders: FetchProviders;
  act: (item: Item, action: ActionId) => void;
  requestReviewers: (item: Item, reviewers: string[]) => void;
  // Without run ids, it finds them first: Rerun pressed before the sheet had the failing checks.
  rerun: (item: Item, runIds?: number[]) => void;
  acknowledge: (item: Item, commentIds: string[]) => void;
  confirm: (item: Item, action: "merge" | "close", comment?: string) => void;
  dismiss: (item: Item) => void;
  openAgent: (agentId: string) => void;
  started: (agentId: string) => Promise<void>;
}

// What the card is: open, draft, merged or closed. Urgency stays in the chips and section headers.
function stateMark(item: Item): CardProps["mark"] {
  if (item.closedAt) return item.kind === "pr" ? { icon: "merge", tone: "good" } : { icon: "issueClosed", tone: item.chips.length ? "neutral" : "good" };
  if (item.kind === "issue") return { icon: "issue", tone: "good" };
  return item.draft ? { icon: "draft", tone: "neutral" } : { icon: "pr", tone: "good" };
}

// A card that works collapsed: its main action and ›. Tapping it opens the sheet with everything else [ATT-05, ATT-06].
const isRed = (chips: Chip[]) => chips.some((chip) => chip.tone === "bad");

// The sheet, Acknowledge, or the reviewer picker (after Ready for review, or on its own).
type Sheet = "item" | "acknowledge" | "reviewers" | "reviewers-after-ready" | null;

// A session on an item that has no session action of its own starts with this prompt; it's editable first.
const fallbackKind = (item: Item): SessionKind => (item.target.kind === "issue" ? "start" : "review");

// Why it waits and how long, in Waiting only; Doing says what's mine to do. Once it has waited too long, where nudging is
// fair, the age itself turns amber with ⌛ and says so in words [WAI-01, ATT-11].
function waitChips(item: Item, inWaiting: boolean, tooLongDays: number): Chip[] {
  const { wait } = item;
  if (!wait || !inWaiting) return [];
  const age = ago(wait.since);
  const reason: Chip[] = wait.reason ? [{ text: wait.reason, tone: "neutral" }] : [];
  if (!wait.tooLong) return [...reason, { text: age, tone: "neutral" }];
  const since = wait.reason === "question" ? "you asked" : "your last push or reply";
  const limit = `${tooLongDays} day${tooLongDays === 1 ? "" : "s"}`;
  return [...reason, { text: age, tone: "warn", icon: "hourglass", hint: `Waited too long: ${age} since ${since}, more than ${limit}` }];
}

// "Review 2h", "Question 3d": why and how long, to lead a line in a nudge [WAI-03].
function nudgeLead(item: Item): string | undefined {
  if (!item.wait) return undefined;
  const { reason, since } = item.wait;
  return reason ? `${reason[0].toUpperCase()}${reason.slice(1)} ${ago(since)}` : ago(since);
}

const samePerson = (a: WaitingOn, b: WaitingOn) => a.team === b.team && a.login.toLowerCase() === b.login.toLowerCase();

// In Waiting, a card sits under one of whom it waits on: its group.
function ItemRow({ item, first, actions, group }: { item: Item; first: boolean; actions: Actions; group?: WaitingGroup }) {
  const styles = useStyles();
  // An open session leads; without one, the item's own action does [SES-03].
  const sessions = itemSessions(actions.agents, item);
  const waits = waitChips(item, !!group, actions.config.waitingTooLongDays);
  // The group names one; the card names the rest [WAI-01].
  const others = group?.who ? (item.waitingOn ?? []).filter((who) => !samePerson(who, group.who!)) : [];
  const waitingOn = group ? null : item.waitingOn ? <WaitingOnLine people={item.waitingOn} asked={item.wait?.reason === "question"} expanded={false} /> : null;
  const alsoOn = others.length ? <Text style={styles.muted}>also waiting on {others.map((who) => who.login).join(", ")}</Text> : null;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const main = item.actions[0];
  // The full stack is in the sheet; the card shows the PRs that need attention [ATT-04]. Once it shows any, it shows the PR an
  // issue's actions apply to as well, tinted, and says that PR's facts there rather than in its meta, as the sheet does [ATT-06].
  const target = targetUrl(item);
  const needing = item.children.some((child) => child.attention || isRed(child.chips));
  const children = needing ? item.children.filter((child) => child.attention || isRed(child.chips) || child.url === target) : [];
  const targetRow = children.find((child) => child.url === target);
  const shown = [...waits, ...stackMetaChips(item, targetRow)];
  const chips = sessions[0] ? [...shown, agentSignal(sessions[0])] : shown;
  // The sheet opens at once; what it fetches fills in [ATT-06].
  const open = () => setSheet("item");
  const prefetch = usePrefetchOnRest(itemDetailsQuery(item, actions.fetchDetails));
  const copy = useCopy();
  const history = SECTIONS[item.section].tab === "history";

  function perform(action: ActionId) {
    setSheet(null);
    if (action === "merge" || action === "close") setConfirm(action);
    else if (action === "acknowledge") setSheet("acknowledge");
    else if (action === "request_review") setSheet("reviewers");
    // A draft made ready goes straight on to who should review it [PRS-11].
    else if (action === "ready") (actions.act(item, action), setSheet("reviewers-after-ready"));
    else actions.act(item, action);
  }
  const handlers: SheetHandlers = { onPerform: perform, onClose: () => setSheet(null) };
  // A sheet with one action is a wasted tap: show that action instead of ›. The card still opens the sheet, quiet lines and all [ATT-06].
  const loud = sheetEntries(item, sessions, actions, handlers).filter((entry) => !entry.quiet);
  const only = loud.length === 1 ? loud[0] : undefined;
  const confirmed = (action: "merge" | "close") => (comment: string) => (setConfirm(null), actions.confirm(item, action, comment));

  return (
    <CardRow
      first={first}
      mark={stateMark(item)}
      title={item.title}
      meta={{
        place: { repo: item.repo, number: item.number, login: actions.login },
        when: item.closedAt ? `${item.kind === "pr" ? "merged" : "closed"} ${ago(item.closedAt)} ago` : undefined,
        signals: chips,
      }}
      extra={
        item.person || waitingOn || alsoOn || children.length > 0 ? (
          <>
            {item.person ? <PersonQuote person={item.person} expanded={false} /> : null}
            {waitingOn}
            {alsoOn}
            {children.length > 0 ? <StackLine rows={children} merged={!!item.closedAt} target={targetRow?.key} /> : null}
          </>
        ) : null
      }
      onOpen={open}
      hover={prefetch}
      busy={actions.busy.has(item.key)}
      primary={
        sessions[0]
          ? { label: "Open session", icon: "agent", onPress: () => actions.openAgent(sessions[0].id) }
          : main
            ? { label: actionLabel(main, item), icon: ACTION_ICONS[main], onPress: () => perform(main) }
            : undefined
      }
      secondary={[
        only ? { label: only.label, icon: only.icon, onPress: only.onPress } : { label: `Details for #${item.number}`, icon: "chevronRight", onPress: open },
        // History is where I report from, so its cards copy their link in one tap [ATT-15].
        ...(history ? [{ label: `Copy link to #${item.number}`, icon: "copy" as const, onPress: () => copy(item.url, `Copied link to #${item.number}`) }] : []),
      ]}
      confirm={
        confirm === "merge"
          ? {
              text: `Merge PR ${item.target.number} into ${item.target.baseRefName} (${item.target.mergeMethod})?`,
              choices: [{ label: "Merge", icon: "merge", solid: true, onConfirm: confirmed("merge") }],
              onCancel: () => setConfirm(null),
            }
          : confirm === "close"
            ? {
                text: `Close PR ${item.target.number}? A comment is only posted if you write one.`,
                comment: true,
                choices: [{ label: "Close PR", icon: "close", solid: true, onConfirm: confirmed("close") }],
                onCancel: () => setConfirm(null),
              }
            : null
      }
      overlay={
        <>
          {sheet === "item" ? <ItemSheet item={item} waitChips={waits} sessions={sessions} actions={actions} {...handlers} /> : null}
          {sheet === "acknowledge" ? <AcknowledgeSheet item={item} onReact={(ids) => (setSheet(null), actions.acknowledge(item, ids))} onClose={() => setSheet(null)} /> : null}
          {sheet === "reviewers" || sheet === "reviewers-after-ready" ? (
            <ReviewerSheet
              item={item}
              afterReady={sheet === "reviewers-after-ready"}
              fetchReviewers={actions.fetchReviewers}
              onRequest={(reviewers) => (setSheet(null), actions.requestReviewers(item, reviewers))}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </>
      }
    />
  );
}

interface SheetHandlers {
  onPerform: (action: ActionId) => void;
  onClose: () => void;
}

// What the card already knows on top, then every action, then what's fetched when it opens, so nothing jumps as it loads [ATT-06, GH-01].
// What an item's sheet fetches when it opens; resting the pointer on its card fetches the same ahead. `checks` asks for
// failing checks too, for Rerun.
function itemDetailsQuery(item: Item, fetchDetails: FetchDetails): DetailsQuery {
  const checks = item.actions.includes("rerun");
  const subject = { kind: item.kind, repo: item.repo, number: item.number };
  return { queryKey: detailsKey(subject, item.target, checks), queryFn: () => fetchDetails({ subject, target: item.target, checks }) };
}

// The PR an item's actions apply to, where that isn't the item itself, like an issue's PR.
const targetUrl = (item: Item) => (item.target.number !== item.number || item.target.kind !== item.kind ? item.target.url : undefined);

// An issue's chips are about the PR its actions apply to. Where its stack line shows that PR, each is said once, on that PR's
// row, and the meta keeps only what the row doesn't say; "PR #103" and "stack of 2" are the stack line itself. The sheet always
// shows the row; a card only when a PR in the stack needs attention [ATT-04, ATT-06].
function stackMetaChips(item: Item, targetRow: SubRow | undefined): Chip[] {
  if (!targetRow) return item.chips;
  const onRow = new Set(targetRow.chips.map((chip) => chip.text));
  return item.chips.filter((chip) => !/^PR #\d+$/.test(chip.text) && !/^stack of \d+$/.test(chip.text) && !onRow.has(chip.text));
}

function ItemSheet({ item, waitChips, sessions, actions, ...handlers }: { item: Item; waitChips: Chip[]; sessions: AgentSummary[]; actions: Actions } & SheetHandlers) {
  const details = useQuery({ ...itemDetailsQuery(item, actions.fetchDetails), staleTime: DETAILS_STALE_MS });
  const arrived = useArrived(details.isLoading);
  const elsewhere = !!targetUrl(item);
  // The row of the PR its actions apply to, where it's in the stack line: marked there instead of named on top.
  const targetRow = elsewhere ? item.children.find((child) => child.url === item.target.url) : undefined;
  const meta = elsewhere && !targetRow ? [`actions apply to PR #${item.target.number}`] : [];
  // PRs already in the stack line link from there; list only the rest, like someone else's PR closing the same issue.
  const shown = new Set(item.children.map((child) => child.url));
  const extra = details.data && { ...details.data, linked: details.data.linked.filter((link) => !shown.has(link.url)) };
  return (
    <ActionSheet
      title={item.title}
      onClose={handlers.onClose}
      top={
        <>
          {/* Number first, as on the card; the sheet always names the owner, even of my own repos [ATT-20]. */}
          <Meta lead={<PlaceText place={{ repo: item.repo, number: item.number, login: null }} />} facts={meta} chips={[...waitChips, ...stackMetaChips(item, targetRow)]} />
          {item.person ? <PersonQuote person={item.person} expanded /> : null}
          {item.waitingOn ? <WaitingOnLine people={item.waitingOn} asked={item.wait?.reason === "question"} expanded /> : null}
          {item.children.length > 0 ? <StackLine rows={item.children} merged={!!item.closedAt} links target={targetRow?.key} /> : null}
        </>
      }
      entries={sheetEntries(item, sessions, actions, handlers, { data: details.data, isLoading: details.isLoading, arrived })}
      // The PR its actions apply to has a size line, named where it isn't the item; an issue's PRs are in its stack line
      // already, so few more come [ATT-06].
      bottom={
        <DetailLines
          details={extra}
          loading={details.isLoading}
          error={details.error}
          linkedLabel={item.kind === "issue" ? "PR" : "Closes"}
          expected={item.target.kind === "pr" ? 1 : 0}
          sizeOf={elsewhere ? item.target.number : undefined}
        />
      }
    />
  );
}

// Everything an item's sheet offers, each saying what it will do [ATT-06]. Rerun's line says more once the checks are in.
function sheetEntries(
  item: Item,
  sessions: AgentSummary[],
  actions: Actions,
  { onPerform, onClose }: SheetHandlers,
  details?: SheetDetails,
): SheetEntry[] {
  const inDoing = SECTIONS[item.section].tab === "doing";
  const close = (then: () => void) => () => (onClose(), then());

  const open = (agentId: string) => close(() => actions.openAgent(agentId))();
  const withOptions = (label: string, kind: SessionKind) => close(() => actions.startWithOptions({ itemKey: item.key, title: `${label}: ${item.title}`, kind, target: item.target }));
  // Sessions none of its actions would start lead, needs me first [SES-03].
  const kinds = item.actions.flatMap((action) => ACTION_SESSION[action] ?? []);
  const entries: SheetEntry[] = looseSessions(sessions, kinds).map((agent) => sessionEntry(agent, sessionLabel(agent.kind, item), open));
  for (const action of item.actions) {
    const kind = ACTION_SESSION[action];
    const label = actionLabel(action, item);
    if (kind) {
      // An action's session takes its line once it runs, so work on it stays in one place [SES-03].
      // Until then it asks first: the card's button is the one-tap start [SES-01, SES-02].
      const running = sessions.filter((agent) => agent.kind === kind);
      if (running.length) entries.push(...running.map((agent) => sessionEntry(agent, sessionLabel(kind, item), open)));
      else entries.push({ key: action, icon: "agent", label: `${label}…`, detail: actionDetail(action as Exclude<ActionId, "rerun">, item), onPress: withOptions(label, kind) });
    } else if (action === "rerun") {
      entries.push(rerunEntry(label, details, (runIds) => close(() => actions.rerun(item, runIds))()));
    } else {
      // Closing it sits apart, below the work, with Dismiss [ATT-06].
      entries.push({ key: action, icon: ACTION_ICONS[action], label, detail: actionDetail(action, item), housekeeping: action === "close", onPress: () => onPerform(action) });
    }
  }
  // Anything Attention Span doesn't cover [ATT-12], and its link to share [ATT-15].
  entries.push({
    key: "github",
    icon: "github",
    label: `Open ${item.kind === "issue" ? "issue" : "PR"} on GitHub`,
    detail: `${item.repo}#${item.number}`,
    onPress: close(() => void openExternalUrl(item.url)),
    copy: { text: item.url, label: `Copy link to #${item.number}`, done: `Copied link to #${item.number}` },
  });
  // Nothing's left to start on once it's merged or closed.
  if (!item.closedAt) entries.push(startAnotherEntry(sessions.length > 0, withOptions("Start session", fallbackKind(item))));
  if (inDoing) entries.push({ key: "dismiss", icon: "dismiss", label: "Dismiss", detail: "Hides it until something new happens on it", housekeeping: true, onPress: close(() => actions.dismiss(item)) });
  return entries;
}

// A session is named for what started it; one of no kind, or a Start's, just continues.
const sessionLabel = (kind: SessionKind | undefined, item: Item) => (kind && kind !== "start" ? actionLabel(kind, item) : "Continue session");

// Pick which waiting comments get a 👍, after reading them in full; all are picked to start [MEN-07].
function AcknowledgeSheet({ item, onReact, onClose }: { item: Item; onReact: (ids: string[]) => void; onClose: () => void }) {
  const styles = useStyles();
  const comments = item.person?.comments ?? [];
  const [picked, setPicked] = useState(() => new Set(comments.map((c) => c.id)));
  const toggle = (id: string) => setPicked((now) => (now.has(id) ? new Set([...now].filter((other) => other !== id)) : new Set([...now, id])));
  return (
    <Modal title={`Acknowledge: ${item.title}`} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <View style={styles.row}>
            <TablerIcon name="thumbUp" size={14} />
            <Text style={[styles.muted, { flexShrink: 1 }]}>Tells them you've seen it, and clears it from your list.</Text>
          </View>
          {comments.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: picked.has(c.id) }}
              accessibilityLabel={`Comment from ${c.author}`}
              onPress={() => toggle(c.id)}
              style={[styles.quote, styles.row, { alignItems: "flex-start", gap: 10 }]}
            >
              <TablerIcon name={picked.has(c.id) ? "squareCheck" : "square"} size={18} color={picked.has(c.id) ? styles.action : styles.c.foregroundMuted} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600" }}>
                  {c.author} <Text style={[styles.muted, { fontWeight: "400" }]}>· {ago(c.createdAt)}</Text>
                </Text>
                <Markdown>{c.body}</Markdown>
              </View>
            </Pressable>
          ))}
          <View style={styles.wrap}>
            <Button
              label={`${picked.size} comment${picked.size === 1 ? "" : "s"}`}
              icon="thumbUp"
              accessibilityLabel={`Acknowledge ${picked.size} comment${picked.size === 1 ? "" : "s"}`}
              variant="solid"
              disabled={picked.size === 0}
              onPress={() => onReact(comments.filter((c) => picked.has(c.id)).map((c) => c.id))}
            />
            <Button label="Cancel" onPress={onClose} />
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

// Who should review a PR: GitHub's suggestions, who reviewed my other PRs in the repo, its teams, or anyone typed in.
// All start unticked; requesting keeps whoever is already asked [PRS-12].
function ReviewerSheet({
  item,
  afterReady,
  fetchReviewers,
  onRequest,
  onClose,
}: {
  item: Item;
  afterReady: boolean;
  fetchReviewers: FetchReviewers;
  onRequest: (reviewers: string[]) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const choices = useQuery({ queryKey: ["attention-span", "reviewers", item.target.repo, item.target.number], queryFn: () => fetchReviewers({ target: item.target }), staleTime: 60_000 });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState<Reviewer[]>([]);
  const [text, setText] = useState("");
  const toggle = (login: string) => setPicked((now) => (now.has(login) ? new Set([...now].filter((other) => other !== login)) : new Set([...now, login])));
  // Each person or team once, in the first group that has them.
  const seen = new Set<string>();
  const once = (list: Reviewer[]) => list.filter((reviewer) => !seen.has(reviewer.login.toLowerCase()) && seen.add(reviewer.login.toLowerCase()));
  const groups = [
    { title: "Added", list: once(typed) },
    { title: "Suggested by GitHub", list: once(choices.data?.suggested ?? []) },
    { title: "Recent on your PRs here", list: once(choices.data?.recent ?? []) },
    { title: "Teams", list: once(choices.data?.teams ?? []) },
  ];
  const add = () => {
    const login = text.trim().replace(/^@/, "");
    if (!login) return;
    setTyped((now) => [...now, { login, team: login.includes("/") }]);
    setPicked((now) => new Set([...now, login]));
    setText("");
  };
  const count = `${picked.size} reviewer${picked.size === 1 ? "" : "s"}`;
  return (
    <Modal title={`${afterReady ? "Ready for review" : "Request review"}: ${item.title}`} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <Text style={styles.muted}>{afterReady ? `PR ${item.target.number} is out of draft. Who should review it?` : `Who should review PR ${item.target.number}?`}</Text>
          {choices.isLoading ? <Loading text="Loading suggestions…" /> : null}
          {choices.error ? <Text style={styles.danger}>Couldn't load suggestions: {(choices.error as Error).message}</Text> : null}
          {groups.map(({ title, list }) =>
            list.length > 0 ? (
              <View key={title} style={{ gap: 4 }}>
                <Text style={[styles.muted, { fontSize: 12 }]}>{title}</Text>
                {list.map((reviewer) => (
                  <Pressable
                    key={reviewer.login}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: picked.has(reviewer.login) }}
                    accessibilityLabel={reviewer.login}
                    onPress={() => toggle(reviewer.login)}
                    style={[styles.row, { paddingVertical: 4 }]}
                  >
                    <TablerIcon name={picked.has(reviewer.login) ? "squareCheck" : "square"} size={18} color={picked.has(reviewer.login) ? styles.action : styles.c.foregroundMuted} />
                    {reviewer.team ? <TablerIcon name="claim" size={18} color={styles.c.foregroundMuted} /> : <Avatar url={reviewer.avatarUrl} />}
                    <Text style={{ color: styles.c.foreground, fontSize: 13 }}>{reviewer.login}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null,
          )}
          {choices.data?.teamsNote ? <Text style={styles.muted}>{choices.data.teamsNote}</Text> : null}
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Login, or org/team"
              placeholderTextColor={styles.c.foregroundMuted}
              value={text}
              onChangeText={setText}
              onSubmitEditing={add}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button label="Add" variant="calm" disabled={!text.trim()} onPress={add} />
          </View>
          <View style={styles.wrap}>
            <Button
              label={`Request ${count}`}
              icon="claim"
              variant="solid"
              disabled={picked.size === 0}
              onPress={() => onRequest([...picked])}
            />
            <Button label={afterReady ? "Skip" : "Cancel"} onPress={onClose} />
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

// What a face on a card is to it, where no quote says it: the icon of the tab or section that means the same, so whom I wait on
// reads like Waiting, and whose comments are left like Changes requested [ATT-19].
const ROLE_ICON: Record<PersonRole | "waiting", IconName> = { waiting: "hourglass", author: "pencil", changes: "changes" };

// The icon sits tight against the faces it explains, apart from the name and time, so they read as one.
function Badged({ role, children }: { role: keyof typeof ROLE_ICON; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <TablerIcon name={ROLE_ICON[role]} size={16} color={styles.c.foregroundMuted} />
      {children}
    </View>
  );
}

// Who is waiting on me, or who I'm waiting on.
function PersonQuote({ person, expanded }: { person: NonNullable<Item["person"]>; expanded: boolean }) {
  const styles = useStyles();
  const name = <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600" }}>{person.login}</Text>;
  // An author line says who, not when: its time meant something different on each tab [ATT-19].
  if (!person.snippet && person.role) {
    const text = person.role === "author" ? `Opened by ${person.login}` : `${person.login}'s comments are left to address, since your last push ${ago(person.since)} ago`;
    return (
      <Hint text={text}>
        <View style={styles.row}>
          <Badged role={person.role}>
            <Avatar url={person.avatarUrl} bot={person.bot} />
          </Badged>
          {name}
          {person.role === "author" ? null : <Text style={styles.muted}>· {ago(person.since)}</Text>}
        </View>
      </Hint>
    );
  }
  const line = (
    <View style={styles.row}>
      <Avatar url={person.avatarUrl} bot={person.bot} />
      {name}
      <Text style={styles.muted}>· {ago(person.since)}</Text>
    </View>
  );
  if (!person.snippet) return line;
  return (
    <View style={styles.quote}>
      {line}
      <Text style={{ color: styles.c.foreground, fontSize: 13, lineHeight: 18 }} numberOfLines={expanded ? undefined : 2}>
        {person.snippet}
      </Text>
    </View>
  );
}

// Pictures on a card before the rest are counted, so a crowd fits a phone; the sheet names everyone.
const MAX_FACES = 5;

// Who my work waits on: one by name, several by picture, named on hover, and each by name in the sheet [WAI-02].
// On an issue they're who my question tagged; on a PR, reviewers since my last push or reply [WAI-02, ATT-19].
function WaitingOnLine({ people, asked, expanded }: { people: WaitingOn[]; asked: boolean; expanded: boolean }) {
  const styles = useStyles();
  const [hovered, setHovered] = useState<string | null>(null);
  const name = (login: string) => (
    <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
      {login}
    </Text>
  );
  const since = (at: string) => <Text style={styles.muted}>· {ago(at)}</Text>;
  const explain = (logins: string[], at: string) => `Waiting on ${logins.join(", ")} since ${asked ? "you asked" : "your last push or reply"}, ${ago(at)} ago`;
  if (expanded || people.length === 1) {
    return (
      <View style={{ gap: 6 }}>
        {people.map((who) => (
          <Hint key={who.login} text={explain([who.login], who.since)}>
            <View style={styles.row}>
              <Badged role="waiting">
                <Avatar url={who.avatarUrl} team={who.team} />
              </Badged>
              {name(who.login)}
              {since(who.since)}
            </View>
          </Hint>
        ))}
      </View>
    );
  }
  const earliest = people.map((who) => who.since).sort()[0];
  return (
    <Hint text={explain(people.map((who) => who.login), earliest)}>
      <View style={styles.row}>
        <Badged role="waiting">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {people.slice(0, MAX_FACES).map((who) => (
              <View key={who.login} onPointerEnter={() => setHovered(who.login)} onPointerLeave={() => setHovered((current) => (current === who.login ? null : current))}>
                <Avatar url={who.avatarUrl} team={who.team} />
              </View>
            ))}
            {people.length > MAX_FACES ? <Text style={styles.muted}>+{people.length - MAX_FACES}</Text> : null}
          </View>
        </Badged>
        {hovered ? name(hovered) : null}
        {since(earliest)}
      </View>
    </Hint>
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

function Card({ items, actions, group }: { items: Item[]; actions: Actions; group?: WaitingGroup }) {
  return (
    <CardList>
      {items.map((item, index) => (
        <ItemRow key={item.key} item={item} first={index === 0} actions={actions} group={group} />
      ))}
    </CardList>
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
              <Button icon="copy" label={styles.compact ? undefined : "Copy list"} variant="ghost" accessibilityLabel={`Copy what waits on ${who.login}`} onPress={() => nudge(who.login)} />
            ) : null
          }
        />
        <Card items={liftActive(items, actions.agents)} actions={actions} group={group} />
      </View>
    );
  });
}

// Monday-start weeks in the device's time zone.
function weekOf(iso: string): Date {
  const day = new Date(iso);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

function weekLabel(monday: Date): string {
  const weeks = Math.round((weekOf(new Date().toISOString()).getTime() - monday.getTime()) / (7 * 86_400_000));
  if (weeks === 0) return "This week";
  if (weeks === 1) return "Last week";
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const format = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${format(monday)} – ${format(sunday)}`;
}

// What I finished, by week, with reviews tucked away per week [HIS-01, HIS-02].
// A week copies as a list of links to paste into a report, each led by its kind; reviews stay out of it [HIS-03, HIS-04].
function History({ items, actions }: { items: Item[]; actions: Actions }) {
  const styles = useStyles();
  const copy = useCopy();
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return <Text style={styles.text}>Nothing finished in this period.</Text>;
  const weeks = new Map<number, Item[]>();
  for (const item of items) {
    const week = weekOf(item.closedAt!).getTime();
    weeks.set(week, [...(weeks.get(week) ?? []), item]);
  }
  const blocks: ReactNode[] = [];
  for (const [week, all] of [...weeks].sort((a, b) => b[0] - a[0])) {
    const done = all.filter((item) => item.section === "done").sort((a, b) => b.closedAt!.localeCompare(a.closedAt!));
    const reviewed = all.filter((item) => item.section === "reviewed");
    // What was done, each led by its kind; not planned issues stay on screen but out of the report [HIS-03, HIS-04].
    const copied = done.filter((item) => !item.notPlanned);
    const label = weekLabel(new Date(week));
    blocks.push(
      <View key={week} style={{ gap: 8 }}>
        <SectionHeader
          icon="clock"
          title={label}
          count={done.length}
          action={
            copied.length > 0 ? (
              <Button
                icon="copy"
                variant="ghost"
                accessibilityLabel={`Copy links from ${label}`}
                onPress={() =>
                  copy(
                    linkList(copied.map((item) => ({ title: item.title, url: item.url, mark: workEmoji(item) }))),
                    `Copied ${copied.length} link${copied.length === 1 ? "" : "s"} from ${label}`,
                  )
                }
              />
            ) : null
          }
        />
        {done.length > 0 ? <Card items={done} actions={actions} /> : null}
        {reviewed.length > 0 ? (
          <View style={{ gap: 8 }}>
            <View style={styles.wrap}>
              <Toggle label={`Reviewed (${reviewed.length})`} active={open === label} onPress={() => setOpen(open === label ? null : label)} />
            </View>
            {open === label ? <Card items={reviewed} actions={actions} /> : null}
          </View>
        ) : null}
      </View>,
    );
  }
  return blocks;
}

// Stacked or linked PRs as a connected line; collapsed, only those needing attention [ATT-03, ATT-04].
// In the sheet each row opens its PR on GitHub [ATT-12], and the PR an issue's actions apply to is tinted and says so [ATT-06].
function StackLine({ rows, merged, links = false, target }: { rows: SubRow[]; merged: boolean; links?: boolean; target?: string }) {
  const styles = useStyles();
  return (
    <View>
      {rows.map((row, index) => (
        <StackRow key={row.key} url={row.url} number={row.number} link={links} target={row.key === target}>
          <View style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 2, flex: 1, backgroundColor: index === 0 ? "transparent" : styles.c.border }} />
            <TablerIcon name={merged ? "merge" : row.draft ? "draft" : "pr"} size={14} color={merged ? styles.c.statusSuccess : row.draft ? styles.c.foregroundMuted : styles.c.statusSuccess} />
            <View style={{ width: 2, flex: 1, backgroundColor: index === rows.length - 1 ? "transparent" : styles.c.border }} />
          </View>
          <View style={{ flex: 1, paddingVertical: 3, gap: 2 }}>
            <Text style={{ color: styles.c.foreground, fontSize: 13 }} numberOfLines={1}>
              {row.title}
            </Text>
            <View style={[styles.wrap, { columnGap: 10, rowGap: 2 }]}>
              <Meta lead={<NumberText number={row.number} />} facts={[]} chips={row.chips} />
              {row.key === target ? <Text style={{ color: styles.action, fontSize: 12, fontWeight: "600" }}>actions apply here</Text> : null}
            </View>
          </View>
          {links ? (
            <View style={{ justifyContent: "center", paddingHorizontal: 4 }}>
              <TablerIcon name="github" size={14} color={styles.c.foregroundMuted} />
            </View>
          ) : null}
        </StackRow>
      ))}
    </View>
  );
}

function StackRow({ url, number, link, target = false, children }: { url: string; number: number; link: boolean; target?: boolean; children: ReactNode }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const tinted = target ? { backgroundColor: tint(styles.action, 0.1), borderRadius: 6 } : null;
  if (!link) return <View style={[styles.row, { alignItems: "stretch" }, tinted]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open PR #${number} on GitHub`}
      onPress={() => void openExternalUrl(url)}
      {...hover}
      style={({ pressed }) => [styles.row, { alignItems: "stretch", borderRadius: 6, backgroundColor: pressed || hovered ? styles.c.surface2 : target ? tint(styles.action, 0.1) : "transparent" }]}
    >
      {children}
    </Pressable>
  );
}

// Session options in a modal: a bottom sheet on phones [SES-02].
function SessionOptions({ spec, actions, onClose }: { spec: OptionsSpec; actions: Actions; onClose: () => void }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const { itemKey, kind, target } = spec;
  const options = useQuery({
    queryKey: ["attention-span", "options", itemKey, kind],
    queryFn: async () => {
      const [{ context }, profiles, checkout, defaults] = await Promise.all([
        actions.fetchContext({ kind, target }),
        listProfiles(paseo),
        findCheckout(paseo, actions.config, target, actions.defaultBranch),
        // Without a ready provider, still show the options; starting reports the error.
        resolveAgentConfig(paseo, actions.fetchProviders, kind, actions.config).catch(() => ({ label: "No agent provider is ready" })),
      ]);
      const workspaces = checkout.project ? await branchWorkspaces(paseo, checkout.project.projectId, checkoutPr(kind, target).head) : [];
      return { prompt: renderPrompt(kind, target, context, actions.config), profiles, checkout, workspaces, defaultLabel: defaults.label };
    },
    staleTime: 60_000,
  });
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [profileId, setProfileId] = useState<string>();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const data = options.data;

  async function start() {
    if (!data) return;
    setStarting(true);
    try {
      await spec.before?.();
      await actions.started(await startSession(paseo, { itemKey, kind, target, prompt: prompt ?? data.prompt, config: actions.config, fetchProviders: actions.fetchProviders, checkout: data.checkout, profileId, workspaceId }));
      onClose();
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal title={spec.title} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
        {options.isLoading ? <Loading text="Loading context…" /> : null}
        {!options.isLoading && !data ? <Text style={styles.danger}>{(options.error as Error)?.message ?? "No options"}</Text> : null}
        {data && !data.checkout.project ? <Text style={styles.danger}>{noProjectMessage(data.checkout, target)}</Text> : null}
        {data?.checkout.project ? (
          <View style={{ gap: 10 }}>
            <Text style={styles.muted}>Workspace</Text>
            <View style={styles.wrap}>
              <Toggle label="New worktree" active={!workspaceId} onPress={() => setWorkspaceId(undefined)} />
              {data.workspaces.map((w) => (
                <Toggle key={w.id} label={w.name} active={workspaceId === w.id} onPress={() => setWorkspaceId(w.id)} />
              ))}
            </View>
            <Text style={styles.muted}>Agent profile</Text>
            <View style={styles.wrap}>
              <Toggle label={data.defaultLabel} active={!profileId} onPress={() => setProfileId(undefined)} />
              {data.profiles.map((p) => (
                <Toggle key={p.id} label={p.name} active={profileId === p.id} onPress={() => setProfileId(p.id)} />
              ))}
            </View>
            <Text style={styles.muted}>Prompt</Text>
            <TextInput style={[styles.input, { minHeight: 180 }]} value={prompt ?? data.prompt} onChangeText={setPrompt} multiline textAlignVertical="top" />
            <View style={styles.wrap}>
              <Button label={starting ? "Starting…" : "Start session"} icon="agent" variant="solid" disabled={starting} onPress={() => void start()} />
              <Button label="Cancel" onPress={onClose} />
            </View>
          </View>
        ) : null}
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

// Where an issue repo's code lives, picked from my Paseo projects and saved to config.json [SES-07].
function CodeRepoPicker({ issueRepo, missing, onPick, onClose }: { issueRepo: string; missing: string; onPick: (repo: string) => void; onClose: () => void }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const projects = useQuery({ queryKey: ["attention-span", "github-projects"], queryFn: () => githubProjects(paseo) });
  return (
    <Modal title={`Where does the code for ${issueRepo} live?`} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <View style={{ gap: 10 }}>
            <Text style={styles.text}>No Paseo project has {missing} as its GitHub remote. Pick the project that holds the code for issues in {issueRepo}.</Text>
            {projects.isLoading ? <Loading text="Loading projects…" /> : null}
            {projects.data?.length === 0 ? <Text style={styles.danger}>No Paseo project has a GitHub remote. Add the code repository as a project first.</Text> : null}
            <View style={styles.wrap}>
              {projects.data?.map((project) => (
                <Button key={project.projectId} label={project.repo} icon="play" variant="calm" onPress={() => onPick(project.repo)} />
              ))}
            </View>
            <Text style={styles.muted}>Saved to codeRepos in config.json, so the next start goes straight there.</Text>
            <View style={styles.wrap}>
              <Button label="Cancel" onPress={onClose} />
            </View>
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

function issueTarget(issue: NextUpIssue): Target {
  return { kind: "issue", repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, defaultBranch: issue.defaultBranch };
}
