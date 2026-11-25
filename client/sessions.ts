import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { type AttentionView, checkoutPr, sessionTitle, type Target } from "../shared/attention";
import { closedBranches } from "../shared/linked-sessions";
import { ITEM_LABEL, KIND_LABEL, LABEL } from "../shared/item-sessions";
import { chooseAgent, type ReadyProvider } from "../shared/providers";
import { type AttentionConfig, codeRepoFor, githubRepoOf, SessionKind } from "../shared/config";
import * as rpc from "../shared/rpc";
import {
  applySnapshot,
  applyUpdates,
  type SessionEntries,
  type SessionResult,
  type SessionUpdate,
  sessionsOf,
  type Stamp,
  writeResult,
} from "../shared/session-cache";
import { VIEW_QUERY_KEY, writeView } from "./data";
import { sameName } from "../shared/names";
import { type SessionSource, type SessionSubscription, useSessionSource } from "./session-source";

type Paseo = ReturnType<typeof usePaseo>;

// Paseo's agents and workspaces, held for the screen and the sidebar's count alike, which make the sessions from them
// [ATT-09, ATT-22, FRESH-04].
export const SESSIONS_QUERY_KEY = ["attention-span", "sessions"] as const;

// When the app learned something, for the cache's stamps: a counter, so two never tie.
let clock = 0;
export const stamp = (): Stamp => ++clock;

// What an action Paseo confirmed changed, written so nothing learned before it undoes it [FRESH-04].
export function writeSessions(queryClient: QueryClient, result: SessionResult, at: Stamp = stamp()) {
  queryClient.setQueryData<SessionEntries>(SESSIONS_QUERY_KEY, (entries) => writeResult(entries, result, at));
}

type FetchAttention = (input: { cached: true }) => Promise<AttentionView>;

// Paseo's stream, one per app, shared by the screen and the sidebar item, until the last of them goes [FRESH-04].
interface Live {
  source: SessionSource;
  fetchAttention: FetchAttention;
  users: number;
  // Null until the first list says; false on a host without the stream, which is listed every 15 s instead.
  streaming: boolean | null;
  subscription: SessionSubscription | null;
  subscribing: boolean;
  // Lists running: updates wait for them, so a list's answer never lands on top of what the stream said meanwhile.
  listing: number;
  pending: SessionUpdate[];
  timer: ReturnType<typeof setTimeout> | null;
  // Every write in turn, as one may wait on the server's view first.
  writing: Promise<unknown>;
  stop: () => void;
}
const lives = new WeakMap<QueryClient, Live>();

// Agents send many status updates while they work; they're written a quarter of a second at a time.
const BATCH_MS = 250;
// With the stream, a full list now and then only catches what it missed; without it, the list is all there is.
const STREAMING_LIST_MS = 5 * 60_000;
const POLL_MS = 15_000;

// Subscribed before anything is listed, so no update falls between a list and the stream.
function liveFor(queryClient: QueryClient, source: SessionSource, fetchAttention: FetchAttention): Live {
  const known = lives.get(queryClient);
  if (known) return known;
  const live: Live = { source, fetchAttention, users: 0, streaming: null, subscription: null, subscribing: false, listing: 0, pending: [], timer: null, writing: Promise.resolve(), stop: () => {} };
  lives.set(queryClient, live);
  try {
    live.stop = source.subscribe((update) => {
      live.pending.push({ ...update, at: stamp() });
      live.timer ??= setTimeout(() => flush(queryClient, live), BATCH_MS);
    });
  } catch {
    live.streaming = false; // an older host: polled as before
  }
  return live;
}

function acquire(queryClient: QueryClient, source: SessionSource, fetchAttention: FetchAttention): () => void {
  const live = liveFor(queryClient, source, fetchAttention);
  live.users++;
  return () => {
    if (--live.users > 0 || lives.get(queryClient) !== live) return;
    lives.delete(queryClient);
    live.stop();
    live.subscription?.release();
    if (live.timer) clearTimeout(live.timer);
  };
}

// When a session has gone, archived in Paseo or here, the server's view is read first (from memory, not GitHub), so the
// notes the server acknowledged for it are cleared before its Wrap up row goes, rather than showing as unread in between
// [HIS-07].
async function goneFirst(queryClient: QueryClient, live: Live, before: SessionEntries | undefined, after: SessionEntries) {
  if (!before) return;
  const branches = closedBranches(queryClient.getQueryData<AttentionView>(VIEW_QUERY_KEY) ?? {});
  const now = new Set(sessionsOf(after, branches).map((session) => session.id));
  if (!sessionsOf(before, branches).some((session) => !now.has(session.id))) return;
  await live
    .fetchAttention({ cached: true })
    .then((view) => writeView(queryClient, view))
    .catch(() => {}); // the view's own poll catches up
}

