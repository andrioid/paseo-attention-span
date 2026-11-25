import { usePaseo } from "@getpaseo/plugin/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { AttentionView } from "../shared/attention";
import { fixtureEntries, startedOnIssue } from "../shared/fixture-sessions";
import type { SessionWorkspaceEntry } from "../shared/item-sessions";
import type { PaseoAgentEntry } from "../shared/linked-sessions";
import { everyPage, type Page } from "../shared/paging";
import type { ReadyProvider } from "../shared/providers";
import type { SessionResult, SessionSnapshot, StreamUpdate } from "../shared/session-cache";

type Paseo = ReturnType<typeof usePaseo>;
export type WorkspaceCreateOptions = Parameters<Paseo["workspaces"]["create"]>[0];
type WorkspaceHandle = Awaited<ReturnType<Paseo["workspaces"]["create"]>>;
export type AgentCreateOptions = Parameters<WorkspaceHandle["agents"]["create"]>[0];
type AgentHandle = Awaited<ReturnType<WorkspaceHandle["agents"]["create"]>>;

// Everything the session cache and a start reach in Paseo, like the server's Port: Paseo itself here, made up for previews,
// whose daemon has no agent provider [FRESH-04, SES-01].
export interface SessionSource {
  // Every page of Paseo's agents and workspaces [ATT-22]. With `subscribe`, the daemon streams their updates from then on,
  // until the subscription is released; null when the host doesn't.
  list(subscribe: boolean): Promise<{ snapshot: SessionSnapshot; subscription: SessionSubscription | null }>;
  // Paseo's updates to them, as they come; throws on a host without them.
  subscribe(onUpdate: (update: StreamUpdate) => void): () => void;
  // Each answers with Paseo's own entry for what it made, as its lists would have it, for the start to write before its
  // spinner stops [FRESH-04, SES-10].
  createWorkspace(options: WorkspaceCreateOptions): Promise<SessionWorkspaceEntry>;
  // A workspace in a directory, Paseo's own if it has one there (feedback's scratch folder, a new issue's checkout).
  openWorkspace(cwd: string): Promise<SessionWorkspaceEntry>;
  createAgent(workspaceId: string, options: AgentCreateOptions): Promise<PaseoAgentEntry>;
  // The ready agent providers, where they aren't the host's: a preview's [SES-06].
  readyProviders?(): Promise<ReadyProvider[]>;
  // What an action did in Paseo, for a made-up Paseo to keep up with; Paseo's own knows already.
  learn?(result: SessionResult): void;
}

export interface SessionSubscription {
  release(): void;
  // Runs `run` when the host restores the stream after a reconnect: what it missed meanwhile takes a full list.
  onRestored(run: () => void): () => void;
}

// The parts of the SDK's owned subscription this uses; older hosts may lack `subscribe`.
interface Owned {
  readonly subscriptionId: string | null;
  subscribe?(observer: { snapshot(snapshot: { subscriptionId: string }): void; update(): void }): () => void;
  release(): Promise<void>;
}

// The entry Paseo's lists would have for a workspace just made or opened: the handle's snapshot, else asked for, else
// what's known of it.
async function workspaceEntry(handle: WorkspaceHandle, kind: SessionWorkspaceEntry["workspaceKind"], title?: string): Promise<SessionWorkspaceEntry> {
  const known = handle.current() ?? (await handle.refresh().catch(() => null));
  return known ?? { id: handle.id, workspaceKind: kind, name: handle.name ?? title ?? handle.id, ...(title ? { title } : {}), workspaceDirectory: handle.directory };
}

// …and for an agent just made, labelled as it was made, so its item's card finds it either way.
async function agentEntry(handle: AgentHandle, workspaceId: string, options: AgentCreateOptions): Promise<PaseoAgentEntry> {
  if (!handle.current()) await handle.refresh().catch(() => null);
  const known = handle.current();
  return known ?? { id: handle.id, labels: options.labels ?? {}, status: "running", requiresAttention: false, title: options.title ?? null, workspaceId, updatedAt: new Date().toISOString() };
}

