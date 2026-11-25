import { usePaseo } from "@getpaseo/plugin/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { AttentionView } from "../shared/attention";
import { fixtureEntries, startedOnIssue } from "../shared/fixture-sessions";
import type { SessionWorkspaceEntry } from "../shared/item-sessions";
import type { PaseoAgentEntry } from "../shared/linked-sessions";
import { everyPage, type Page } from "../shared/paging";
import type { SessionSnapshot, StreamUpdate } from "../shared/session-cache";

type Paseo = ReturnType<typeof usePaseo>;
export type WorkspaceCreateOptions = Parameters<Paseo["workspaces"]["create"]>[0];
export type AgentCreateOptions = Parameters<ReturnType<Paseo["workspaces"]["ref"]>["agents"]["create"]>[0];

// Everything the session cache and a start reach in Paseo, like the server's Port: Paseo itself here, made up for previews,
// whose daemon has no agent provider [FRESH-04, SES-01].
export interface SessionSource {
  // Every page of Paseo's agents and workspaces [ATT-22]. With `subscribe`, the daemon streams their updates from then on,
  // until the subscription is released; null when the host doesn't.
  list(subscribe: boolean): Promise<{ snapshot: SessionSnapshot; subscription: SessionSubscription | null }>;
  // Paseo's updates to them, as they come; throws on a host without them.
  subscribe(onUpdate: (update: StreamUpdate) => void): () => void;
  createWorkspace(options: WorkspaceCreateOptions): Promise<{ id: string }>;
  createAgent(workspaceId: string, options: AgentCreateOptions): Promise<{ id: string }>;
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

// Paseo's own lists and stream, over the host's SDK.
export function paseoSource(paseo: Paseo): SessionSource {
  // Paseo's own screens list agents with filters of their own, and their updates reach every listener; only this
  // subscription's are the whole list's, so the others are left out once its ID is known.
  const ours = new Set<string>();
  const mine = (update: { subscriptionId?: string }) => !update.subscriptionId || !ours.size || ours.has(update.subscriptionId);
  // A seq counts within one subscription and generation.
  const position = (update: { subscriptionId?: string; seq?: number; generation?: string }) => ({
    seq: update.seq,
    generation: `${update.subscriptionId ?? ""}/${update.generation ?? ""}`,
  });
  return {
    async list(subscribe) {
      const owned: Owned[] = [];
      // Only the first page subscribes; the stream covers the whole list.
      const page = <E>(list: (page: { limit: number; cursor?: string }, subscribing: boolean) => Promise<Page<E> & { subscription?: Owned }>) =>
        everyPage(async (at) => {
          const result = await list(at, subscribe && !at.cursor);
          if (result.subscription) owned.push(result.subscription);
          return result;
        });
      try {
        const [agents, workspaces] = await Promise.all([
          page((at, subscribing) => (subscribing ? paseo.agents.list({ page: at, subscribe: {} }) : paseo.agents.list({ page: at }))),
          page((at, subscribing) => (subscribing ? paseo.workspaces.list({ page: at, subscribe: {} }) : paseo.workspaces.list({ page: at }))),
        ]);
        const snapshot = { agents: agents.map((entry) => entry.agent), workspaces };
        // A host that streams only one of the two can't keep the sessions current: it's polled instead.
        if (!subscribe || owned.length < 2) {
          for (const subscription of owned) void subscription.release().catch(() => {});
          return { snapshot, subscription: null };
        }
        for (const subscription of owned) if (subscription.subscriptionId) ours.add(subscription.subscriptionId);
        return { snapshot, subscription: ownedTogether(owned, (id) => ours.add(id)) };
      } catch (error) {
        for (const subscription of owned) void subscription.release().catch(() => {});
        throw error;
      }
    },
    subscribe(onUpdate) {
      const stopAgents = paseo.agents.subscribe((update) => {
        if (!mine(update)) return;
        if (update.kind === "upsert") onUpdate({ of: "agent", kind: "upsert", entry: update.agent, ...position(update) });
        else onUpdate({ of: "agent", kind: "remove", id: update.agentId, ...position(update) });
      });
      try {
        const stopWorkspaces = paseo.workspaces.subscribe((update) => {
          if (!mine(update)) return;
          if (update.kind === "upsert") onUpdate({ of: "workspace", kind: "upsert", entry: update.workspace, ...position(update) });
          else onUpdate({ of: "workspace", kind: "remove", id: update.id, ...position(update) });
        });
        return () => (stopAgents(), stopWorkspaces());
      } catch (error) {
        stopAgents();
        throw error;
      }
    },
    createWorkspace: (options) => paseo.workspaces.create(options),
    createAgent: (workspaceId, options) => paseo.workspaces.ref(workspaceId).agents.create(options),
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

// The preview's: the made-up sessions, a start that makes one up, and the started-on-issues ones going and coming back as
// the view says, as an archive in Paseo would [SES-11].
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
      emit({ of: "workspace", kind: "upsert", entry: workspace });
      return { id: workspace.id };
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
      emit({ of: "agent", kind: "upsert", entry: agent });
      return { id: agent.id };
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
