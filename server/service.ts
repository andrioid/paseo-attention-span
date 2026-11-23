import { type Attention, type AttentionView, baseItem, type CloseAsk, type FeedId, type FeedStatus, type HistoryFilter, type Item, memberKeys, type ProjectsAccess, type Reviewer } from "../shared/attention";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AttentionConfig, type FieldRole } from "../shared/config";
import { newIssueRepos } from "../shared/new-issue";
import type { IssueField } from "../shared/setup";
import type { ArchiveOutcome, ArchiveTarget, KeptRow, KeptWorktree } from "../shared/archive";
import { rememberGroups } from "../shared/wrap-up";
import { acknowledge, ownClosed } from "./changes";
import { classify, classifyCloseAsks, classifyHistory } from "./classify";
import { probeAnswer, projectsFailure, projectsWarning } from "./projects";
import type { Port } from "./port";
import { historySince, isTimeZone, type UnclaimedSearch, unclaimedSearches } from "./queries";
import type { Details, LiveResult, ReferencedIssue } from "./github-types";
import { State } from "./store";
import { applyPending, buildView, doneItem, type Effect, isPending, type Pending, SETTLE_MS } from "./view";
import { keySet, uniqueKeys } from "../shared/names";

// History changes only when I finish something, so it's fetched daily, on ⟳ in its tab and after a merge.
const HISTORY_MAX_AGE_SECONDS = 24 * 60 * 60;
// A failed refresh is retried at most this often, except on ⟳.
const RETRY_MS = 5 * 60_000;
// Whether projects can be read is asked again at most this often, unless Settings asks [NXT-12].
const PROJECTS_CHECK_MS = 60 * 60_000;

// Where gh's token comes from: an environment variable, which gh reads before its own login, or that login [NXT-12].
const tokenSource = (): ProjectsAccess["token"] => (process.env.GH_TOKEN ? "GH_TOKEN" : process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "gh");

// What a change does to the lists: an effect, Finished (merged or closed, so off the lists and maybe into History), or nothing.
export type Change = Effect | { kind: "finished"; notPlanned?: boolean } | null;

interface Feed {
  inFlight: Promise<void> | null;
  // A fetch queued to start once the one in flight is done, for callers that need data from after now.
  next: Promise<void> | null;
  lastAttemptAt: number;
  error: string | null;
}

// Owns the cache and the background refresh of each feed [FRESH-01, PRIV-01].
export class AttentionService {
  private state: State = State.parse({});
  // Workspaces Paseo said were archived; an archive that keeps one of them after the fact adds no row for it [ATT-22].
  private archivedWorkspaces = new Set<string>();
  // Merged PRs of mine a History fetch was asked for, once each, so a search slow to show one doesn't fetch on every refresh.
  private historyAskedFor = new Set<string>();
  private config: AttentionConfig = AttentionConfig.parse({});
  private configError: string | null = null;
  private feeds: Record<FeedId, Feed> = {
    live: { inFlight: null, next: null, lastAttemptAt: 0, error: null },
    history: { inFlight: null, next: null, lastAttemptAt: 0, error: null },
  };
  private saving: Promise<void> = Promise.resolve();
  private timer: (() => void) | null = null;
  private followUps: Partial<Record<FeedId, () => void>> = {};
  private intervalMinutes = 0;
  private projects: { access: ProjectsAccess; checkedAt: number } = { access: { state: "unknown", token: tokenSource() }, checkedAt: 0 };
  private projectsProbe: Promise<ProjectsAccess> | null = null;
  private projectsWarning: string | undefined;
  // The app's connection to Paseo, from its last request; background refreshes have none of their own.
  private paseo: PluginHandlerContext["paseo"] | null = null;

  constructor(private readonly port: Port) {}