// Paseo's own lists and stream, over the host's SDK.
export function paseoSource(paseo: Paseo): SessionSource {
  // Paseo's own screens list agents with filters of their own, and their updates reach every listener. An upsert is the
  // whole entry, whoever's it is; a remove from a filtered subscription may only mean the entry left its filter, so only
  // ours count. While ours are being listed, removes wait until their IDs are known.
  const ours = new Set<string>();
  let listing = 0;
  let held: { subscriptionId: string; deliver: () => void }[] = [];
  const removal = (update: { subscriptionId?: string }, deliver: () => void) => {
    if (!update.subscriptionId || ours.has(update.subscriptionId)) deliver();
    else if (listing) held.push({ subscriptionId: update.subscriptionId, deliver });
  };
  const ownershipKnown = () => {
    const waiting = held;
    held = [];
    for (const remove of waiting) if (ours.has(remove.subscriptionId)) remove.deliver();
  };
  // A seq counts within one subscription and generation.
  const position = (update: { subscriptionId?: string; seq?: number; generation?: string }) => ({
    seq: update.seq,
    generation: `${update.subscriptionId ?? ""}/${update.generation ?? ""}`,
  });
  return {
    async list(subscribe) {
      const owned: Owned[] = [];
      // Only the first page subscribes; the stream covers the whole list. Its ID is ours as soon as that page is back.
      const page = <E>(list: (page: { limit: number; cursor?: string }, subscribing: boolean) => Promise<Page<E> & { subscription?: Owned }>) =>
        everyPage(async (at) => {
          const result = await list(at, subscribe && !at.cursor);
          if (result.subscription) {
            owned.push(result.subscription);
            if (result.subscription.subscriptionId) ours.add(result.subscription.subscriptionId);
          }
          return result;
        });
      const release = () => {
        for (const subscription of owned) {
          if (subscription.subscriptionId) ours.delete(subscription.subscriptionId);
          void subscription.release().catch(() => {});
        }
      };
      if (subscribe) listing++;
      try {
        // Both settle before anything is decided, so a subscription that comes back after the other list failed is
        // released too, not left streaming with nobody to release it.
        const [agents, workspaces] = await Promise.allSettled([
          page((at, subscribing) => (subscribing ? paseo.agents.list({ page: at, subscribe: {} }) : paseo.agents.list({ page: at }))),
          page((at, subscribing) => (subscribing ? paseo.workspaces.list({ page: at, subscribe: {} }) : paseo.workspaces.list({ page: at }))),
        ]);
        if (agents.status === "rejected" || workspaces.status === "rejected") {
          release();
          throw agents.status === "rejected" ? agents.reason : (workspaces as PromiseRejectedResult).reason;
        }
        const snapshot = { agents: agents.value.map((entry) => entry.agent), workspaces: workspaces.value };
        // A host that streams only one of the two can't keep the sessions current: it's polled instead.
        if (!subscribe || owned.length < 2) {
          release();
          return { snapshot, subscription: null };
        }
        return { snapshot, subscription: ownedTogether(owned, (id) => ours.add(id)) };
      } finally {
        if (subscribe) listing--;
        ownershipKnown();
      }
    },
    subscribe(onUpdate) {
      const stopAgents = paseo.agents.subscribe((update) => {
        if (update.kind === "upsert") onUpdate({ of: "agent", kind: "upsert", entry: update.agent, ...position(update) });
        else removal(update, () => onUpdate({ of: "agent", kind: "remove", id: update.agentId, ...position(update) }));
      });
      try {
        const stopWorkspaces = paseo.workspaces.subscribe((update) => {
          if (update.kind === "upsert") onUpdate({ of: "workspace", kind: "upsert", entry: update.workspace, ...position(update) });
          else removal(update, () => onUpdate({ of: "workspace", kind: "remove", id: update.id, ...position(update) }));
        });
        return () => (stopAgents(), stopWorkspaces());
      } catch (error) {
        stopAgents();
        throw error;
      }
    },
    createWorkspace: async (options) => workspaceEntry(await paseo.workspaces.create(options), "worktree", options.title ?? undefined),
    openWorkspace: async (cwd) => workspaceEntry(await paseo.workspaces.open({ cwd }), "directory"),
    createAgent: async (workspaceId, options) => agentEntry(await paseo.workspaces.ref(workspaceId).agents.create(options), workspaceId, options),
  };
}

// The agents' and workspaces' subscriptions as one. The SDK hands a restored subscription a fresh snapshot under a new ID.
function ownedTogether(owned: Owned[], restoredAs: (id: string) => void): SessionSubscription {
  return {
    release: () => owned.forEach((subscription) => void subscription.release().catch(() => {})),
    onRestored(run) {
      const stops = owned.map((subscription) => {
        let last = subscription.subscriptionId;
        try {
          return (
            subscription.subscribe?.({
              snapshot: ({ subscriptionId }) => {
                if (subscriptionId === last) return;
                last = subscriptionId;
                restoredAs(subscriptionId);
                run();
              },
              update: () => {},
            }) ?? (() => {})
          );
        } catch {
          return () => {}; // an older host: the five-minute list catches up
        }
      });
      return () => stops.forEach((stop) => stop());
    },
  };
}

