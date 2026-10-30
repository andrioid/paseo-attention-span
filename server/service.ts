import type { Attention, AttentionView, FeedId, FeedStatus, Item } from "../shared/attention";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AttentionConfig, githubRepoOf } from "../shared/config";
import { classify, classifyHistory } from "./classify";
import { FIXTURE, graphql } from "./gh";
import { fixture, FIXTURE_AGENTS } from "./fixture";
import type { Details, HistoryResult, LiveResult } from "./github-types";
import { detailsQuery, HISTORY_SEARCHES, mergeUnclaimed, type SearchName, searchQuery, searchVariables, type UnclaimedSearch, unclaimedSearches } from "./queries";
import { loadConfig, loadState, moveOldFiles, saveCodeRepo, saveCoverage, saveNextUpSources, saveState, State } from "./store";
import { buildView } from "./view";

// History changes only when I finish something, so it's fetched daily, on ⟳ in its tab and after a merge.
const HISTORY_MAX_AGE_SECONDS = 24 * 60 * 60;
// A failed refresh is retried at most this often, except on ⟳.
const RETRY_MS = 5 * 60_000;

interface Feed {
  inFlight: Promise<void> | null;
  lastAttemptAt: number;
  error: string | null;
}

// Owns the cache and the background refresh of each feed [FRESH-01, PRIV-01].
export class AttentionService {
  private state: State = State.parse({});
  private config: AttentionConfig = AttentionConfig.parse({});
  private configError: string | null = null;
  private feeds: Record<FeedId, Feed> = {
    live: { inFlight: null, lastAttemptAt: 0, error: null },
    history: { inFlight: null, lastAttemptAt: 0, error: null },
  };
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMinutes = 0;
  // The app's connection to Paseo, from its last request; background refreshes have none of their own.
  private paseo: PluginHandlerContext["paseo"] | null = null;

  async start(): Promise<void> {
    await moveOldFiles().catch((error) => console.error("Couldn't move the old settings folder:", error));
    this.state = await loadState();
    await this.reloadConfig().catch(() => {}); // shown as the screen's error
    this.schedule();
    void this.refreshStale();
  }