function flush(queryClient: QueryClient, live: Live) {
  live.timer = null;
  // Before the first list, and while one runs, they wait for it.
  if (live.listing || !queryClient.getQueryData(SESSIONS_QUERY_KEY) || !live.pending.length) return;
  const updates = live.pending.splice(0);
  live.writing = live.writing.then(async () => {
    const before = queryClient.getQueryData<SessionEntries>(SESSIONS_QUERY_KEY);
    if (before) await goneFirst(queryClient, live, before, applyUpdates(before, updates));
    queryClient.setQueryData<SessionEntries>(SESSIONS_QUERY_KEY, (entries) => (entries ? applyUpdates(entries, updates) : entries));
  });
}

// A full list, merged into what's held; the first also starts the stream [FRESH-04].
async function listInto(queryClient: QueryClient, source: SessionSource, fetchAttention: FetchAttention): Promise<SessionEntries> {
  const live = liveFor(queryClient, source, fetchAttention);
  const subscribe = live.streaming !== false && !live.subscription && !live.subscribing;
  const at = stamp();
  live.listing++;
  live.subscribing ||= subscribe;
  try {
    const { snapshot, subscription } = await live.source.list(subscribe);
    if (subscribe) adopt(queryClient, live, subscription);
    const merged = live.writing.then(async () => {
      const before = queryClient.getQueryData<SessionEntries>(SESSIONS_QUERY_KEY);
      await goneFirst(queryClient, live, before, applySnapshot(before, snapshot, at));
      // What the stream said meanwhile goes on top; what it said before the list was asked for is older, and dropped.
      const entries = applyUpdates(applySnapshot(queryClient.getQueryData(SESSIONS_QUERY_KEY), snapshot, at), live.pending.splice(0));
      // Written here too, so a list the query gave up on (a refetch on top of it) still counts.
      queryClient.setQueryData(SESSIONS_QUERY_KEY, entries);
      return entries;
    });
    live.writing = merged;
    return await merged;
  } finally {
    live.listing--;
    if (subscribe) live.subscribing = false;
    if (live.pending.length) live.timer ??= setTimeout(() => flush(queryClient, live), BATCH_MS);
  }
}

// The stream's subscription, kept until the last user goes; a full list again whenever the host restores it.
function adopt(queryClient: QueryClient, live: Live, subscription: SessionSubscription | null) {
  if (lives.get(queryClient) !== live) return subscription?.release();
  live.streaming = !!subscription;
  live.subscription = subscription;
  if (!subscription) return;
  const stopRestored = subscription.onRestored(() => void queryClient.refetchQueries({ queryKey: SESSIONS_QUERY_KEY }, { cancelRefetch: false }));
  const stop = live.stop;
  live.stop = () => (stopRestored(), stop());
}

// The sessions on items, for the screen and the sidebar alike, kept current by Paseo's stream [ATT-09, ATT-22, FRESH-04].
// They're made from what's held and the view's merged and closed PRs, whose branches find sessions Paseo no longer links,
// so a new view just makes them again [ATT-22, FRESH-03].
export function useSessions(view: AttentionView | undefined) {
  const queryClient = useQueryClient();
  const fetchAttention = useRpc(rpc.getAttention);
  const source = useSessionSource(view);
  useEffect(() => (source ? acquire(queryClient, source, fetchAttention) : undefined), [queryClient, source]);
  const branches = useMemo(() => closedBranches(view ?? {}), [view]);
  const signature = [...branches].join("\n");
  const select = useCallback((entries: SessionEntries) => sessionsOf(entries, branches), [signature]);
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    enabled: !!source,
    queryFn: () => listInto(queryClient, source!, fetchAttention),
    select,
    refetchInterval: () => (lives.get(queryClient)?.streaming ? STREAMING_LIST_MS : POLL_MS),
  });
}

// Labels tie an agent to the item it works on [ATT-07, SES-03]; kept with the rest of the session list in shared.
export { ITEM_LABEL, KIND_LABEL, LABEL };

export interface ProjectMatch {
  projectId: string;
  rootPath: string;
}

export interface GitHubProject extends ProjectMatch {
  repo: string;
}

// Registered Paseo projects with a GitHub remote, by "owner/name".
export async function githubProjects(paseo: Paseo): Promise<GitHubProject[]> {
  const { projects } = await paseo.projects.list();
  return projects.flatMap((project) => {
    const repo = githubRepoOf(project.projectKey);
    return repo ? [{ repo, projectId: project.projectId, rootPath: project.projectRootPath }] : [];
  });
}

// The local checkout is the registered Paseo project with the repo's GitHub remote [SES-05].
export async function findProject(paseo: Paseo, repo: string): Promise<ProjectMatch | null> {
  return (await githubProjects(paseo)).find((project) => sameName(project.repo, repo)) ?? null;
}

export interface Checkout {
  repo: string;
  project: ProjectMatch | null;
  // Where a new branch for an issue starts.
  baseBranch?: string;
}

