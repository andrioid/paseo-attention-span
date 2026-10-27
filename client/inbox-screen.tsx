import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { InboxConfig, SessionKind } from "../shared/config";
import { ago } from "../shared/format";
import type { ActionId, FooterEntry, InboxView, Item, Target } from "../shared/inbox";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import { useInbox } from "./data";
import {
  type AgentSummary,
  branchWorkspaces,
  findProject,
  inboxAgents,
  listProfiles,
  resolveAgentConfig,
  startSession,
} from "./sessions";

type Theme = PluginScreenProps["theme"];
type Styles = ReturnType<typeof makeStyles>;

const ACTION_LABELS: Record<ActionId, string> = {
  reply: "Reply ↗",
  review: "Review ▸",
  fix: "Fix ▸",
  address: "Address ▸",
  update: "Update ▸",
  rebase: "Rebase ▸",
  refresh: "Refresh ▸",
  merge: "Merge ▸",
  close: "Close ▸",
  start: "Start ▸",
};

const AGENTS_QUERY_KEY = ["github-inbox", "agents"] as const;

// React Native primitives and theme colors only, so it works on phone and desktop [REACH-01].
function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 12 : 20, gap: compact ? 14 : 18, paddingBottom: 40 },
    topBar: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 12 },
    muted: { color: c.foregroundMuted, fontSize: 13 },
    danger: { color: c.statusDanger, fontSize: 13 },
    text: { color: c.foreground, fontSize: 14 },
    sectionTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const, letterSpacing: 0.6, marginBottom: 4 },
    card: { backgroundColor: c.surface1, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    row: { paddingVertical: compact ? 10 : 12, paddingHorizontal: compact ? 10 : 14, gap: 4 },
    rowDivider: { borderTopWidth: 1, borderTopColor: c.border },
    rowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
    number: { color: c.foregroundMuted, fontSize: 13, minWidth: compact ? 58 : 72, fontVariant: ["tabular-nums" as const] },
    title: { color: c.foreground, fontSize: 14, flex: 1 },
    detail: { color: c.foregroundMuted, fontSize: 13, marginLeft: compact ? 68 : 82 },
    child: { color: c.foregroundMuted, fontSize: 13, marginLeft: compact ? 12 : 18 },
    actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
    button: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.surface2 },
    buttonText: { color: c.foreground, fontSize: 13 },
    primary: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.accent },
    primaryText: { color: c.accentForeground, fontSize: 13 },
    details: { marginLeft: compact ? 0 : 82, marginTop: 6, gap: 8, padding: 10, borderRadius: 8, backgroundColor: c.surface2 },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, borderColor: c.border },
    chipActive: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, borderColor: c.accent, backgroundColor: c.accent },
    chipText: { color: c.foreground, fontSize: 12 },
    chipActiveText: { color: c.accentForeground, fontSize: 12 },
    input: {
      color: c.foreground,
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 8,
      fontSize: 13,
      minHeight: 40,
    },
    footer: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: compact ? 10 : 18 },
    agentTag: { color: c.statusWarning, fontSize: 12 },
  };
}