  async start(): Promise<void> {
    await this.port.store.moveOldFiles().catch((error) => console.error("Couldn't move the old settings folder:", error));
    this.state = await this.port.store.loadState();
    await this.reloadConfig().catch(() => {}); // shown as the screen's error
    this.schedule();
    void this.refreshStale();
  }

  connect(paseo: PluginHandlerContext["paseo"]): void {
    this.paseo = paseo;
  }

  stop(): void {
    this.timer?.();
    this.timer = null;
    for (const cancel of Object.values(this.followUps)) cancel();
  }

  // ⟳ fetches its tab's feed now; otherwise feeds older than their schedule are fetched first.
  // `cached` answers from memory, with no GitHub refresh first. `timeZone` is the device's: History's weeks follow the last
  // one sent, so a new one fetches History again, once [HIS-01].
  async get(refresh?: FeedId, cached?: boolean, timeZone?: string): Promise<AttentionView> {
    const rezoned = !!timeZone && timeZone !== this.timeZone && isTimeZone(timeZone);
    if (rezoned) {
      this.state.timeZone = timeZone;
      await this.save();
    }
    const history = rezoned && refresh !== "history" ? this.refresh("history", true).catch(() => {}) : null;
    if (refresh) await this.refresh(refresh).catch(() => {});
    else if (!cached) await this.refreshStale();
    if (!cached) await history;
    return this.view();
  }

  private get timeZone(): string {
    return this.state.timeZone ?? "UTC";
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
    await this.save();
    return this.view();
  }

  // Keep open: Wrap up stops asking to close the issue until another PR of mine merges under it; `on: false` is its Undo.
  // Nothing changes on GitHub [ATT-24].
  async keepOpen(key: string, on: boolean): Promise<AttentionView> {
    const ask = this.state.history?.asks.find((candidate) => candidate.key === key);
    if (on && ask) this.state.keptOpen[key] = ask.mergedAt;
    if (!on) delete this.state.keptOpen[key];
    await this.save();
    return this.view();
  }

  // Clears Changed by others notes, or brings them back for Undo; nothing changes on GitHub [HIS-07].
  async gotIt(ids: string[], on: boolean): Promise<AttentionView> {
    const gotIt = this.state.changes.gotIt.filter((other) => !ids.includes(other));
    const known = ids.filter((id) => this.state.changes.events.some((event) => event.id === id));
    this.state.changes.gotIt = on ? [...gotIt, ...known] : gotIt;
    await this.save();
    return this.view();
  }

  async restoreDismissed(): Promise<AttentionView> {
    this.state.dismissed = {};
    await this.save();
    return this.view();
  }

  // Reviewed and Changed by others in each of History's weeks [HIS-07].
  async setHistoryFilter(filter: HistoryFilter[]): Promise<AttentionView> {
    this.state.historyFilter = [...new Set(filter)];
    await this.save();
    return this.view();
  }

  // Archive acknowledges exactly the events on the work at that moment, including ones a refresh added meanwhile; `upTo`
  // leaves out what came after then [HIS-07, ATT-22].
  async acknowledge(keys: string[], upTo?: string): Promise<AttentionView> {
    this.state.changes = acknowledge(this.state.changes, keys, upTo);
    await this.save();
    return this.view();
  }

  // The keys of the item's whole stack or issue group: its own members, as GitHub spells them, since Paseo's labels match
  // exactly, plus what was remembered while it was open [ATT-22, ATT-04].
  groupKeysOf(itemKey: string): string[] {
    const wanted = itemKey.toLowerCase();
    const view = this.view();
    const items = [...view.history, ...(view.ownClosed ?? []), ...view.doing.flatMap((section) => section.items), ...view.waiting.flatMap((group) => group.items)];
    const found = items.map(memberKeys).filter((keys) => keySet(keys).has(wanted)).flat();
    return uniqueKeys([itemKey, ...found, ...(this.state.groups[wanted]?.keys ?? [])]);
  }

