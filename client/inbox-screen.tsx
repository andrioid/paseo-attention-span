import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { InboxConfig, SessionKind } from "../shared/config";
import { ago } from "../shared/format";
import type { ActionId, AgentSummary, Item, NextUpIssue, Section, SectionId, SubRow, TabId, Target } from "../shared/inbox";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import { useInbox } from "./data";
import type { IconName } from "./icons";
import { NextUpList } from "./next-up";
import { branchWorkspaces, findProject, inboxAgents, listProfiles, resolveAgentConfig, startSession } from "./sessions";
import { Avatar, Button, Chip, SectionHeader, StylesProvider, TablerIcon, Toggle, useStyles } from "./ui";

const ACTIONS: Record<ActionId, { label: string; icon: IconName }> = {
  reply: { label: "Reply", icon: "replyArrow" },
  review: { label: "Review", icon: "review" },
  fix: { label: "Fix", icon: "fix" },
  address: { label: "Address", icon: "address" },
  update: { label: "Update", icon: "update" },
  rebase: { label: "Rebase", icon: "branch" },
  refresh: { label: "Refresh", icon: "rotate" },
  merge: { label: "Merge", icon: "merge" },
  close: { label: "Close", icon: "close" },
  start: { label: "Start", icon: "play" },
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
  { id: "doing", label: "Doing", icon: "inbox" },
  { id: "waiting", label: "Waiting", icon: "hourglass" },
  { id: "next", label: "Next up", icon: "nextUp" },
];

const AGENTS_QUERY_KEY = ["github-attention", "agents"] as const;
type FetchContext = (input: RpcInput<typeof rpc.sessionContext>) => Promise<RpcOutput<typeof rpc.sessionContext>>;

function agentTag(agent: AgentSummary): { text: string; tone: "good" | "bad" | "warn" | "neutral" } {
  if (agent.requiresAttention) return { text: "agent needs you", tone: "warn" };
  if (agent.status === "running" || agent.status === "initializing") return { text: "agent working", tone: "good" };
  if (agent.status === "error") return { text: "agent failed", tone: "bad" };
  return { text: "agent idle", tone: "neutral" };
}

export function InboxScreen({ theme, layout, navigation }: PluginScreenProps) {
  return (
    <StylesProvider theme={theme} compact={layout.compact}>
      <Inbox navigation={navigation} />
    </StylesProvider>
  );
}