function Button({ label, onPress, styles, primary, disabled }: { label: string; onPress: () => void; styles: Styles; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label.replace(/[▸↗▾]/g, "").trim()}
      disabled={disabled}
      onPress={onPress}
      style={[primary ? styles.primary : styles.button, disabled ? { opacity: 0.5 } : null]}
    >
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function agentTag(agent: AgentSummary | undefined): string | null {
  if (!agent) return null;
  if (agent.requiresAttention) return "● agent needs you";
  if (agent.status === "running" || agent.status === "initializing") return "● agent working";
  if (agent.status === "error") return "● agent failed";
  return "● agent idle";
}

export function InboxScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const inbox = useInbox({ onOpenMaxAgeSeconds: 60 }); // refresh when the screen opens
  const agents = useQuery({ queryKey: AGENTS_QUERY_KEY, queryFn: () => inboxAgents(paseo), refetchInterval: 15_000 });
  const dismiss = useRpc(rpc.dismissItem);
  const restore = useRpc(rpc.restoreDismissed);
  const update = useRpc(rpc.updateBranch);
  const merge = useRpc(rpc.mergePullRequest);
  const close = useRpc(rpc.closePullRequest);
  const fetchContext = useRpc(rpc.sessionContext);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ key: string; action: "merge" | "close" } | null>(null);
  const [closeComment, setCloseComment] = useState("");
  const [footerOpen, setFooterOpen] = useState<keyof InboxView["footer"] | null>(null);

  const view = inbox.data;
  const config = view?.config;

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

  // One tap: continue the item's session, or start one with defaults [SES-01, SES-03].
  async function startWithDefaults(itemKey: string, kind: SessionKind, target: Target) {
    if (!config) return;
    const existing = agents.data?.[itemKey];
    if (existing) return openAgent(existing.id);
    await run(itemKey, "Starting the session", async () => {
      const { context } = await fetchContext({ kind, target });
      const prompt = renderPrompt(kind, target, context, config);
      const agentId = await startSession(paseo, { itemKey, kind, target, prompt, config });
      await queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      openAgent(agentId);
    });
  }

  async function act(item: Item, action: ActionId) {
    const session = ACTION_SESSION[action];
    if (action === "reply") return void openExternalUrl(item.replyUrl ?? item.url);
    if (session) return startWithDefaults(item.key, session, item.target);
    if (action === "merge" || action === "close") {
      setCloseComment("");
      return setConfirm({ key: item.key, action });
    }
    if (action === "update") {
      await run(item.key, "Update", async () => {
        await update({ target: item.target });
        toast.show(`Updating PR ${item.target.number} with ${item.target.baseRefName}`, { variant: "success" });
      });
    }
  }

  async function confirmAction(item: Item) {
    if (!confirm) return;
    const { action } = confirm;
    setConfirm(null);
    await run(item.key, action === "merge" ? "Merge" : "Close", async () => {
      if (action === "merge") await merge({ target: item.target });
      else await close({ target: item.target, comment: closeComment });
      toast.show(`PR ${item.target.number} ${action === "merge" ? "merged" : "closed"}`, { variant: "success" });
      await inbox.refreshNow();
    });
  }

  if (!view) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={inbox.error ? styles.danger : styles.muted}>
          {inbox.error ? `Couldn't load the inbox: ${(inbox.error as Error).message}` : "Loading…"}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.topBar}>
        <Text style={styles.muted}>{view.login ? `@${view.login}` : ""}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh now" onPress={() => void inbox.refreshNow().catch(() => {})}>
          <Text style={styles.muted}>
            {view.refreshing || inbox.isFetching ? "⟳ refreshing…" : `⟳ ${view.fetchedAt ? `${ago(view.fetchedAt)} ago` : "never"}`}
          </Text>
        </Pressable>
      </View>
      {view.error ? <Text style={styles.danger}>{view.error}</Text> : null}

      {view.sections.length === 0 ? <Text style={styles.text}>Nothing needs you right now.</Text> : null}

      {view.sections.map((section) => (
        <View key={section.id}>
          <Text style={styles.sectionTitle}>{section.title.toUpperCase()}</Text>
          <View style={styles.card}>
            {section.items.map((item, index) => (
              <ItemRow
                key={item.key}
                item={item}
                first={index === 0}
                styles={styles}
                agent={agents.data?.[item.key]}
                busy={busy === item.key}
                expanded={expanded === item.key}
                confirm={confirm?.key === item.key ? confirm.action : null}
                closeComment={closeComment}
                setCloseComment={setCloseComment}
                onToggle={() => setExpanded(expanded === item.key ? null : item.key)}
                onAction={(action) => void act(item, action)}
                onConfirm={() => void confirmAction(item)}
                onCancelConfirm={() => setConfirm(null)}
                onDismiss={() => void run(item.key, "Dismiss", async () => inbox.setView(await dismiss({ key: item.key })))}
                onOpenAgent={openAgent}
                config={view.config}
                onStarted={async (agentId) => {
                  await queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
                  openAgent(agentId);
                }}
                fetchContext={fetchContext}
              />
            ))}
          </View>
        </View>
      ))}

      {view.dismissedCount > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => void run("restore", "Restore", async () => inbox.setView(await restore({})))}>
          <Text style={styles.muted}>{view.dismissedCount} dismissed · show them again</Text>
        </Pressable>
      ) : null}

      <FooterBar
        footer={view.footer}
        open={footerOpen}
        setOpen={setFooterOpen}
        styles={styles}
        onStart={(entry) =>
          void startWithDefaults(entry.key, "start", { kind: "issue", repo: entry.repo, number: entry.number, title: entry.title, url: entry.url })
        }
      />
    </ScrollView>
  );
}