  connect(paseo: PluginHandlerContext["paseo"]): void {
    this.paseo = paseo;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ⟳ fetches its tab's feed now; otherwise feeds older than their schedule are fetched first.
  async get(refresh?: FeedId): Promise<AttentionView> {
    if (refresh) await this.refresh(refresh).catch(() => {});
    else await this.refreshStale();
    return this.view();
  }

  async dismiss(key: string): Promise<AttentionView> {
    const item = this.items().find((candidate) => candidate.key === key);
    if (item) {
      this.state.dismissed[key] = { at: item.othersActivityAt, section: item.section };
      await this.save();
    }
    return this.view();
  }

  async undismiss(key: string): Promise<AttentionView> {
    delete this.state.dismissed[key];
    await saveState(this.state);
    return this.view();
  }

  async restoreDismissed(): Promise<AttentionView> {
    this.state.dismissed = {};
    await this.save();
    return this.view();
  }

  // Remember where an issue repo's code lives [SES-07].
  async setCodeRepo(issueRepo: string, codeRepo: string): Promise<AttentionView> {
    this.config = await saveCodeRepo(issueRepo, codeRepo);
    return this.view();
  }

  // Orgs and repos chosen in settings [SRC-02]. The lists follow right away; History catches up behind them.
  async setCoverage(orgs: string[], repos: string[]): Promise<void> {
    this.config = await saveCoverage(orgs, repos);
    void this.refresh("history").catch(() => {});
    await this.refresh("live").catch(() => {});
  }

  // Where Next up looks, chosen in settings [NXT-04]. Only the live feed has Next up.
  async setNextUpSources(sources: Pick<AttentionConfig["nextUp"], "mine" | "orgs" | "repos">): Promise<void> {
    this.config = await saveNextUpSources(sources);
    await this.refresh("live").catch(() => {});
  }

  async setScopes(scopes: string[]): Promise<void> {
    this.state.scopes = scopes;
    await this.save();
  }

  async setSources(sources: string[]): Promise<void> {
    this.state.sources = sources;
    await this.save();
  }

  // Concurrent callers share one refresh per feed.
  refresh(id: FeedId): Promise<void> {
    const feed = this.feeds[id];
    feed.inFlight ??= this.fetch(id).finally(() => (feed.inFlight = null));
    return feed.inFlight;
  }

  private refreshStale(): Promise<unknown> {
    const stale = (["live", "history"] as const).filter((id) => this.isStale(id));
    return Promise.all(stale.map((id) => this.refresh(id).catch(() => {})));
  }

  private async fetch(id: FeedId): Promise<void> {
    const feed = this.feeds[id];
    feed.lastAttemptAt = Date.now();
    try {
      await this.reloadConfig();
      const now = new Date();
      const fetchedAt = now.toISOString();
      if (id === "live") this.state.live = { fetchedAt, attention: await this.fetchLive(now) };
      else this.state.history = { fetchedAt, items: await this.fetchHistory(now) };
      // Forget dismissals of items that are gone.
      const keys = new Set(this.items().map((item) => item.key));
      for (const key of Object.keys(this.state.dismissed)) if (!keys.has(key)) delete this.state.dismissed[key];
      feed.error = null;
      await this.save();
    } catch (error) {
      feed.error = (error as Error).message;
      console.error(`Attention Span ${id} refresh failed:`, feed.error);
      throw error;
    }
  }

  private async fetchLive(now: Date): Promise<Attention> {
    const projectRepos = FIXTURE ? [] : await this.projectRepos();
    const login = FIXTURE ? "me" : this.config.nextUp.mine ? await this.login() : null;
    const unclaimed = unclaimedSearches(this.config, projectRepos, login);
    const { data, details } = FIXTURE ? fixture(now) : await this.searchLive(now, unclaimed.searches);
    return { ...classify({ data, details, config: this.config, now }), unclaimedFrom: unclaimed.from };
  }

  // The account gh is signed in as, for My repos [NXT-04]. Asked once, unless the last fetch already says.
  private async login(): Promise<string> {
    return (this.state.live?.attention.login || (await graphql<{ viewer: { login: string } }>("{ viewer { login } }")).viewer.login);
  }

  // My Paseo projects' GitHub repos, where Next up looks when no repos are chosen [NXT-08].
  // Without a connection yet, or if listing fails, the last list is used.
  private async projectRepos(): Promise<string[]> {
    if (this.paseo) {
      try {
        const { projects } = await this.paseo.projects.list();
        this.state.projectRepos = [...new Set(projects.map((project) => githubRepoOf(project.projectKey)).filter((repo): repo is string => !!repo))].sort();
      } catch (error) {
        console.error("Couldn't list Paseo projects:", error);
      }
    }
    return this.state.projectRepos;
  }

  private async fetchHistory(now: Date): Promise<Item[]> {
    if (FIXTURE) return classifyHistory(fixture(now).data);
    return classifyHistory(await graphql<HistoryResult>(searchQuery(HISTORY_SEARCHES), this.variables(HISTORY_SEARCHES, now)));
  }

  // One request per search, in parallel. The details request starts once the searches it needs are back [GH-01].
  private async searchLive(now: Date, unclaimed: UnclaimedSearch[]): Promise<{ data: LiveResult; details: Details }> {
    const all = searchVariables(this.config, now);
    const search = (name: keyof typeof all): Promise<Partial<LiveResult>> => graphql<Partial<LiveResult>>(searchQuery([name], name === "mine"), { [name]: all[name] });
    // One per Next up source [NXT-09].
    const searchUnclaimed = async (): Promise<Partial<LiveResult>> => {
      const results = await Promise.all(
        unclaimed.map(async ({ source, query }) => ({ source, nodes: (await graphql<Pick<LiveResult, "unclaimed">>(searchQuery(["unclaimed"]), { unclaimed: query })).unclaimed.nodes })),
      );
      return { unclaimed: { nodes: mergeUnclaimed(results) } };
    };
    const merge = (parts: Partial<LiveResult>[]) => Object.assign({}, ...parts) as LiveResult;
    const forDetails = Promise.all([search("mine"), search("assigned"), searchUnclaimed()]);
    const others = Promise.all([search("reviews"), search("mentions"), search("commented")]);
    const afterThem = forDetails.then((parts) => this.details(merge(parts)));
    const [first, rest, details] = await Promise.all([forDetails, others, afterThem]);
    return { data: merge([...first, ...rest]), details };
  }

  private variables(names: readonly Exclude<SearchName, "unclaimed">[], now: Date): Record<string, string> {
    const all = searchVariables(this.config, now);
    return Object.fromEntries(names.map((name) => [name, all[name]]));
  }

  // Behind counts [UPS-07] and issue field option order [NXT-02].
  private async details(data: Pick<LiveResult, "mine" | "assigned" | "unclaimed">): Promise<Details> {
    const prs = data.mine.nodes.filter((pr) => pr?.headRefName && !pr.isCrossRepository);
    const { priority, effort } = this.config.nextUp;
    const needsOptions = [priority, effort].some((field) => field && !field.order);
    const issues = [...data.unclaimed.nodes, ...data.assigned.nodes];
    const orgs = needsOptions ? [...new Set(issues.map((issue) => issue?.repository?.nameWithOwner.split("/")[0]).filter(Boolean))] : [];
    const details: Details = { behind: {}, fieldOptions: {} };
    if (prs.length === 0 && orgs.length === 0) return details;
    const { query, compares } = detailsQuery(prs, orgs as string[]);
    type Result = { ref?: { compare: { behindBy: number } | null } | null; issueFields?: { nodes: { name?: string; options?: { name: string }[] }[] } } | null;
    const result = await graphql<Record<string, Result>>(query);
    for (const [alias, value] of Object.entries(result)) {
      const behindBy = value?.ref?.compare?.behindBy;
      if (typeof behindBy === "number") details.behind[compares[alias]] = behindBy;
      for (const field of value?.issueFields?.nodes ?? []) if (field.name && field.options) details.fieldOptions[field.name] ??= field.options.map((o) => o.name);
    }
    return details;
  }

  private async reloadConfig(): Promise<void> {
    try {
      this.config = await loadConfig();
      this.configError = null;
    } catch (error) {
      this.configError = (error as Error).message;
      throw error;
    }
    if (this.timer && this.intervalMinutes !== this.config.refreshMinutes) this.schedule();
  }

  private schedule(): void {
    this.stop();
    this.intervalMinutes = this.config.refreshMinutes;
    this.timer = setInterval(() => {
      void this.refresh("live").catch(() => {});
      if (this.isStale("history")) void this.refresh("history").catch(() => {});
    }, this.intervalMinutes * 60_000);
  }

  // Older than the feed's schedule, and not failed within the last few minutes.
  private isStale(id: FeedId): boolean {
    const maxAgeSeconds = id === "live" ? this.config.refreshMinutes * 60 : HISTORY_MAX_AGE_SECONDS;
    const fetchedAt = this.state[id]?.fetchedAt;
    const old = !fetchedAt || Date.now() - new Date(fetchedAt).getTime() >= maxAgeSeconds * 1000;
    return old && Date.now() - this.feeds[id].lastAttemptAt >= RETRY_MS;
  }

  private items(): Item[] {
    return [...(this.state.live?.attention.items ?? []), ...(this.state.history?.items ?? [])];
  }

  // Feeds finish independently; saves go one at a time so an older snapshot never lands last.
  private save(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(() => saveState(this.state));
    return this.saving;
  }

  private view(): AttentionView {
    const status = (id: FeedId): FeedStatus => ({
      fetchedAt: this.state[id]?.fetchedAt ?? null,
      refreshing: this.feeds[id].inFlight !== null,
      error: this.feeds[id].error ?? this.configError,
    });
    return buildView(this.state.live?.attention ?? null, this.state.history?.items ?? [], this.state.dismissed, {
      feeds: { live: status("live"), history: status("history") },
      scopes: this.state.scopes,
      sources: this.state.sources,
      config: this.config,
      ...(FIXTURE ? { fixtureAgents: FIXTURE_AGENTS } : {}),
    });
  }
}