  // Archive a Wrap up row's sessions; success acknowledges the events on that work, so they go to their week as cleared, not
  // History's unread notes [ATT-22, HIS-07]. A failure leaves the row to try again.
  // A worktree that stayed keeps its row, as a kept row [ATT-22].
  async archive(paseo: PluginHandlerContext["paseo"], targets: ArchiveTarget[], confirm: boolean, terminals: string[] = []): Promise<ArchiveOutcome> {
    const answer = await this.port.paseo.archive(paseo, targets.flatMap((target) => target.agentIds), confirm, terminals, []);
    if (!answer.ok) return { ...answer, view: this.view() };
    this.remember(answer.kept, (kept) => targets.find((target) => target.agentIds.some((id) => kept.sessionIds.includes(id))));
    const view = await this.acknowledge(targets.flatMap((target) => target.keys));
    return { ...answer, view };
  }

  // A kept worktree tried again on its own, with the same checks; it stays kept, perhaps for a new reason, until it goes.
  async archiveWorktree(paseo: PluginHandlerContext["paseo"], workspaceId: string, confirm: boolean, terminals: string[] = []): Promise<ArchiveOutcome> {
    const row = this.state.kept.find((kept) => kept.workspaceId === workspaceId);
    const answer = await this.port.paseo.archive(paseo, [], confirm, terminals, [workspaceId]);
    if (!answer.ok) return { ...answer, view: this.view() };
    this.state.kept = this.state.kept.filter((kept) => kept.workspaceId !== workspaceId);
    if (row) this.remember(answer.kept, () => row);
    await this.save();
    return { ...answer, view: this.view() };
  }

  // Dismiss on a kept row: the worktree stays, and so does Paseo's sidebar entry; Wrap up stops showing it [ATT-22].
  async dismissKept(workspaceId: string): Promise<AttentionView> {
    await this.forgetKept(workspaceId);
    return this.view();
  }

  // A kept worktree archived anywhere, Paseo's sidebar included, takes its row with it [ATT-22]. Remembered, so an archive
  // still running that keeps it afterwards doesn't bring the row back.
  async forgetKept(workspaceId: string): Promise<void> {
    this.archivedWorkspaces.add(workspaceId);
    if (!this.state.kept.some((kept) => kept.workspaceId === workspaceId)) return;
    this.state.kept = this.state.kept.filter((kept) => kept.workspaceId !== workspaceId);
    await this.save();
  }

  private remember(kept: KeptWorktree[], rowOf: (kept: KeptWorktree) => Pick<KeptRow, "itemKey" | "title" | "repo" | "number" | "kind"> | undefined): void {
    const at = new Date(this.port.now()).toISOString();
    for (const found of kept) {
      const row = rowOf(found);
      if (!row || this.archivedWorkspaces.has(found.workspaceId)) continue;
      const { sessionIds, ...worktree } = found;
      const { itemKey, title, repo, number, kind } = row;
      this.state.kept = [...this.state.kept.filter((other) => other.workspaceId !== worktree.workspaceId), { ...worktree, itemKey, title, repo, number, kind, at }];
    }
  }

  // Remember where an issue repo's code lives [SES-07].
  async setCodeRepo(issueRepo: string, codeRepo: string): Promise<AttentionView> {
    this.config = await this.port.store.saveCodeRepo(issueRepo, codeRepo);
    return this.view();
  }

  // Orgs and repos chosen in settings [SRC-02]. The lists follow right away; History catches up behind them.
  async setCoverage(orgs: string[], repos: string[]): Promise<void> {
    this.config = await this.port.store.saveCoverage(orgs, repos);
    void this.refresh("history").catch(() => {});
    await this.refresh("live").catch(() => {});
  }

  // Where Next up looks, chosen in settings [NXT-04]. Only the live feed has Next up.
  async setNextUpSources(sources: Pick<AttentionConfig["nextUp"], "mine" | "orgs" | "repos">): Promise<void> {
    this.config = await this.port.store.saveNextUpSources(sources);
    await this.refresh("live").catch(() => {});
  }

