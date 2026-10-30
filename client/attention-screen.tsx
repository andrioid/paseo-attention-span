import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type ActionId, type AgentSummary, type AttentionView, type Chip, type FailingChecks, type Item, type NextUpIssue, type Section, type SectionId, type SubRow, TAB_FEED, type TabId, type Target } from "../shared/attention";
import { type AttentionConfig, nextUpSources, type SessionKind } from "../shared/config";
import { ago, linkList } from "../shared/format";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import { blocks } from "../shared/setup";
import { useAttention } from "./data";
import { CardList, CardRow, type CardProps } from "./card";
import type { IconName } from "./icons";
import { NextUpList } from "./next-up";
import { ActionSheet, DetailLines, type SheetEntry } from "./sheet";
import { branchWorkspaces, findCheckout, githubProjects, itemAgents, listProfiles, noProjectMessage, resolveAgentConfig, startSession } from "./sessions";
import { SetupChecklist } from "./setup";
import { Avatar, Button, KeepStyles, Loading, Meta, SectionHeader, SpinningIcon, StylesProvider, TablerIcon, Toggle, useCopy, useHover, useStyles } from "./ui";

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
  automerge: "clock",
  merge: "merge",
  close: "close",
  start: "agent",
};

function actionLabel(action: ActionId, item: Item): string {
  const stacked = (item.target.stack?.length ?? 0) > 1;
  return {
    reply: "Reply ↗",
    acknowledge: "Acknowledge",
    review: "Review",
    fix: "Fix CI",
    rerun: "Rerun failed jobs",
    address: "Address comments",
    update: "Update branch",
    rebase: stacked ? "Rebase stack" : "Rebase",
    refresh: "Refresh draft",
    ready: "Ready for review",
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
  const stacked = (target.stack?.length ?? 0) > 1;
  const comments = item.person?.comments ?? [];
  return {
    reply: item.person ? `Opens ${item.person.login}'s comment on GitHub` : "Opens it on GitHub",
    acknowledge:
      comments.length === 1 ? `Reacts to ${comments[0].author}'s comment, which clears it` : `Pick which of the ${comments.length} waiting comments to react to`,
    review: "An agent reviews the PR in a checkout and reports back. Nothing is posted",
    fix: "An agent reads the failing logs and commits a fix, without pushing",
    address: "An agent works through the unresolved comments and applies the trivial ones, without pushing",
    update: `GitHub rebases ${pr} onto ${base}`,
    rebase: `An agent rebases ${stacked ? "the stack" : pr} onto ${base}. It pushes only if there were no conflicts`,
    refresh: `An agent rebases the draft onto ${base} and says what it still needs`,
    ready: `Takes ${pr} out of draft, so reviewers are notified`,
    automerge: `GitHub merges ${pr} into ${base} (${target.mergeMethod}) once checks pass`,
    merge: `Merges ${pr} into ${base} (${target.mergeMethod}) now`,
    close: `Closes ${pr}. A comment is posted only if you write one`,
    start: "An agent reads the issue and proposes a plan",
  }[action];
}

// Which checks failed, and whether they were rerun before: flaky or real? [PRS-09]
function rerunEntry(failing: FailingChecks[] | undefined, loading: boolean): { detail: string; runIds: number[] } {
  if (loading) return { detail: "Checking which checks failed…", runIds: [] };
  if (!failing) return { detail: "Couldn't find the failing checks", runIds: [] };
  if (failing.length === 0) return { detail: "No failed checks on the latest commit", runIds: [] };
  const names = failing
    .map((f) => `${failing.length > 1 ? `#${f.pr}: ` : ""}${f.checks.map((check) => `${check.name}${check.rerunnable ? "" : " (not Actions, can't rerun)"}`).join(", ")}`)
    .join(" · ");
  const runs = failing.flatMap((f) => f.runs);
  const reruns = Math.max(0, ...runs.map((run) => run.attempt - 1));
  return { detail: `${names} · ${reruns ? `rerun ${reruns === 1 ? "once" : `${reruns} times`} already` : "not rerun yet"}`, runIds: runs.map((run) => run.id) };
}

// "Continue review" keeps what the session is for [SES-03].
const CONTINUE_LABELS: Record<SessionKind, string> = {
  review: "Continue review",
  fix: "Continue fix",
  address: "Continue comments",
  rebase: "Continue rebase",
  refresh: "Continue refresh",
  start: "Continue",
};

const SECTION_ICONS: Record<SectionId, IconName> = {
  reply: "reply",
  review: "review",
  ci: "ci",
  changes: "changes",
  ready: "merge",
  upstream: "branch",
  too_long: "hourglass",
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

// A start held back until I say where the issue's code lives [SES-07].
interface Placing {
  itemKey: string;
  kind: SessionKind;
  target: Target;
  missing: string;
  before?: () => Promise<unknown>;
}

// Something I just did, offered for undo until the tab changes [ATT-08, ATT-14].
interface Undoable {
  id: number;
  text: string;
  dismissal?: boolean;
  undo: () => Promise<unknown>;
}

// A session started from the item, as a signal [ATT-07].
function agentSignal(agent: AgentSummary): Chip {
  if (agent.requiresAttention) return { text: "agent needs you", tone: "warn" };
  if (agent.status === "running" || agent.status === "initializing") return { text: "agent working", tone: "good" };
  if (agent.status === "error") return { text: "agent failed", tone: "bad" };
  return { text: "agent idle", tone: "neutral" };
}

// `openSettings` opens the orgs and repos settings [SRC-02].
export function AttentionScreen({ theme, layout, navigation, openSettings }: PluginScreenProps & { openSettings?: () => void }) {
  return (
    <StylesProvider theme={theme} compact={layout.compact}>
      <AttentionList navigation={navigation} openSettings={openSettings} />
    </StylesProvider>
  );
}

function AttentionList({ navigation, openSettings }: Pick<PluginScreenProps, "navigation"> & { openSettings?: () => void }) {
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
  const rerunFailed = useRpc(rpc.rerunFailed);
  const fetchDetails = useRpc(rpc.itemDetails);
  const setCodeRepo = useRpc(rpc.setCodeRepo);
  const fetchDefaultBranch = useRpc(rpc.defaultBranch);
  const defaultBranch: DefaultBranch = async (repo) => (await fetchDefaultBranch({ repo })).name;
  const [tab, setTab] = useState<TabId>("doing");
  // Every card with a change still running: each runs on its own.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<Undoable[]>([]);
  const [placing, setPlacing] = useState<Placing | null>(null);
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

  // One tap: continue the item's session, or start one with defaults [SES-01, SES-03].
  async function startWithDefaults(itemKey: string, kind: SessionKind, target: Target, before?: () => Promise<unknown>) {
    const existing = (view?.fixtureAgents ?? agents.data)?.[itemKey];
    if (existing) return openAgent(existing.id);
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
    await started(await startSession(paseo, { itemKey, kind, target, prompt, config, checkout }));
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
  const refreshing = feed.refreshing || attention.isFetching;
  const tooLong = view.doing.find((section) => section.id === "too_long")?.items.length ?? 0;
  const counts: Record<TabId, number> = {
    history: view.history.filter((item) => item.section === "done").length,
    doing: view.count,
    waiting: view.waiting.reduce((sum, section) => sum + section.items.length, 0),
    next: view.assigned.length + view.unclaimed.length,
  };

  const actions: Actions = {
    agents: view.fixtureAgents ?? agents.data ?? {},
    busy,
    config: view.config,
    fetchContext,
    fetchDetails,
    defaultBranch,
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
    rerun: (item, runIds) => change(item.key, "Rerun", () => rerunFailed({ key: item.key, repo: item.target.repo, runIds }), `Rerunning the failed jobs of PR ${item.target.number}`),
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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
            accessibilityState={{ busy: refreshing }}
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
          <Sections sections={view.doing} actions={actions} empty="Nothing needs you right now." />
          {view.dismissedCount > undoable.filter((row) => row.dismissal).length ? (
            <Pressable accessibilityRole="button" onPress={() => void run("restore", "Restore", async () => (attention.setView(await restore({})), setUndoable([])))}>
              <Text style={styles.muted}>{view.dismissedCount} dismissed · show them again</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "waiting" ? (
        <>
          <Sections sections={view.waiting} actions={actions} empty="Nothing is waiting on others." />
          {tooLong > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => switchTab("doing")}>
              <Text style={styles.muted}>{tooLong} more waited too long and moved to Doing →</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "next" ? (
        <NextUpList
          assigned={view.assigned}
          unclaimed={view.unclaimed}
          unclaimedFrom={view.unclaimedFrom}
          selected={view.scopes}
          onSelect={(scopes) => {
            attention.setView({ ...view, scopes });
            saveScopes({ scopes }).catch((error) => toast.error(`Saving the filter failed: ${(error as Error).message}`));
          }}
          sources={nextUpSources(view.config)}
          selectedSources={view.sources}
          onSelectSources={(sources) => {
            attention.setView({ ...view, sources });
            saveSources({ sources }).catch((error) => toast.error(`Saving the filter failed: ${(error as Error).message}`));
          }}
          agents={actions.agents}
          busy={busy}
          fetchDetails={fetchDetails}
          onOpenAgent={openAgent}
          onStart={(issue, claimFirst) => {
            const target = issueTarget(issue);
            void startWithDefaults(issue.key, "start", target, claimFirst ? async () => attention.setView(await claim({ key: issue.key, target })) : undefined);
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
      {placing ? <CodeRepoPicker issueRepo={placing.target.repo} missing={placing.missing} onPick={place} onClose={() => setPlacing(null)} /> : null}
    </ScrollView>
  );
}

function Tab({ icon, label, count, active, onPress }: { icon: IconName; label: string; count: number; active: boolean; onPress: () => void }) {
  const styles = useStyles();
  const color = active ? styles.c.foreground : styles.c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.row, { gap: 6, paddingVertical: 7, paddingHorizontal: styles.compact ? 9 : 12, borderRadius: 9, backgroundColor: active ? styles.c.surface2 : "transparent" }]}
    >
      <TablerIcon name={icon} size={16} color={color} />
      {/* On phones only the active tab is labelled, so four tabs fit. */}
      {active || !styles.compact ? <Text style={{ color, fontSize: 14, fontWeight: active ? "600" : "400" }}>{label}</Text> : null}
      <Text style={[styles.muted, { fontSize: 12 }]}>{count}</Text>
    </Pressable>
  );
}

interface Actions {
  agents: Record<string, AgentSummary>;
  busy: ReadonlySet<string>;
  config: AttentionConfig;
  fetchContext: FetchContext;
  fetchDetails: FetchDetails;
  defaultBranch: DefaultBranch;
  act: (item: Item, action: ActionId) => void;
  rerun: (item: Item, runIds: number[]) => void;
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

// A card that works collapsed: its main action and ⋯. Tapping it opens the sheet with everything else [ATT-05, ATT-06].
const isRed = (chips: Chip[]) => chips.some((chip) => chip.tone === "bad");

type Sheet = "item" | "acknowledge" | { options: SessionKind } | null;

function ItemRow({ item, first, actions }: { item: Item; first: boolean; actions: Actions }) {
  const agent = actions.agents[item.key];
  const chips = agent ? [...item.chips, agentSignal(agent)] : item.chips;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const sessionAction = item.actions.find((action) => ACTION_SESSION[action]);
  const sessionKind = sessionAction ? ACTION_SESSION[sessionAction] : undefined;
  const main = item.actions[0];
  // The full stack is in the sheet; the card shows the PRs that need attention [ATT-04].
  const children = item.children.filter((child) => child.attention || isRed(child.chips));
  const open = () => setSheet("item");
  const copy = useCopy();
  const history = item.section === "done" || item.section === "reviewed";

  function perform(action: ActionId) {
    setSheet(null);
    if (action === "merge" || action === "close") setConfirm(action);
    else if (action === "acknowledge") setSheet("acknowledge");
    else actions.act(item, action);
  }
  const handlers: SheetHandlers = { onPerform: perform, onOptions: (kind) => setSheet({ options: kind }), onClose: () => setSheet(null) };
  // A menu with one action is a wasted tap: show that action instead of ⋯. The card still opens the sheet [ATT-06].
  const entries = sheetEntries(item, agent, actions, handlers);
  const only = entries.length === 1 ? entries[0] : undefined;
  const confirmed = (action: "merge" | "close") => (comment: string) => (setConfirm(null), actions.confirm(item, action, comment));

  return (
    <CardRow
      first={first}
      mark={stateMark(item)}
      title={item.title}
      meta={{
        place: `${item.repo.split("/")[1]} #${item.number}`,
        when: item.closedAt ? `${item.kind === "pr" ? "merged" : "closed"} ${ago(item.closedAt)} ago` : undefined,
        signals: chips,
      }}
      extra={
        item.person || children.length > 0 ? (
          <>
            {item.person ? <PersonQuote person={item.person} expanded={false} /> : null}
            {children.length > 0 ? <StackLine rows={children} merged={!!item.closedAt} /> : null}
          </>
        ) : null
      }
      onOpen={open}
      busy={actions.busy.has(item.key)}
      primary={
        agent && sessionKind
          ? { label: CONTINUE_LABELS[sessionKind], icon: "agent", onPress: () => actions.openAgent(agent.id) }
          : main
            ? { label: actionLabel(main, item), icon: ACTION_ICONS[main], onPress: () => perform(main) }
            : undefined
      }
      secondary={[
        only ? { label: only.label, icon: only.icon, onPress: only.onPress } : { label: "More actions", icon: "dots", onPress: open },
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
          {sheet === "item" ? <ItemSheet item={item} agent={agent} actions={actions} {...handlers} /> : null}
          {sheet === "acknowledge" ? <AcknowledgeSheet item={item} onReact={(ids) => (setSheet(null), actions.acknowledge(item, ids))} onClose={() => setSheet(null)} /> : null}
          {sheet && typeof sheet === "object" ? <SessionOptions item={item} kind={sheet.options} actions={actions} onClose={() => setSheet(null)} /> : null}
        </>
      }
    />
  );
}

interface SheetHandlers {
  onPerform: (action: ActionId) => void;
  onOptions: (kind: SessionKind) => void;
  onClose: () => void;
}

// What the card already knows on top, then every action, then what's fetched when it opens, so nothing jumps as it loads [ATT-06, GH-01].
function ItemSheet({ item, agent, actions, ...handlers }: { item: Item; agent?: AgentSummary; actions: Actions } & SheetHandlers) {
  const checks = item.actions.includes("rerun");
  const details = useQuery({
    queryKey: ["attention-span", "details", item.key, checks],
    queryFn: () => actions.fetchDetails({ subject: { kind: item.kind, repo: item.repo, number: item.number }, target: item.target, checks }),
    staleTime: 60_000,
  });
  const meta = [`${item.repo}#${item.number}`, ...(item.target.number !== item.number ? [`actions apply to PR #${item.target.number}`] : [])];
  // PRs already in the stack line link from there; list only the rest, like someone else's PR closing the same issue.
  const shown = new Set(item.children.map((child) => child.url));
  const extra = details.data && { ...details.data, linked: details.data.linked.filter((link) => !shown.has(link.url)) };
  return (
    <ActionSheet
      title={item.title}
      onClose={handlers.onClose}
      top={
        <>
          <Meta facts={meta} chips={item.chips} />
          {item.person ? <PersonQuote person={item.person} expanded /> : null}
          {item.children.length > 0 ? <StackLine rows={item.children} merged={!!item.closedAt} links /> : null}
        </>
      }
      entries={sheetEntries(item, agent, actions, handlers, details)}
      bottom={<DetailLines details={extra} loading={details.isLoading} error={details.error} linkedLabel={item.kind === "issue" ? "PR" : "Closes"} />}
    />
  );
}

// Everything an item's sheet offers, each saying what it will do [ATT-06]. Rerun's line needs the fetched checks.
function sheetEntries(
  item: Item,
  agent: AgentSummary | undefined,
  actions: Actions,
  { onPerform, onOptions, onClose }: SheetHandlers,
  details?: { data?: { failing: FailingChecks[] }; isLoading: boolean },
): SheetEntry[] {
  const inDoing = !item.section.startsWith("wait_") && item.section !== "done" && item.section !== "reviewed";
  const close = (then: () => void) => () => (onClose(), then());

  const entries: SheetEntry[] = [];
  let continued = false;
  for (const action of item.actions) {
    const kind = ACTION_SESSION[action];
    const label = actionLabel(action, item);
    if (kind && agent) {
      // One session per item: continue it instead of starting another [SES-03].
      if (!continued) entries.push({ key: action, icon: "agent", label: CONTINUE_LABELS[kind], detail: `Opens the session (${agentSignal(agent).text})`, onPress: close(() => actions.openAgent(agent.id)) });
      continued = true;
    } else if (kind) {
      entries.push({ key: action, icon: "agent", label, detail: actionDetail(action as Exclude<ActionId, "rerun">, item), onPress: () => onPerform(action) });
      entries.push({ key: `${action}-options`, icon: "agent", label: `${label} with options…`, detail: "Choose the workspace, agent profile and prompt first", onPress: () => onOptions(kind) });
    } else if (action === "rerun") {
      const { detail, runIds } = rerunEntry(details?.data?.failing, details?.isLoading ?? true);
      entries.push({ key: action, icon: ACTION_ICONS.rerun, label, detail, disabled: runIds.length === 0, onPress: close(() => actions.rerun(item, runIds)) });
    } else {
      entries.push({ key: action, icon: ACTION_ICONS[action], label, detail: actionDetail(action, item), onPress: () => onPerform(action) });
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
  if (inDoing) entries.push({ key: "dismiss", icon: "dismiss", label: "Dismiss", detail: "Hides it until something new happens on it", onPress: close(() => actions.dismiss(item)) });
  return entries;
}

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

// Who is waiting on me, or who I'm waiting on.
function PersonQuote({ person, expanded }: { person: NonNullable<Item["person"]>; expanded: boolean }) {
  const styles = useStyles();
  const line = (
    <View style={styles.row}>
      <Avatar url={person.avatarUrl} bot={person.bot} />
      <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600" }}>{person.login}</Text>
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

function Sections({ sections, actions, empty }: { sections: Section[]; actions: Actions; empty: string }) {
  const styles = useStyles();
  if (sections.length === 0) return <Text style={styles.text}>{empty}</Text>;
  return sections.map((section) => (
    <View key={section.id}>
      <SectionHeader icon={SECTION_ICONS[section.id]} title={section.title} count={section.items.length} />
      <Card items={section.items} actions={actions} />
    </View>
  ));
}

function Card({ items, actions }: { items: Item[]; actions: Actions }) {
  return (
    <CardList>
      {items.map((item, index) => (
        <ItemRow key={item.key} item={item} first={index === 0} actions={actions} />
      ))}
    </CardList>
  );
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
// A week copies as a list of links to paste into a report; reviews stay out of it [HIS-03].
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
    const label = weekLabel(new Date(week));
    blocks.push(
      <View key={week} style={{ gap: 8 }}>
        <SectionHeader
          icon="clock"
          title={label}
          count={done.length}
          action={
            done.length > 0 ? (
              <Button
                icon="copy"
                variant="ghost"
                accessibilityLabel={`Copy links from ${label}`}
                onPress={() => copy(linkList(done), `Copied ${done.length} link${done.length === 1 ? "" : "s"} from ${label}`)}
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
// In the sheet each row opens its PR on GitHub [ATT-12].
function StackLine({ rows, merged, links = false }: { rows: SubRow[]; merged: boolean; links?: boolean }) {
  const styles = useStyles();
  return (
    <View>
      {rows.map((row, index) => (
        <StackRow key={row.key} url={row.url} number={row.number} link={links}>
          <View style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 2, flex: 1, backgroundColor: index === 0 ? "transparent" : styles.c.border }} />
            <TablerIcon name={merged ? "merge" : row.draft ? "draft" : "pr"} size={14} color={merged ? styles.c.statusSuccess : row.draft ? styles.c.foregroundMuted : styles.c.statusSuccess} />
            <View style={{ width: 2, flex: 1, backgroundColor: index === rows.length - 1 ? "transparent" : styles.c.border }} />
          </View>
          <View style={{ flex: 1, paddingVertical: 3, gap: 2 }}>
            <Text style={{ color: styles.c.foreground, fontSize: 13 }} numberOfLines={1}>
              {row.title}
            </Text>
            <Meta facts={[`#${row.number}`]} chips={row.chips} />
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

function StackRow({ url, number, link, children }: { url: string; number: number; link: boolean; children: ReactNode }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  if (!link) return <View style={[styles.row, { alignItems: "stretch" }]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open PR #${number} on GitHub`}
      onPress={() => void openExternalUrl(url)}
      {...hover}
      style={({ pressed }) => [styles.row, { alignItems: "stretch", borderRadius: 6, backgroundColor: pressed || hovered ? styles.c.surface2 : "transparent" }]}
    >
      {children}
    </Pressable>
  );
}

// Session options in a modal: a bottom sheet on phones [SES-02].
function SessionOptions({ item, kind, actions, onClose }: { item: Item; kind: SessionKind; actions: Actions; onClose: () => void }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const { target } = item;
  const options = useQuery({
    queryKey: ["attention-span", "options", item.key, kind],
    queryFn: async () => {
      const [{ context }, profiles, checkout, defaults] = await Promise.all([
        actions.fetchContext({ kind, target }),
        listProfiles(paseo),
        findCheckout(paseo, actions.config, target, actions.defaultBranch),
        // Without a ready provider, still show the options; starting reports the error.
        resolveAgentConfig(paseo, kind, actions.config).catch(() => ({ label: "No agent provider is ready" })),
      ]);
      const workspaces = checkout.project ? await branchWorkspaces(paseo, checkout.project.projectId, target.headRefName) : [];
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
      await actions.started(await startSession(paseo, { itemKey: item.key, kind, target, prompt: prompt ?? data.prompt, config: actions.config, checkout: data.checkout, profileId, workspaceId }));
      onClose();
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal title={`${actionLabel(item.actions.find((a) => ACTION_SESSION[a] === kind) ?? "start", item)}: ${item.title}`} open onOpenChange={(open) => (open ? null : onClose())}>
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