function Inbox({ navigation }: Pick<PluginScreenProps, "navigation">) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const inbox = useInbox();
  const agents = useQuery({ queryKey: AGENTS_QUERY_KEY, queryFn: () => inboxAgents(paseo), refetchInterval: 15_000 });
  const fetchContext = useRpc(rpc.sessionContext);
  const dismiss = useRpc(rpc.dismissItem);
  const restore = useRpc(rpc.restoreDismissed);
  const update = useRpc(rpc.updateBranch);
  const merge = useRpc(rpc.mergePullRequest);
  const close = useRpc(rpc.closePullRequest);
  const claim = useRpc(rpc.claimIssue);
  const [tab, setTab] = useState<TabId>("doing");
  const [busy, setBusy] = useState<string | null>(null);
  const view = inbox.data;

  async function run(key: string, label: string, work: () => Promise<unknown>) {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      toast.error(`${label} failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
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
    await run(itemKey, "Starting the session", async () => {
      await before?.();
      const { context } = await fetchContext({ kind, target });
      const prompt = renderPrompt(kind, target, context, view.config);
      await started(await startSession(paseo, { itemKey, kind, target, prompt, config: view.config }));
    });
  }

  if (!view) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={inbox.error ? styles.danger : styles.muted}>{inbox.error ? `Couldn't load the inbox: ${(inbox.error as Error).message}` : "Loading…"}</Text>
      </View>
    );
  }

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
    openAgent,
    started,
    act: (item, action) => {
      const session = ACTION_SESSION[action];
      if (action === "reply") return void openExternalUrl(item.person?.url ?? item.url);
      if (session) return void startWithDefaults(item.key, session, item.target);
      if (action === "update")
        void run(item.key, "Update", async () => {
          await update({ target: item.target });
          toast.show(`Updating PR ${item.target.number} with ${item.target.baseRefName}`, { variant: "success" });
        });
    },
    confirm: (item, action, comment) =>
      void run(item.key, action === "merge" ? "Merge" : "Close", async () => {
        if (action === "merge") await merge({ target: item.target });
        else await close({ target: item.target, comment });
        toast.show(`PR ${item.target.number} ${action === "merge" ? "merged" : "closed"}`, { variant: "success" });
        await inbox.refreshNow();
      }),
    dismiss: (item) => void run(item.key, "Dismiss", async () => inbox.setView(await dismiss({ key: item.key }))),
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={styles.row}>
          {TABS.map(({ id, label, icon }) => (
            <Tab key={id} icon={icon} label={label} count={counts[id]} active={tab === id} onPress={() => setTab(id)} />
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh now" style={styles.row} onPress={() => void inbox.refreshNow().catch(() => {})}>
          <TablerIcon name="update" size={14} />
          <Text style={styles.muted}>{view.refreshing || inbox.isFetching ? "refreshing…" : view.fetchedAt ? `${ago(view.fetchedAt)} ago` : "never"}</Text>
        </Pressable>
      </View>
      {view.error ? <Text style={styles.danger}>{view.error}</Text> : null}

      {tab === "history" ? <History items={view.history} actions={actions} /> : null}
      {tab === "doing" ? (
        <>
          <Sections sections={view.doing} actions={actions} empty="Nothing needs you right now." />
          {view.dismissedCount > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => void run("restore", "Restore", async () => inbox.setView(await restore({})))}>
              <Text style={styles.muted}>{view.dismissedCount} dismissed · show them again</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "waiting" ? (
        <>
          <Sections sections={view.waiting} actions={actions} empty="Nothing is waiting on others." />
          {tooLong > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => setTab("doing")}>
              <Text style={styles.muted}>{tooLong} more waited too long and moved to Doing →</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {tab === "next" ? (
        <NextUpList
          assigned={view.assigned}
          unclaimed={view.unclaimed}
          config={view.config}
          agents={actions.agents}
          busy={busy}
          onOpenAgent={openAgent}
          onStart={(issue, claimFirst) => {
            const target = issueTarget(issue);
            void startWithDefaults(issue.key, "start", target, claimFirst ? () => claim({ target }) : undefined);
          }}
        />
      ) : null}
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
      <View style={styles.badge}>
        <Text style={[styles.muted, { fontSize: 11 }]}>{count}</Text>
      </View>
    </Pressable>
  );
}

interface Actions {
  agents: Record<string, AgentSummary>;
  busy: string | null;
  config: InboxConfig;
  fetchContext: FetchContext;
  act: (item: Item, action: ActionId) => void;
  confirm: (item: Item, action: "merge" | "close", comment?: string) => void;
  dismiss: (item: Item) => void;
  openAgent: (agentId: string) => void;
  started: (agentId: string) => Promise<void>;
}

function ItemRow({ item, first, actions }: { item: Item; first: boolean; actions: Actions }) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const [comment, setComment] = useState("");
  const agent = actions.agents[item.key];
  const sessionAction = item.actions.find((action) => ACTION_SESSION[action]);
  const tag = agent ? agentTag(agent) : null;

  const buttons =
    actions.busy === item.key ? (
      <Text style={styles.muted}>working…</Text>
    ) : agent && sessionAction ? (
      <Button label="Continue" icon="play" primary onPress={() => actions.openAgent(agent.id)} />
    ) : (
      item.actions.map((action, index) => (
        <Button
          key={action}
          label={ACTIONS[action].label}
          icon={ACTIONS[action].icon}
          primary={index === 0}
          onPress={() => (action === "merge" || action === "close" ? setConfirm(action) : actions.act(item, action))}
        />
      ))
    );

  return (
    <View style={first ? null : styles.divider}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${expanded ? "collapse" : "expand"}`} onPress={() => setExpanded(!expanded)}>
        <View style={styles.item}>
          <View style={{ paddingTop: 2 }}>
            <TablerIcon {...stateIcon(item, styles.c)} size={18} />
          </View>
          <View style={styles.body}>
            <Text style={styles.title} numberOfLines={expanded ? undefined : 1}>
              {item.title}
            </Text>
            <View style={styles.wrap}>
              <Text style={styles.muted}>#{item.number}</Text>
              {item.chips.map((chip) => (
                <Chip key={chip.text} {...chip} />
              ))}
              {tag ? <Chip {...tag} /> : null}
            </View>
            {item.person ? <PersonQuote person={item.person} expanded={expanded} /> : null}
            {item.children.length > 0 ? <StackLine rows={item.children} merged={!!item.closedAt} /> : null}
            {styles.compact ? <View style={styles.wrap}>{buttons}</View> : null}
          </View>
          {styles.compact ? null : <View style={styles.wrap}>{buttons}</View>}
        </View>
      </Pressable>
      {confirm || expanded ? (
        <View style={{ paddingHorizontal: styles.compact ? 12 : 42, paddingBottom: 14 }}>
          {confirm ? (
            <View style={styles.panel}>
              <Text style={styles.text}>
                {confirm === "merge"
                  ? `Merge PR ${item.target.number} into ${item.target.baseRefName} (${item.target.mergeMethod})?`
                  : `Close PR ${item.target.number}? A comment is only posted if you write one.`}
              </Text>
              {confirm === "close" ? (
                <TextInput style={styles.input} placeholder="Closing comment (optional)" placeholderTextColor={styles.c.foregroundMuted} value={comment} onChangeText={setComment} multiline />
              ) : null}
              <View style={styles.wrap}>
                <Button label={confirm === "merge" ? "Merge" : "Close PR"} icon={confirm} primary onPress={() => (setConfirm(null), actions.confirm(item, confirm, comment))} />
                <Button label="Cancel" onPress={() => setConfirm(null)} />
              </View>
            </View>
          ) : (
            <ItemDetails item={item} actions={actions} sessionKind={sessionAction ? ACTION_SESSION[sessionAction] : undefined} />
          )}
        </View>
      ) : null}
    </View>
  );
}

function stateIcon(item: Item, c: ReturnType<typeof useStyles>["c"]): { name: IconName; color: string } {
  if (item.closedAt) return item.kind === "pr" ? { name: "merge", color: c.accent } : { name: "issueClosed", color: item.chips.length ? c.foregroundMuted : c.accent };
  if (item.kind === "issue") return { name: "issue", color: c.statusSuccess };
  return item.draft ? { name: "draft", color: c.foregroundMuted } : { name: "pr", color: c.statusSuccess };
}

// Who is waiting on me, or who I'm waiting on.
function PersonQuote({ person, expanded }: { person: NonNullable<Item["person"]>; expanded: boolean }) {
  const styles = useStyles();
  const line = (
    <View style={styles.row}>
      <Avatar url={person.avatarUrl} bot={person.bot} />
      <Text style={[styles.muted, { color: styles.c.foreground }]}>{person.login}</Text>
      <Text style={styles.muted}>· {ago(person.since)}</Text>
    </View>
  );
  if (!person.snippet) return line;
  return (
    <View style={styles.quote}>
      {line}
      <Text style={styles.muted} numberOfLines={expanded ? undefined : 2}>
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
  const styles = useStyles();
  return (
    <View style={styles.card}>
      {items.map((item, index) => (
        <ItemRow key={item.key} item={item} first={index === 0} actions={actions} />
      ))}
    </View>
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
function History({ items, actions }: { items: Item[]; actions: Actions }) {
  const styles = useStyles();
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
        <SectionHeader icon="clock" title={label} count={done.length} />
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

// Stacked or linked PRs as a connected line [ATT-03, ATT-04].
function StackLine({ rows, merged }: { rows: SubRow[]; merged: boolean }) {
  const styles = useStyles();
  return (
    <View>
      {rows.map((row, index) => (
        <View key={row.key} style={[styles.row, { alignItems: "stretch" }]}>
          <View style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 2, flex: 1, backgroundColor: index === 0 ? "transparent" : styles.c.border }} />
            <TablerIcon name={merged ? "merge" : row.draft ? "draft" : "pr"} size={14} color={merged ? styles.c.accent : row.draft ? styles.c.foregroundMuted : styles.c.statusSuccess} />
            <View style={{ width: 2, flex: 1, backgroundColor: index === rows.length - 1 ? "transparent" : styles.c.border }} />
          </View>
          <View style={[styles.wrap, { flex: 1, paddingVertical: 3 }]}>
            <Text style={styles.muted}>#{row.number}</Text>
            <Text style={[styles.muted, { color: styles.c.foreground, flexShrink: 1 }]} numberOfLines={1}>
              {row.title}
            </Text>
            {row.chips.map((chip) => (
              <Chip key={chip.text} {...chip} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

// Expanded row: Dismiss, GitHub, and session options [ATT-06, SES-02].
function ItemDetails({ item, actions, sessionKind }: { item: Item; actions: Actions; sessionKind: SessionKind | undefined }) {
  const styles = useStyles();
  const [showOptions, setShowOptions] = useState(false);
  return (
    <View style={styles.panel}>
      <Text style={styles.muted}>
        {item.repo}
        {item.target.number !== item.number ? ` · actions apply to PR #${item.target.number}` : ""}
      </Text>
      <View style={styles.wrap}>
        <Button label="Dismiss" icon="dismiss" onPress={() => actions.dismiss(item)} />
        {/* Anything the inbox doesn't cover [ATT-12]. */}
        <Button label="GitHub" icon="github" onPress={() => void openExternalUrl(item.url)} />
        {sessionKind ? <Button label="Options" icon={showOptions ? "chevronUp" : "chevronDown"} onPress={() => setShowOptions(!showOptions)} /> : null}
      </View>
      {showOptions && sessionKind ? <SessionOptions item={item} kind={sessionKind} actions={actions} /> : null}
    </View>
  );
}

function SessionOptions({ item, kind, actions }: { item: Item; kind: SessionKind; actions: Actions }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const { target } = item;
  const options = useQuery({
    queryKey: ["github-attention", "options", item.key, kind],
    queryFn: async () => {
      const [{ context }, profiles, project, defaults] = await Promise.all([
        actions.fetchContext({ kind, target }),
        listProfiles(paseo),
        findProject(paseo, target.repo),
        // Without a ready provider, still show the options; starting reports the error.
        resolveAgentConfig(paseo, kind, actions.config).catch(() => ({ label: "No agent provider is ready" })),
      ]);
      const workspaces = project ? await branchWorkspaces(paseo, project.projectId, target.headRefName) : [];
      return { prompt: renderPrompt(kind, target, context, actions.config), profiles, project, workspaces, defaultLabel: defaults.label };
    },
    staleTime: 60_000,
  });
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [profileId, setProfileId] = useState<string>();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (options.isLoading) return <Text style={styles.muted}>Loading context…</Text>;
  if (!options.data) return <Text style={styles.danger}>{(options.error as Error)?.message ?? "No options"}</Text>;
  const data = options.data;
  if (!data.project) return <Text style={styles.danger}>No Paseo project has {target.repo} as its remote. Add it as a project to start sessions.</Text>;

  async function start() {
    setStarting(true);
    try {
      await actions.started(await startSession(paseo, { itemKey: item.key, kind, target, prompt: prompt ?? data.prompt, config: actions.config, profileId, workspaceId }));
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
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
      <TextInput style={[styles.input, { minHeight: 140 }]} value={prompt ?? data.prompt} onChangeText={setPrompt} multiline textAlignVertical="top" />
      <View style={styles.wrap}>
        <Button label={starting ? "Starting…" : "Start session"} icon="play" primary disabled={starting} onPress={() => void start()} />
      </View>
    </View>
  );
}

function issueTarget(issue: NextUpIssue): Target {
  return { kind: "issue", repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, defaultBranch: issue.defaultBranch };
}