// The item's own repo, or for an issue the repo its code lives in [SES-05, SES-07].
export async function findCheckout(
  paseo: Paseo,
  config: Pick<AttentionConfig, "codeRepos">,
  target: Target,
  defaultBranch: (repo: string) => Promise<string | null>,
): Promise<Checkout> {
  const repo = target.kind === "issue" ? codeRepoFor(config, target.repo) : target.repo;
  const project = await findProject(paseo, repo);
  if (sameName(repo, target.repo)) return { repo, project, baseBranch: target.defaultBranch };
  return { repo, project, baseBranch: project ? ((await defaultBranch(repo)) ?? undefined) : undefined };
}

export function noProjectMessage(checkout: Checkout, target: Target): string {
  const where = sameName(checkout.repo, target.repo) ? checkout.repo : `${checkout.repo}, where ${target.repo}'s code lives,`;
  return `No Paseo project has ${where} as its GitHub remote. Add the repository as a project first.`;
}

export interface WorkspaceChoice {
  id: string;
  name: string;
}

// Existing workspaces of the project that have the PR's branch checked out.
export async function branchWorkspaces(paseo: Paseo, projectId: string, branch: string | undefined): Promise<WorkspaceChoice[]> {
  if (!branch) return [];
  const { entries } = await paseo.workspaces.list();
  return entries
    .filter((workspace) => workspace.projectId === projectId && workspace.gitRuntime?.currentBranch === branch && !workspace.archivingAt)
    .map((workspace) => ({ id: workspace.id, name: workspace.title ?? workspace.name }));
}

export interface ProfileChoice {
  id: string;
  name: string;
}

export async function listProfiles(paseo: Paseo): Promise<ProfileChoice[]> {
  const { config } = await paseo.config.get();
  return (config.agentProfiles ?? []).map((profile) => ({ id: profile.id, name: profile.name }));
}

type AgentConfig = Parameters<Paseo["agents"]["create"]>[0]["config"];
// Asks the plugin's server, whose snapshot always has the entries [SES-06].
export type FetchProviders = () => Promise<ReadyProvider[]>;

// What a start asks the plugin's server: the prompt's context, a repo's default branch, and the ready providers [SES-01, SES-02].
export function useStartRpcs() {
  const fetchContext = useRpc(rpc.sessionContext);
  const fetchDefaultBranch = useRpc(rpc.defaultBranch);
  const fetchReadyProviders = useRpc(rpc.readyProviders);
  const fetchProviders: FetchProviders = () => fetchReadyProviders({}).then((result) => result.providers);
  return { fetchContext, fetchProviders, defaultBranch: async (repo: string) => (await fetchDefaultBranch({ repo })).name };
}

// The profile configured for the session type, then "default", then Paseo's defaults [SES-01, SES-06].
export async function resolveAgentConfig(
  paseo: Paseo,
  fetchProviders: FetchProviders,
  kind: SessionKind,
  config: AttentionConfig,
  profileId?: string,
): Promise<{ agent: AgentConfig; label: string }> {
  const { config: daemon } = await paseo.config.get();
  const profiles = daemon.agentProfiles ?? [];
  const byName = (name: string | undefined) =>
    name ? profiles.find((p) => p.id === name || sameName(p.name, name)) : undefined;
  const profile = profileId ? byName(profileId) : (byName(config.profiles[kind]) ?? byName(config.profiles.default));
  // A profile that names its model needs no provider lookup.
  const providers = profile?.model ? [] : await fetchProviders();
  return chooseAgent(profile, providers);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export interface StartSession {
  itemKey: string;
  kind: SessionKind;
  target: Target;
  prompt: string;
  config: AttentionConfig;
  fetchProviders: FetchProviders;
  checkout: Checkout;
  profileId?: string;
  workspaceId?: string; // an existing workspace; otherwise a new worktree
}

// A new worktree: checkout-pr for PRs, branch-off from the default branch for issues. Made through the session source, so
// a preview can make one up.
export async function startSession(paseo: Paseo, source: SessionSource, input: StartSession): Promise<string> {
  const { target, checkout } = input;
  const project = checkout.project;
  if (!project) throw new Error(noProjectMessage(checkout, target));
  const { agent: agentConfig } = await resolveAgentConfig(paseo, input.fetchProviders, input.kind, input.config, input.profileId);
  const title = sessionTitle(input.kind, target);

  const workspaceId =
    input.workspaceId ??
    (
      await source.createWorkspace({
        title,
        source:
          target.kind === "pr"
            ? {
                kind: "worktree",
                cwd: project.rootPath,
                projectId: project.projectId,
                action: "checkout",
                checkoutSource: { kind: "change_request", forge: "github", number: checkoutPr(input.kind, target).number },
              }
            : {
                kind: "worktree",
                cwd: project.rootPath,
                projectId: project.projectId,
                action: "branch-off",
                baseBranch: checkout.baseBranch,
                branchName: `issue-${target.number}-${slug(target.title)}`,
              },
      })
    ).id;
  const agent = await source.createAgent(workspaceId, {
    config: agentConfig,
    title,
    prompt: input.prompt,
    labels: { [LABEL]: "1", [ITEM_LABEL]: input.itemKey, [KIND_LABEL]: input.kind },
  });
  return agent.id;
}