  // Which org issue fields Next up uses, chosen in settings [NXT-04]. Only the live feed has Next up.
  async setNextUpFields(fields: Partial<Record<FieldRole, string | null>>): Promise<void> {
    this.config = await this.port.store.saveNextUpFields(fields);
    await this.refresh("live").catch(() => {});
  }

  // The single-select fields of every org Next up might pick from, merged by name, for settings [NXT-04]:
  // the orgs chosen, the owners of the repos chosen and of my projects, and of the issues it last showed.
  async issueFields(): Promise<IssueField[]> {
    await this.reloadConfig().catch(() => {});
    const { orgs, repos, nextUp } = this.config;
    const live = this.state.live?.attention;
    const shown = [...(live?.unclaimed ?? []), ...(live?.assigned ?? [])].map((issue) => issue.repo);
    const owners = [...orgs, ...nextUp.orgs, ...[...repos, ...nextUp.repos, ...this.state.projectRepos, ...shown].map((repo) => repo.split("/")[0])];
    return this.port.github.issueFields(uniqueKeys(owners));
  }

  // Replies on others' threads without a tag [ATT-17]. Only the live feed has them.
  async setFollowThreads(on: boolean): Promise<void> {
    this.config = await this.port.store.saveFollowThreads(on);
    await this.refresh("live").catch(() => {});
  }