// The preview's: the made-up sessions, a start that makes one up with a made-up agent provider, an archive that takes them
// away, and the started-on-issues ones going and coming back as the view says, as an archive in Paseo would [SES-11].
// What a start or an archive makes isn't streamed: only the action's own write shows it, as the preview's shots check
// [FRESH-04].
export interface PreviewSource extends SessionSource {
  showStarted(show: boolean): void;
}

export function previewSource(now = Date.now()): PreviewSource {
  let { agents, workspaces } = fixtureEntries(now);
  let started = true;
  let made = 0;
  const listeners = new Set<(update: StreamUpdate) => void>();
  const emit = (update: StreamUpdate) => listeners.forEach((listener) => listener(update));
  return {
    list: async () => ({
      snapshot: { agents: started ? agents : agents.filter((agent) => !startedOnIssue(agent)), workspaces },
      subscription: { release: () => {}, onRestored: () => () => {} },
    }),
    subscribe(onUpdate) {
      listeners.add(onUpdate);
      return () => void listeners.delete(onUpdate);
    },
    async createWorkspace(options) {
      const branch = options.source?.kind === "worktree" && "branchName" in options.source ? options.source.branchName : undefined;
      const workspace: SessionWorkspaceEntry = {
        id: `WS_preview_${++made}`,
        workspaceKind: "worktree",
        name: options.title ?? `Workspace ${made}`,
        ...(options.title ? { title: options.title } : {}),
        gitRuntime: { currentBranch: branch ?? null, isDirty: false, aheadOfOrigin: 0 },
      };
      workspaces = [...workspaces, workspace];
      return workspace;
    },
    async openWorkspace(cwd) {
      const known = workspaces.find((workspace) => workspace.workspaceDirectory === cwd);
      if (known) return known;
      const workspace: SessionWorkspaceEntry = { id: `WS_preview_${++made}`, workspaceKind: "directory", name: cwd.split("/").pop() || cwd, workspaceDirectory: cwd };
      workspaces = [...workspaces, workspace];
      return workspace;
    },
    async createAgent(workspaceId, options) {
      const agent: PaseoAgentEntry = {
        id: `agent-preview-${++made}`,
        labels: options.labels ?? {},
        status: "running",
        requiresAttention: false,
        title: options.title ?? null,
        workspaceId,
        updatedAt: new Date().toISOString(),
      };
      agents = [...agents, agent];
      return agent;
    },
    readyProviders: async () => [{ provider: "preview", label: "Preview agent", defaultModel: "preview" }],
    learn({ archivedAgents = [], archivedWorkspaces = [] }) {
      agents = agents.filter((agent) => !archivedAgents.includes(agent.id));
      workspaces = workspaces.filter((workspace) => !archivedWorkspaces.includes(workspace.id));
    },
    showStarted(show) {
      if (show === started) return;
      started = show;
      for (const agent of agents.filter(startedOnIssue)) emit(show ? { of: "agent", kind: "upsert", entry: agent } : { of: "agent", kind: "remove", id: agent.id });
    },
  };
}

// One preview source per app, so the screen's and the sidebar's see the same made-up sessions.
const previews = new WeakMap<QueryClient, PreviewSource>();
const previewFor = (queryClient: QueryClient) => previews.get(queryClient) ?? previews.set(queryClient, previewSource()).get(queryClient)!;

// The view says which: Paseo's, or the preview's when the server runs on made-up data. None until the view has loaded.
export function useSessionSource(view: Pick<AttentionView, "fixture" | "fixtureNoStarted"> | undefined): SessionSource | null {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loaded = !!view;
  const fixture = !!view?.fixture;
  const source = useMemo(() => (!loaded ? null : fixture ? previewFor(queryClient) : paseoSource(paseo)), [loaded, fixture, paseo, queryClient]);
  const noStarted = !!view?.fixtureNoStarted;
  useEffect(() => {
    if (fixture) previewFor(queryClient).showStarted(!noStarted);
  }, [fixture, noStarted, queryClient]);
  return source;
}
