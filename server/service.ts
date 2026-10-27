import { InboxConfig } from "../shared/config";
import type { InboxView } from "../shared/inbox";
import { classify } from "./classify";
import { FIXTURE, graphql } from "./gh";
import { fixture, FIXTURE_AGENTS } from "./fixture";
import type { Details, SearchResult } from "./github-types";
import { detailsQuery, SEARCH_QUERY, searchVariables } from "./queries";
import { loadConfig, loadState, saveState, type State } from "./store";
import { buildView } from "./view";

// Owns the cache and the background refresh [FRESH-01, PRIV-01].
export class InboxService {
  private state: State = { dismissed: {}, last: null };
  private config: InboxConfig = InboxConfig.parse({});
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMinutes = 0;
  private lastAttemptAt = 0;

  async start(): Promise<void> {
    this.state = await loadState();
    await this.reloadConfig().catch(() => {}); // shown as the inbox error
    this.schedule();
    if (this.isOlderThan(this.config.refreshMinutes * 60)) void this.refresh().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async get(maxAgeSeconds?: number): Promise<InboxView> {
    // ⟳ (maxAgeSeconds 0) always fetches; anything else retries a failure at most every 5 minutes.
    const retryOk = maxAgeSeconds === 0 || Date.now() - this.lastAttemptAt >= 5 * 60_000;
    if (retryOk && this.isOlderThan(maxAgeSeconds ?? this.config.refreshMinutes * 60)) await this.refresh().catch(() => {});
    return this.view();
  }

  async dismiss(key: string): Promise<InboxView> {
    const item = this.state.last?.inbox.items.find((candidate) => candidate.key === key);
    if (item) {
      this.state.dismissed[key] = { at: item.othersActivityAt, section: item.section };
      await saveState(this.state);
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
    await saveState(this.state);
    return this.view();
  }

  // Concurrent callers share one refresh.
  refresh(): Promise<void> {
    this.inFlight ??= this.fetch().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async fetch(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      await this.reloadConfig();
      const now = new Date();
      const { data, details } = FIXTURE ? fixture(now) : await this.fetchGitHub(now);
      const inbox = classify({ data, details, config: this.config, now });
      // Forget dismissals of items that are gone.
      const keys = new Set(inbox.items.map((item) => item.key));
      for (const key of Object.keys(this.state.dismissed)) if (!keys.has(key)) delete this.state.dismissed[key];
      this.state.last = { fetchedAt: now.toISOString(), inbox };
      this.error = null;
      await saveState(this.state);
    } catch (error) {
      this.error = (error as Error).message;
      console.error("Inbox refresh failed:", this.error);
      throw error;
    }
  }

  private async fetchGitHub(now: Date): Promise<{ data: SearchResult; details: Details }> {
    const data = await graphql<SearchResult>(SEARCH_QUERY, searchVariables(this.config, now));
    return { data, details: await this.details(data) };
  }

  // Second request: behind counts [UPS-07] and issue field option order [NXT-02].
  private async details(data: SearchResult): Promise<Details> {
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
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
    if (this.timer && this.intervalMinutes !== this.config.refreshMinutes) this.schedule();
  }

  private schedule(): void {
    this.stop();
    this.intervalMinutes = this.config.refreshMinutes;
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.intervalMinutes * 60_000);
  }

  private isOlderThan(seconds: number): boolean {
    const fetchedAt = this.state.last?.fetchedAt;
    return !fetchedAt || Date.now() - new Date(fetchedAt).getTime() >= seconds * 1000;
  }

  private view(): InboxView {
    return buildView(this.state.last?.inbox ?? null, this.state.dismissed, {
      fetchedAt: this.state.last?.fetchedAt ?? null,
      refreshing: this.inFlight !== null,
      error: this.error,
      config: this.config,
      ...(FIXTURE ? { fixtureAgents: FIXTURE_AGENTS } : {}),
    });
  }
}