  // Only questions wait [WAI-01]. Only the live feed has threads.
  async setOnlyQuestionsWait(on: boolean): Promise<void> {
    this.config = await this.port.store.saveOnlyQuestionsWait(on);
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

  // What the New issue sheet starts with next time [ISS-01].
  async setNewIssueChoice(repo: string, profileId: string | null): Promise<void> {
    this.state.newIssue = { repo, profileId };
    await this.save();
  }

  async setProjectFilter(projects: string[]): Promise<void> {
    this.state.projectFilter = projects;
    await this.save();
  }

  // Not a filter, so Clear leaves it [NXT-14]. Answered with the view, so a refresh that read the old choice can't undo it.
  async setUnclaimedByRepo(on: boolean): Promise<AttentionView> {
    this.state.unclaimedByRepo = on;
    await this.save();
    return this.view();
  }

  // "Not now" on an update notice holds until a newer one [UPD-01].
  get skippedUpdate(): string | null {
    return this.state.skippedUpdate;
  }

  async skipUpdate(latest: string): Promise<void> {
    this.state.skippedUpdate = latest;
    await this.save();
  }

  // Who reviewed or was asked on my PRs in a repo, from the last fetch, and who I am [PRS-12].
  reviewers(repo: string): { recent: Reviewer[]; login: string | null } {
    const live = this.state.live?.attention;
    return { recent: live?.reviewers?.[repo] ?? [], login: live?.login ?? null };
  }

  // A change on GitHub from one tap [SAFE-01], answered with the list as it is after it.
  // GitHub's search takes seconds to show it, so its effect shows until a fetch can [FRESH-02]; no change (Undo) clears it.
  async act(key: string, work: () => Promise<void>, change: Change): Promise<AttentionView> {
    await work();
    const before = this.state.pending[key];
    const wasClosed = key in this.state.closedAsks;
    const at = new Date(this.port.now()).toISOString();
    if (change) this.state.pending[key] = { at, effect: change.kind === "finished" ? this.finished(key, at, change.notPlanned) : change };
    else delete this.state.pending[key];
    // History's search only finds closed issues assigned to me, so one Wrap up asked to close is kept here, its merged PRs
    // under it, for its week and its sessions' row; Undo forgets it [ATT-24, HIS-01].
    const effect = this.state.pending[key]?.effect;
    if (effect?.kind === "done" && this.state.history?.asks.some((ask) => ask.key === key)) this.state.closedAsks[key] = effect.item;
    else if (!change) delete this.state.closedAsks[key];
    await this.save();
    // Undo of a close brings back its ask once History is fetched, even after the close stopped pending [ATT-24].
    const history = change?.kind === "finished" || before?.effect.kind === "done" || (!change && wasClosed);
    this.followUp("live");
    if (history) this.followUp("history");
    return this.view();
  }

  // Into History if it's mine: a PR in my lists, or an issue assigned to me [HIS-01]. Else just off the lists.
  private finished(key: string, at: string, notPlanned?: boolean): Effect {
    const live = this.state.live?.attention;
    const source = live?.items.find((item) => item.key === key) ?? live?.assigned.find((issue) => issue.key === key);
    const ask = this.state.history?.asks.find((candidate) => candidate.key === key);
    // An issue Wrap up asked to close keeps my merged PRs under it, assigned to me or not [ATT-24, HIS-01].
    if (ask) return { kind: "done", item: { ...doneItem(source ?? this.askItem(ask), at, notPlanned), children: notPlanned ? [] : ask.prs } };
    return source ? { kind: "done", item: doneItem(source, at, notPlanned) } : { kind: "gone" };
  }

  // An issue Wrap up asked to close, not in the live feed's lists [ATT-24].
  private askItem(ask: CloseAsk): Item {
    return baseItem({ key: ask.key, section: "done", kind: "issue", repo: ask.repo, number: ask.number, title: ask.title, url: ask.url });
  }

  // A PR of mine the live feed saw merged, which History doesn't list yet, perhaps merged on GitHub: History is fetched
  // once its search has caught up, once per PR [FRESH-03]. Until then the live feed's own entry stands in (ownClosed).
  private followMerges(): void {
    const listed = new Set((this.state.history?.items ?? []).flatMap((item) => [item.key, ...item.children.map((child) => child.key)]).map((key) => key.toLowerCase()));
    const merged = (this.state.live?.attention.ownClosed ?? []).filter((item) => !item.closedUnmerged).map((item) => item.key.toLowerCase());
    // Kept only while the live feed still lists them, so the record stays as small as its recent closes.
    this.historyAskedFor = new Set(merged.filter((key) => this.historyAskedFor.has(key)));
    const unseen = merged.filter((key) => !listed.has(key) && !this.historyAskedFor.has(key));
    if (unseen.length === 0) return;
    for (const key of unseen) this.historyAskedFor.add(key);
    this.followUp("history");
  }

  // One fetch once GitHub's search has caught up with the latest change, which ends what's pending.
  private followUp(id: FeedId): void {
    this.followUps[id]?.();
    this.followUps[id] = this.port.setTimer(() => void this.refresh(id, true).catch(() => {}), SETTLE_MS);
  }

  // Concurrent callers share one refresh per feed. `fresh` won't share one that began before the call, which can't show a change just made.
  refresh(id: FeedId, fresh = false): Promise<void> {
    const feed = this.feeds[id];
    if (fresh && feed.inFlight) {
      feed.next ??= feed.inFlight.catch(() => {}).then(() => ((feed.next = null), this.refresh(id)));
      return feed.next;
    }
    feed.inFlight ??= this.fetch(id).finally(() => (feed.inFlight = null));
    return feed.inFlight;
  }

  private refreshStale(): Promise<unknown> {
    const stale = (["live", "history"] as const).filter((id) => this.isStale(id));
    return Promise.all(stale.map((id) => this.refresh(id).catch(() => {})));
  }

  private async fetch(id: FeedId): Promise<void> {
    const feed = this.feeds[id];
    feed.lastAttemptAt = this.port.now();
    try {
      await this.reloadConfig();
      const now = new Date(this.port.now());
      const fetchedAt = now.toISOString();
      if (id === "live") {
        this.state.live = { fetchedAt, attention: await this.fetchLive(now) };
        this.state.groups = rememberGroups(this.state.groups, this.state.live.attention.items, now, Math.max(this.config.mentionDays, this.config.historyWeeks * 7 + 7));
        this.followMerges();
      }
      else {
        const { open, ...history } = await this.fetchHistory(now);
        this.state.history = { fetchedAt, ...history };
        // Keep open, and an issue closed when asked, last as long as History's weeks: an ask missing from one fetch, while
        // someone's PR is open or a lookup failed, may come back. A closed one History lists itself needs no keeping [ATT-24].
        const since = historySince(now, this.config.historyWeeks, this.timeZone);
        for (const [key, mergedAt] of Object.entries(this.state.keptOpen)) if (mergedAt < since) delete this.state.keptOpen[key];
        const listed = new Set(this.state.history.items.map((item) => item.key));
        // Reopened on GitHub, it's open again: only a lookup that answered says so, so a failed one keeps it.
        for (const [key, item] of Object.entries(this.state.closedAsks)) if (listed.has(key) || open.has(key) || (item.closedAt ?? "") < since) delete this.state.closedAsks[key];
      }
      // Forget dismissals of items that are gone.
      const keys = new Set(this.items().map((item) => item.key));
      for (const key of Object.keys(this.state.dismissed)) if (!keys.has(key)) delete this.state.dismissed[key];
      // And changes GitHub now shows for itself.
      for (const [key, pending] of Object.entries(this.state.pending)) if (!isPending(pending, this.fetchedAt(), this.port.now())) delete this.state.pending[key];
      feed.error = null;
      await this.save();
    } catch (error) {
      feed.error = (error as Error).message;
      console.error(`Attention Span ${id} refresh failed:`, feed.error);
      throw error;
    }
  }

  private async fetchLive(now: Date): Promise<Attention> {
    const projectRepos = await this.projectRepos();
    const login = this.config.nextUp.mine ? await this.login() : null;
    const unclaimed = unclaimedSearches(this.config, projectRepos, login);
    const { data, details } = await this.searchLive(now, unclaimed.searches);
    this.state.changes = await this.port.github.changes(this.state.changes, data, now, this.config, () => this.state.changes.gotIt);
    const own = ownClosed(data, data.viewer.login);
    const askOff = await this.askOff();
    return { ...classify({ data, details, config: this.config, now }), unclaimedFrom: unclaimed.from, ...(own.length ? { ownClosed: own } : {}), ...(askOff.length ? { askOff } : {}) };
  }

  // History is fetched daily, so the issues it asks about are looked up again with each live refresh: one closed since,
  // or with anyone's PR open for it, stops asking until History says otherwise [ATT-24, GH-01]. One that can't be looked
  // up keeps asking.
  private async askOff(): Promise<string[]> {
    const asks = this.state.history?.asks ?? [];
    if (asks.length === 0) return [];
    const found = await this.port.github.issues(asks.map((ask) => ({ repo: ask.repo, number: ask.number }))).catch(() => ({}) as Record<string, ReferencedIssue>);
    return asks
      .filter((ask) => {
        const issue = Object.entries(found).find(([key]) => key.toLowerCase() === ask.key.toLowerCase())?.[1];
        return issue && (issue.state !== "OPEN" || (issue.closedByPullRequestsReferences?.nodes ?? []).some((pr) => pr.state === "OPEN"));
      })
      .map((ask) => ask.key);
  }

  // The account gh is signed in as, for My repos [NXT-04]. Asked once, unless the last fetch already says.
  private async login(): Promise<string> {
    return this.state.live?.attention.login || (await this.port.github.login());
  }

  // My Paseo projects' GitHub repos, where Next up looks when no repos are chosen [NXT-08].
  // Without a connection yet, or if listing fails, the last list is used.
  private async projectRepos(): Promise<string[]> {
    if (this.paseo) {
      try {
        this.state.projectRepos = await this.port.paseo.projectRepos(this.paseo);
      } catch (error) {
        console.error("Couldn't list Paseo projects:", error);
      }
    }
    return this.state.projectRepos;
  }

  // History, the issues to ask about closing, and which issues my merged PRs refer to were found open [ATT-24].
  private async fetchHistory(now: Date): Promise<{ items: Item[]; asks: CloseAsk[]; open: Set<string> }> {
    const data = await this.port.github.history(this.config, now, this.timeZone);
    const open = new Set(Object.entries(data.referenced ?? {}).flatMap(([key, issue]) => (issue.state === "OPEN" ? [key] : [])));
    return { items: classifyHistory(data), asks: classifyCloseAsks(data), open };
  }

  // Whether the gh login may read projects, asked at most hourly, or now when Settings asks [NXT-12]. On only when GitHub
  // actually returns the viewer's projects, as a partial answer with errors isn't a yes. Any attempt counts toward the
  // hour, so an outage doesn't add a probe to every refresh, and it's given PROBE_TIMEOUT_MS, so a stuck gh can't hold up
  // the refresh waiting on it. Settings and a refresh asking at once share one probe [GH-01].
  // What went wrong reading projects on the last refresh, while they're on, like boards an org's SSO hides, rides along for
  // Settings; a later probe that works doesn't clear it, only a refresh that reads them cleanly.
  async projectsAccess(force = false): Promise<ProjectsAccess> {
    const access = await this.probeProjects(force);
    return this.projectsWarning ? { ...access, warning: this.projectsWarning } : access;
  }

  private async probeProjects(force: boolean): Promise<ProjectsAccess> {
    if (this.projectsProbe) return this.projectsProbe;
    if (!force && this.port.now() - this.projects.checkedAt < PROJECTS_CHECK_MS) return this.projects.access;
    this.projectsProbe = (async () => {
      const answer = probeAnswer(await this.port.github.probeProjects(), this.projects.access.state);
      if (answer.error) console.error("Couldn't read projects:", answer.error);
      this.projects = { access: { ...answer, token: tokenSource() }, checkedAt: this.port.now() };
      return this.projects.access;
    })().finally(() => (this.projectsProbe = null));
    return this.projectsProbe;
  }

  // The live searches, reading projects when they can, and what went wrong with them for Settings [NXT-12].
  private async searchLive(now: Date, unclaimed: UnclaimedSearch[]): Promise<{ data: LiveResult; details: Details }> {
    const on = (await this.probeProjects(false)).state === "on";
    // What goes wrong reading projects this refresh.
    const problems: string[] = [];
    const failed = (failure: string) => (this.projects = { access: { ...projectsFailure(failure), token: tokenSource() }, checkedAt: this.port.now() });
    try {
      const found = await this.port.github.live(this.config, now, unclaimed, { on, problems, failed });
      if (on) this.projectsWarning = projectsWarning(problems);
      return found;
    } catch (error) {
      // Another search failing doesn't lose what went wrong with projects so far; it can't say they went well either.
      if (on && problems.length) this.projectsWarning = projectsWarning(problems);
      throw error;
    }
  }

  private async reloadConfig(): Promise<void> {
    try {
      this.config = await this.port.store.loadConfig();
      this.configError = null;
    } catch (error) {
      this.configError = (error as Error).message;
      throw error;
    }
    if (this.timer && this.intervalMinutes !== this.config.refreshMinutes) this.schedule();
  }

  // A new refreshMinutes restarts the schedule; follow-ups already waiting still run.
  private schedule(): void {
    this.timer?.();
    this.intervalMinutes = this.config.refreshMinutes;
    const tick = () => {
      this.timer = this.port.setTimer(tick, this.intervalMinutes * 60_000);
      void this.refresh("live").catch(() => {});
      if (this.isStale("history")) void this.refresh("history").catch(() => {});
    };
    this.timer = this.port.setTimer(tick, this.intervalMinutes * 60_000);
  }

  // Older than the feed's schedule, and not failed within the last few minutes.
  private isStale(id: FeedId): boolean {
    const maxAgeSeconds = id === "live" ? this.config.refreshMinutes * 60 : HISTORY_MAX_AGE_SECONDS;
    const fetchedAt = this.state[id]?.fetchedAt;
    const now = this.port.now();
    const old = !fetchedAt || now - new Date(fetchedAt).getTime() >= maxAgeSeconds * 1000;
    return old && now - this.feeds[id].lastAttemptAt >= RETRY_MS;
  }

  private items(): Item[] {
    return [...(this.state.live?.attention.items ?? []), ...(this.state.history?.items ?? [])];
  }

  // Feeds finish independently; saves go one at a time so an older snapshot never lands last.
  private save(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(() => this.port.store.saveState(this.state));
    return this.saving;
  }

  private fetchedAt(): Record<FeedId, string | null> {
    return { live: this.state.live?.fetchedAt ?? null, history: this.state.history?.fetchedAt ?? null };
  }

  // The repositories the New issue sheet offers: the ones covered, from my projects and what's on screen [ISS-01].
  private newIssueRepos(attention: Attention | null): string[] {
    const shown = [...(attention?.items ?? []), ...(this.state.history?.items ?? [])].map((item) => item.repo);
    const issues = [...(attention?.unclaimed ?? []), ...(attention?.assigned ?? [])].map((issue) => issue.repo);
    return newIssueRepos(this.config, this.state.projectRepos, [...shown, ...issues], attention?.login ?? null);
  }

  // History's asks, less those kept open since their latest merge, and an issue I just closed until History shows it [ATT-24].
  private closeAsks(pending: Record<string, Pending>): CloseAsk[] {
    const off = (key: string) => ["done", "gone"].includes(pending[key]?.effect.kind ?? "");
    return (this.state.history?.asks ?? []).filter((ask) => !off(ask.key) && !((this.state.keptOpen[ask.key] ?? "") >= ask.mergedAt));
  }

  // History as fetched, with the issues closed when Wrap up asked, which its search can't find, and their PRs under them
  // rather than alone [ATT-24, HIS-01].
  private historyItems(): Item[] {
    const items = this.state.history?.items ?? [];
    const listed = new Set(items.map((item) => item.key));
    const closed = Object.values(this.state.closedAsks).filter((item) => !listed.has(item.key));
    const under = new Set(closed.flatMap((item) => item.children.map((child) => child.key)));
    return [...closed, ...items.filter((item) => !under.has(item.key))];
  }

  private view(): AttentionView {
    const status = (id: FeedId): FeedStatus => ({
      fetchedAt: this.state[id]?.fetchedAt ?? null,
      refreshing: this.feeds[id].inFlight !== null,
      error: this.feeds[id].error ?? this.configError,
    });
    const now = this.port.now();
    const pending = Object.fromEntries(Object.entries(this.state.pending).filter(([, entry]) => isPending(entry, this.fetchedAt(), now)));
    const shown = applyPending(this.state.live?.attention ?? null, this.historyItems(), pending);
    return buildView(
      shown.attention,
      shown.history,
      this.state.dismissed,
      {
      feeds: { live: status("live"), history: status("history") },
      scopes: this.state.scopes,
      sources: this.state.sources,
      projectFilter: this.state.projectFilter,
      unclaimedByRepo: this.state.unclaimedByRepo,
      historyFilter: this.state.historyFilter,
      groups: Object.fromEntries(Object.entries(this.state.groups).map(([key, group]) => [key, group.keys])),
      config: this.config,
      pending: Object.keys(pending).length,
      newIssue: { repos: this.newIssueRepos(shown.attention), ...this.state.newIssue },
      kept: this.state.kept,
      closeAsks: this.closeAsks(pending),
      },
      this.state.changes,
      new Date(now),
      this.timeZone,
    );
  }
}
