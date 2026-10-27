import { InboxConfig } from "../shared/config";
import type { FeedId, FeedStatus, Inbox, InboxView, Item } from "../shared/inbox";
import { classify, classifyHistory } from "./classify";
import { FIXTURE, graphql } from "./gh";
import { fixture, FIXTURE_AGENTS } from "./fixture";
import type { Details, HistoryResult, LiveResult } from "./github-types";
import { detailsQuery, HISTORY_SEARCHES, LIVE_SEARCHES, type SearchName, searchQuery, searchVariables } from "./queries";
import { loadConfig, loadState, saveCodeRepo, saveState, State } from "./store";
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
export class InboxService {
  private state: State = State.parse({});
  private config: InboxConfig = InboxConfig.parse({});
  private configError: string | null = null;
  private feeds: Record<FeedId, Feed> = {
    live: { inFlight: null, lastAttemptAt: 0, error: null },
    history: { inFlight: null, lastAttemptAt: 0, error: null },
  };
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMinutes = 0;

  async start(): Promise<void> {
    this.state = await loadState();
    await this.reloadConfig().catch(() => {}); // shown as the inbox error
    this.schedule();
    void this.refreshStale();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ⟳ fetches its tab's feed now; otherwise feeds older than their schedule are fetched first.
  async get(refresh?: FeedId): Promise<InboxView> {
    if (refresh) await this.refresh(refresh).catch(() => {});
    else await this.refreshStale();
    return this.view();
  }

  async dismiss(key: string): Promise<InboxView> {
    const item = this.items().find((candidate) => candidate.key === key);
    if (item) {
      this.state.dismissed[key] = { at: item.othersActivityAt, section: item.section };
      await this.save();
    }
    return this.view();
  }

  async undismiss(key: string): Promise<InboxView> {
    delete this.state.dismissed[key];
    await saveState(this.state);
    return this.view();
  }

  async restoreDismissed(): Promise<InboxView> {
    this.state.dismissed = {};
    await this.save();
    return this.view();
  }

  // Remember where an issue repo's code lives [SES-07].
  async setCodeRepo(issueRepo: string, codeRepo: string): Promise<InboxView> {
    this.config = await saveCodeRepo(issueRepo, codeRepo);
    return this.view();
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
      if (id === "live") this.state.live = { fetchedAt, inbox: await this.fetchLive(now) };
      else this.state.history = { fetchedAt, items: await this.fetchHistory(now) };
      // Forget dismissals of items that are gone.
      const keys = new Set(this.items().map((item) => item.key));
      for (const key of Object.keys(this.state.dismissed)) if (!keys.has(key)) delete this.state.dismissed[key];
      feed.error = null;
      await this.save();
    } catch (error) {
      feed.error = (error as Error).message;
      console.error(`Inbox ${id} refresh failed:`, feed.error);
      throw error;
    }
  }

  private async fetchLive(now: Date): Promise<Inbox> {
    const { data, details } = FIXTURE ? fixture(now) : await this.searchLive(now);
    return classify({ data, details, config: this.config, now });
  }

  private async fetchHistory(now: Date): Promise<Item[]> {
    if (FIXTURE) return classifyHistory(fixture(now).data);
    return classifyHistory(await graphql<HistoryResult>(searchQuery(HISTORY_SEARCHES), this.variables(HISTORY_SEARCHES, now)));
  }

  // One request per search, in parallel. The details request starts once the searches it needs are back [GH-01].
  private async searchLive(now: Date): Promise<{ data: LiveResult; details: Details }> {
    const search = (name: (typeof LIVE_SEARCHES)[number]) =>
      graphql<Partial<LiveResult>>(searchQuery([name], name === "mine"), this.variables([name], now));
    const merge = (parts: Partial<LiveResult>[]) => Object.assign({}, ...parts) as LiveResult;
    const forDetails = Promise.all([search("mine"), search("assigned"), search("unclaimed")]);
    const others = Promise.all([search("reviews"), search("mentions"), search("commented")]);
    const afterThem = forDetails.then((parts) => this.details(merge(parts)));
    const [first, rest, details] = await Promise.all([forDetails, others, afterThem]);
    return { data: merge([...first, ...rest]), details };
  }

  private variables(names: readonly SearchName[], now: Date): Record<string, string> {
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
    return [...(this.state.live?.inbox.items ?? []), ...(this.state.history?.items ?? [])];
  }

  // Feeds finish independently; saves go one at a time so an older snapshot never lands last.
  private save(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(() => saveState(this.state));
    return this.saving;
  }

  private view(): InboxView {
    const status = (id: FeedId): FeedStatus => ({
      fetchedAt: this.state[id]?.fetchedAt ?? null,
      refreshing: this.feeds[id].inFlight !== null,
      error: this.feeds[id].error ?? this.configError,
    });
    return buildView(this.state.live?.inbox ?? null, this.state.history?.items ?? [], this.state.dismissed, {
      feeds: { live: status("live"), history: status("history") },
      config: this.config,
      ...(FIXTURE ? { fixtureAgents: FIXTURE_AGENTS } : {}),
    });
  }
}