interface ItemRowProps {
  item: Item;
  first: boolean;
  styles: Styles;
  agent: AgentSummary | undefined;
  busy: boolean;
  expanded: boolean;
  confirm: "merge" | "close" | null;
  closeComment: string;
  setCloseComment: (text: string) => void;
  onToggle: () => void;
  onAction: (action: ActionId) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onDismiss: () => void;
  onOpenAgent: (agentId: string) => void;
  config: InboxConfig;
  onStarted: (agentId: string) => Promise<void>;
  fetchContext: (input: RpcInput<typeof rpc.sessionContext>) => Promise<RpcOutput<typeof rpc.sessionContext>>;
}

function ItemRow(props: ItemRowProps) {
  const { item, styles, agent, busy, expanded, confirm } = props;
  const tag = agentTag(agent);
  const sessionAction = item.actions.find((action) => ACTION_SESSION[action]);
  return (
    <View style={[styles.row, props.first ? null : styles.rowDivider]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${expanded ? "collapse" : "expand"}`} onPress={props.onToggle}>
        <View style={styles.rowTop}>
          <Text style={styles.number}>
            {item.kind === "pr" ? "PR" : "Issue"} {item.number}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {item.bot ? "🤖 " : ""}
            {item.title}
          </Text>
          <View style={styles.actions}>
            {busy ? <Text style={styles.muted}>working…</Text> : null}
            {!busy && agent && sessionAction ? (
              <Button label="Continue ▸" primary styles={styles} onPress={() => props.onOpenAgent(agent.id)} />
            ) : null}
            {!busy && !(agent && sessionAction)
              ? item.actions.map((action) => (
                  <Button key={action} label={ACTION_LABELS[action]} primary={action === item.actions[0]} styles={styles} onPress={() => props.onAction(action)} />
                ))
              : null}
          </View>
        </View>
        <Text style={styles.detail} numberOfLines={expanded ? undefined : 1}>
          {[item.detail, item.snippet ? `"${item.snippet}"` : "", tag ?? ""].filter(Boolean).join(" · ")}
        </Text>
        {item.children.map((child) => (
          <Text key={child.key} style={[styles.detail, styles.child]} numberOfLines={1}>
            ┊ {child.number}
            {child.detail ? ` · ${child.detail}` : ""} · {child.title}
          </Text>
        ))}
      </Pressable>

      {confirm ? (
        <View style={styles.details}>
          {confirm === "merge" ? (
            <Text style={styles.text}>
              Merge PR {item.target.number} into {item.target.baseRefName} ({item.target.mergeMethod})?
            </Text>
          ) : (
            <>
              <Text style={styles.text}>Close PR {item.target.number}? A comment is only posted if you write one.</Text>
              <TextInput
                style={styles.input}
                placeholder="Closing comment (optional)"
                placeholderTextColor={styles.muted.color}
                value={props.closeComment}
                onChangeText={props.setCloseComment}
                multiline
              />
            </>
          )}
          <View style={styles.actions}>
            <Button label={confirm === "merge" ? "Merge" : "Close PR"} primary styles={styles} onPress={props.onConfirm} />
            <Button label="Cancel" styles={styles} onPress={props.onCancelConfirm} />
          </View>
        </View>
      ) : null}

      {expanded && !confirm ? <ItemDetails {...props} sessionKind={sessionAction ? ACTION_SESSION[sessionAction] : undefined} /> : null}
    </View>
  );
}

// Expanded row: details, Dismiss, GitHub, and session options [ATT-06, SES-02].
function ItemDetails(props: ItemRowProps & { sessionKind: SessionKind | undefined }) {
  const { item, styles, agent, sessionKind } = props;
  const [showOptions, setShowOptions] = useState(false);
  return (
    <View style={styles.details}>
      <Text style={styles.muted}>
        {item.repo} · {item.kind === "pr" ? "pull request" : "issue"}
        {item.target.number !== item.number ? ` · actions apply to PR ${item.target.number}` : ""}
      </Text>
      {agent ? <Text style={styles.agentTag}>{`${agentTag(agent)} · ${agent.title ?? "session"}`}</Text> : null}
      <View style={styles.actions}>
        <Button label="Dismiss" styles={styles} onPress={props.onDismiss} />
        {/* Anything the inbox doesn't cover [ATT-12]. */}
        <Button label="GitHub ↗" styles={styles} onPress={() => void openExternalUrl(item.url)} />
        {sessionKind ? <Button label={showOptions ? "Options ▴" : "Options ▾"} styles={styles} onPress={() => setShowOptions(!showOptions)} /> : null}
      </View>
      {showOptions && sessionKind ? <SessionOptions {...props} kind={sessionKind} /> : null}
    </View>
  );
}

function SessionOptions(props: ItemRowProps & { kind: SessionKind }) {
  const { item, styles, config, kind } = props;
  const paseo = usePaseo();
  const toast = useToast();
  const target = item.target;
  const options = useQuery({
    queryKey: ["github-inbox", "options", item.key, kind],
    queryFn: async () => {
      const [{ context }, profiles, project, defaults] = await Promise.all([
        props.fetchContext({ kind, target }),
        listProfiles(paseo),
        findProject(paseo, target.repo),
        resolveAgentConfig(paseo, kind, config),
      ]);
      const workspaces = project ? await branchWorkspaces(paseo, project.projectId, target.headRefName) : [];
      return { prompt: renderPrompt(kind, target, context, config), profiles, project, workspaces, defaultLabel: defaults.label };
    },
    staleTime: 60_000,
  });
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [profileId, setProfileId] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (options.isLoading) return <Text style={styles.muted}>Loading context…</Text>;
  if (options.error || !options.data) return <Text style={styles.danger}>{(options.error as Error)?.message ?? "No options"}</Text>;
  const data = options.data;
  if (!data.project) return <Text style={styles.danger}>No Paseo project has {target.repo} as its remote. Add it as a project to start sessions.</Text>;

  const chip = (label: string, active: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" onPress={onPress} style={active ? styles.chipActive : styles.chip}>
      <Text style={active ? styles.chipActiveText : styles.chipText}>{label}</Text>
    </Pressable>
  );

  async function start() {
    setStarting(true);
    try {
      const agentId = await startSession(paseo, {
        itemKey: item.key,
        kind,
        target,
        prompt: prompt ?? data.prompt,
        config,
        profileId,
        workspaceId,
      });
      await props.onStarted(agentId);
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.muted}>Workspace</Text>
      <View style={styles.chips}>
        {chip("New worktree", workspaceId === undefined, () => setWorkspaceId(undefined))}
        {data.workspaces.map((workspace) => chip(workspace.name, workspaceId === workspace.id, () => setWorkspaceId(workspace.id)))}
      </View>
      <Text style={styles.muted}>Agent profile</Text>
      <View style={styles.chips}>
        {chip(data.defaultLabel, profileId === undefined, () => setProfileId(undefined))}
        {data.profiles.map((profile) => chip(profile.name, profileId === profile.id, () => setProfileId(profile.id)))}
      </View>
      <Text style={styles.muted}>Prompt</Text>
      <TextInput style={[styles.input, { minHeight: 140 }]} value={prompt ?? data.prompt} onChangeText={setPrompt} multiline textAlignVertical="top" />
      <View style={styles.actions}>
        <Button label={starting ? "Starting…" : "Start session ▸"} primary disabled={starting} styles={styles} onPress={() => void start()} />
      </View>
    </View>
  );
}

// Counts that don't take space in the list [ATT-10].
function FooterBar({
  footer,
  open,
  setOpen,
  styles,
  onStart,
}: {
  footer: InboxView["footer"];
  open: keyof InboxView["footer"] | null;
  setOpen: (key: keyof InboxView["footer"] | null) => void;
  styles: Styles;
  onStart: (entry: FooterEntry) => void;
}) {
  const groups: [keyof InboxView["footer"], string][] = [
    ["waitingOnOthers", "waiting on others"],
    ["toDo", "to do"],
    ["doneThisWeek", "done this week"],
  ];
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.footer}>
        {groups.map(([key, label]) => (
          <Pressable key={key} accessibilityRole="button" onPress={() => setOpen(open === key ? null : key)}>
            <Text style={styles.muted}>
              {open === key ? "▾" : "▸"} {footer[key].length} {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {open ? (
        <View style={styles.card}>
          {footer[open].length === 0 ? <Text style={[styles.muted, styles.row]}>Nothing here.</Text> : null}
          {footer[open].map((entry, index) => (
            <View key={entry.key} style={[styles.row, index === 0 ? null : styles.rowDivider]}>
              <View style={styles.rowTop}>
                <Pressable style={{ flex: 1 }} accessibilityRole="link" onPress={() => void openExternalUrl(entry.url)}>
                  <Text style={styles.title} numberOfLines={1}>
                    {entry.number} · {entry.title}
                  </Text>
                  <Text style={styles.muted}>{entry.detail}</Text>
                </Pressable>
                {open === "toDo" ? <Button label="Start ▸" styles={styles} onPress={() => onStart(entry)} /> : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
