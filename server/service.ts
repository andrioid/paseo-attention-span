import type { Attention, AttentionView, FeedId, FeedStatus, GithubColor, HistoryFilter, Item, ProjectsAccess, Reviewer } from "../shared/attention";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AttentionConfig, type FieldRole, githubRepoOf, nextUpField } from "../shared/config";
import type { IssueField } from "../shared/setup";
import type { ArchiveOutcome, ArchiveTarget } from "../shared/archive";
import { archiveSessions } from "./archive";
import { acknowledge, changeCandidates, nextLedger, type Lookups, type ReopenLookups, reopenCandidates, withGotIt } from "./changes";
import { classify, classifyHistory, issueBoardIds } from "./classify";
import { probeAnswer, projectsFailure, projectsWarning, searchWithProjects } from "./projects";
import { FIXTURE, graphql, graphqlResult } from "./gh";
import { fixture, FIXTURE_AGENTS, FIXTURE_ISSUE_FIELDS, fixtureChanges, fixtureGotIt } from "./fixture";
import type { AssignmentSubject, Details, HistoryResult, LinkedIssue, LiveResult, MergeStateStatus, PullRequestNode, ReopenSubject } from "./github-types";
import {
  ASSIGNMENT_BATCH,
  assignmentsQuery,
  type CheckContext,
  detailsQuery,
  HISTORY_SEARCHES,
  issueFieldsQuery,
  type OrgFields,
  MERGE_STATE_BATCH,
  mergeStateQuery,
  mergeUnclaimed,
  prKey,
  PROJECTS_PROBE,
  projectStatusesQuery,
  type ProjectStatusesResult,
  reopenQuery,
  requiredChecks,
  type SearchName,
  searchQuery,
  searchVariables,
  type UnclaimedSearch,
  unclaimedSearches,
} from "./queries";
import { toLookUp } from "./references";
import { loadConfig, loadState, moveOldFiles, saveCodeRepo, saveCoverage, saveFollowThreads, saveNextUpFields, saveNextUpSources, saveState, State } from "./store";
import { applyPending, buildView, doneItem, type Effect, isPending, SETTLE_MS } from "./view";

// History changes only when I finish something, so it's fetched daily, on ⟳ in its tab and after a merge.
const HISTORY_MAX_AGE_SECONDS = 24 * 60 * 60;
// A failed refresh is retried at most this often, except on ⟳.
const RETRY_MS = 5 * 60_000;
// Whether projects can be read is asked again at most this often, unless Settings asks [NXT-12].
const PROJECTS_CHECK_MS = 60 * 60_000;
// The check waits this long at most, as the refresh waits on it.
const PROBE_TIMEOUT_MS = 10_000;
// A search with projects, or a batch of boards' statuses, waits this long at most before the refresh goes on without them.
const PROJECTS_SEARCH_TIMEOUT_MS = 20_000;
const BOARDS_PER_REQUEST = 50;
// Batches of boards asked at once, so many boards don't burst requests [GH-01].
const BOARD_BATCHES_AT_ONCE = 2;

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
  private config: AttentionConfig = AttentionConfig.parse({});
  private configError: string | null = null;
  private feeds: Record<FeedId, Feed> = {
    live: { inFlight: null, next: null, lastAttemptAt: 0, error: null },
    history: { inFlight: null, next: null, lastAttemptAt: 0, error: null },
  };
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private followUps: Partial<Record<FeedId, ReturnType<typeof setTimeout>>> = {};
  private intervalMinutes = 0;
  private projects: { access: ProjectsAccess; checkedAt: number } = { access: { state: "unknown", token: tokenSource() }, checkedAt: 0 };
  private projectsProbe: Promise<ProjectsAccess> | null = null;
  private projectsWarning: string | undefined;
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
    for (const timeout of Object.values(this.followUps)) clearTimeout(timeout);
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

  // Archive acknowledges exactly the events on the work at that moment, including ones a refresh added meanwhile
  // [HIS-07, ATT-22].
  async acknowledge(keys: string[]): Promise<AttentionView> {
    this.state.changes = acknowledge(this.state.changes, keys);
    await this.save();
    return this.view();
  }

  // A session on this item archived in Paseo itself, with none of its sessions left: acknowledge the events on the item's
  // whole group, as Wrap up's own archive does, so they go to their week as cleared [HIS-07, ATT-22].
  async acknowledgeItem(itemKey: string): Promise<void> {
    const wanted = itemKey.toLowerCase();
    const view = this.view();
    const items = [...view.history, ...view.doing.flatMap((section) => section.items), ...view.waiting.flatMap((group) => group.items)];
    const groupOf = (item: Item) => [item.key, ...(item.change ? [item.change.key] : []), ...item.children.map((child) => child.key)];
    const keys = new Set([itemKey, ...items.filter((item) => groupOf(item).some((key) => key.toLowerCase() === wanted)).flatMap(groupOf)]);
    await this.acknowledge([...keys]);
  }

  // Archive a Wrap up row's sessions; success acknowledges the events on that work, so they go to their week as cleared, not
  // History's unread notes [ATT-22, HIS-07]. A failure leaves the row to try again.
  async archive(paseo: PluginHandlerContext["paseo"], targets: ArchiveTarget[], confirm: boolean): Promise<ArchiveOutcome> {
    // Previews have no Paseo agents, but still acknowledge, so their screenshots can show the cleanup.
    if (FIXTURE) return { ok: true, view: await this.acknowledge(targets.flatMap((target) => target.keys)) };
    const answer = await archiveSessions(paseo, targets, confirm);
    if (!answer.ok) return { ...answer, view: this.view() };
    return { ok: true, view: await this.acknowledge(targets.flatMap((target) => target.keys)) };
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

  // Which org issue fields Next up uses, chosen in settings [NXT-04]. Only the live feed has Next up.
  async setNextUpFields(fields: Partial<Record<FieldRole, string | null>>): Promise<void> {
    this.config = await saveNextUpFields(fields);
    await this.refresh("live").catch(() => {});
  }

  // The single-select fields of every org Next up might pick from, merged by name, for settings [NXT-04]:
  // the orgs chosen, the owners of the repos chosen and of my projects, and of the issues it last showed.
  async issueFields(): Promise<IssueField[]> {
    if (FIXTURE) return FIXTURE_ISSUE_FIELDS;
    await this.reloadConfig().catch(() => {});
    const { orgs, repos, nextUp } = this.config;
    const live = this.state.live?.attention;
    const shown = [...(live?.unclaimed ?? []), ...(live?.assigned ?? [])].map((issue) => issue.repo);
    const owners = [...orgs, ...nextUp.orgs, ...[...repos, ...nextUp.repos, ...this.state.projectRepos, ...shown].map((repo) => repo.split("/")[0])];
    const unique = [...new Map(owners.map((owner) => [owner.toLowerCase(), owner])).values()];
    if (unique.length === 0) return [];
    const result = await graphql<Record<string, OrgFields>>(issueFieldsQuery(unique));
    const merged = new Map<string, IssueField>();
    unique.forEach((org, index) => {
      for (const field of result[`o${index}`]?.issueFields?.nodes ?? []) {
        if (!field.name || !field.options) continue;
        const known = merged.get(field.name.toLowerCase());
        if (known) known.orgs.push(org);
        else merged.set(field.name.toLowerCase(), { name: field.name, options: field.options.map((option) => option.name), orgs: [org] });
      }
    });
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Replies on others' threads without a tag [ATT-17]. Only the live feed has them.
  async setFollowThreads(on: boolean): Promise<void> {
    this.config = await saveFollowThreads(on);
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

  async setProjectFilter(projects: string[]): Promise<void> {
    this.state.projectFilter = projects;
    await this.save();
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
    const at = new Date().toISOString();
    if (change) this.state.pending[key] = { at, effect: change.kind === "finished" ? this.finished(key, at, change.notPlanned) : change };
    else delete this.state.pending[key];
    await this.save();
    const history = change?.kind === "finished" || before?.effect.kind === "done";
    this.followUp("live");
    if (history) this.followUp("history");
    return this.view();
  }

  // Into History if it's mine: a PR in my lists, or an issue assigned to me [HIS-01]. Else just off the lists.
  private finished(key: string, at: string, notPlanned?: boolean): Effect {
    const live = this.state.live?.attention;
    const source = live?.items.find((item) => item.key === key) ?? live?.assigned.find((issue) => issue.key === key);
    return source ? { kind: "done", item: doneItem(source, at, notPlanned) } : { kind: "gone" };
  }

  // One fetch once GitHub's search has caught up with the latest change, which ends what's pending.
  private followUp(id: FeedId): void {
    clearTimeout(this.followUps[id]);
    this.followUps[id] = setTimeout(() => void this.refresh(id, true).catch(() => {}), SETTLE_MS);
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
      // And changes GitHub now shows for itself.
      for (const [key, pending] of Object.entries(this.state.pending)) if (!isPending(pending, this.fetchedAt(), Date.now())) delete this.state.pending[key];
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
    await this.trackChanges(data, now);
    return { ...classify({ data, details, config: this.config, now }), unclaimedFrom: unclaimed.from };
  }

  // What others did to my work since the last refresh [HIS-07]. Only PRs whose hands changed and issues that left my assigned
  // search are looked up, a batch per request; a failed batch is asked again next time [GH-01]. Kept long enough for History.
  private async trackChanges(data: LiveResult, now: Date): Promise<void> {
    const ledger = this.state.changes;
    if (FIXTURE) {
      // Previews start each layout with a refresh, which brings the notes back: Got it would otherwise outlive a layout.
      this.state.changes = { ...ledger, events: fixtureChanges(now), gotIt: fixtureGotIt(now) };
      return;
    }
    const me = data.viewer.login;
    const candidates = changeCandidates(ledger, data, me);
    const lookups: Lookups = new Map();
    for (let at = 0; at < candidates.length; at += ASSIGNMENT_BATCH) {
      const batch = candidates.slice(at, at + ASSIGNMENT_BATCH);
      try {
        const { data: result, failures } = await graphqlResult<Record<string, AssignmentSubject | null>>(assignmentsQuery(batch));
        batch.forEach((id, index) => {
          const alias = `a${index}`;
          // A node GitHub can't find is gone for good; one it failed on is asked again next refresh.
          const failed = failures.some((failure) => failure.path?.[0] === alias && failure.type !== "NOT_FOUND");
          if (!failed) lookups.set(id, result?.[alias] ?? null);
        });
      } catch (error) {
        console.error("Couldn't look up who changed my work:", (error as Error).message);
      }
    }
    const reopens = await this.reopenLookups(reopenCandidates(ledger, data));
    const keepDays = Math.max(this.config.mentionDays, this.config.historyWeeks * 7 + 7);
    // A Got it tapped, or an archive acknowledging, while this refresh ran still counts.
    this.state.changes = withGotIt(nextLedger(ledger, data, me, lookups, now, this.config.mentionDays, keepDays, reopens), this.state.changes.gotIt);
  }

  // PRs Attention Span saw closed, asked about a batch per request so a reopen by someone else is noticed [HIS-07, GH-01].
  // A batch that fails leaves its PRs tracked for the next refresh; one GitHub can't find is gone.
  private async reopenLookups(candidates: string[]): Promise<ReopenLookups> {
    const lookups: ReopenLookups = new Map();
    for (let at = 0; at < candidates.length; at += ASSIGNMENT_BATCH) {
      const batch = candidates.slice(at, at + ASSIGNMENT_BATCH);
      try {
        const { data, failures } = await graphqlResult<Record<string, ReopenSubject | null>>(reopenQuery(batch));
        batch.forEach((id, index) => {
          const alias = `a${index}`;
          const failed = failures.some((failure) => failure.path?.[0] === alias && failure.type !== "NOT_FOUND");
          if (!failed) lookups.set(id, data?.[alias] ?? null);
        });
      } catch (error) {
        console.error("Couldn't check whether a closed PR reopened:", (error as Error).message);
      }
    }
    return lookups;
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
    return classifyHistory(await graphql<HistoryResult>(searchQuery(HISTORY_SEARCHES, true), this.variables(HISTORY_SEARCHES, now)));
  }

  // Whether the gh login may read projects, asked at most hourly, or now when Settings asks [NXT-12]. On only when GitHub
  // actually returns the viewer's projects, as a partial answer with errors isn't a yes. Any attempt counts toward the
  // hour, so an outage doesn't add a probe to every refresh, and it's given PROBE_TIMEOUT_MS, so a stuck gh can't hold up
  // the refresh waiting on it. Settings and a refresh asking at once share one probe [GH-01].
  // What went wrong reading projects on the last refresh, while they're on, like boards an org's SSO hides, rides along for
  // Settings; a later probe that works doesn't clear it, only a refresh that reads them cleanly.
  async projectsAccess(force = false): Promise<ProjectsAccess> {
    if (FIXTURE) return { state: "on", token: "gh" };
    const access = await this.probeProjects(force);
    return this.projectsWarning ? { ...access, warning: this.projectsWarning } : access;
  }

  private async probeProjects(force: boolean): Promise<ProjectsAccess> {
    if (this.projectsProbe) return this.projectsProbe;
    if (!force && Date.now() - this.projects.checkedAt < PROJECTS_CHECK_MS) return this.projects.access;
    this.projectsProbe = (async () => {
      const result = await graphqlResult<{ viewer: { projectsV2: unknown } | null }>(PROJECTS_PROBE, {}, { timeoutMs: PROBE_TIMEOUT_MS }).catch((error: Error) => error);
      const answer = probeAnswer(result, this.projects.access.state);
      if (answer.error) console.error("Couldn't read projects:", answer.error);
      this.projects = { access: { ...answer, token: tokenSource() }, checkedAt: Date.now() };
      return this.projects.access;
    })().finally(() => (this.projectsProbe = null));
    return this.projectsProbe;
  }

  // One request per search, in parallel. The details request starts once the searches it needs are back [GH-01].
  private async searchLive(now: Date, unclaimed: UnclaimedSearch[]): Promise<{ data: LiveResult; details: Details }> {
    const all = searchVariables(this.config, now);
    // Next up's searches read projects too, when they can [NXT-12]. Projects are extra, so they can never cost the search:
    // whatever goes wrong with them (the scope gone since the check, an org's SSO, no results at all), the search runs again
    // without them and Settings says why. Boards the token can't see come back empty and are left out.
    const projects = (await this.probeProjects(false)).state === "on";
    // What goes wrong reading projects this refresh, for Settings.
    const problems: string[] = [];
    const pickable = async <K extends "assigned" | "unclaimed">(name: K, query: string): Promise<Pick<LiveResult, K>> => {
      const plain = () => graphql<Pick<LiveResult, K>>(searchQuery([name]), { [name]: query });
      if (!projects) return plain();
      // Bounded, so a stuck request falls back rather than hold up the refresh.
      const withProjects = () => graphqlResult<Pick<LiveResult, K>>(searchQuery([name], false, { projects }), { [name]: query }, { timeoutMs: PROJECTS_SEARCH_TIMEOUT_MS });
      const { data, failure, partly } = await searchWithProjects(withProjects, plain, (result) => !!result[name]);
      for (const problem of [partly, failure]) if (problem) (problems.push(problem), console.error(`Next up's ${name} search with projects:`, problem));
      if (failure) this.projects = { access: { ...projectsFailure(failure), token: tokenSource() }, checkedAt: Date.now() };
      return data;
    };
    const search = (name: keyof typeof all): Promise<Partial<LiveResult>> =>
      name === "assigned" ? pickable(name, all[name]) : graphql<Partial<LiveResult>>(searchQuery([name], name === "mine"), { [name]: all[name] });
    // One per Next up source [NXT-09].
    const searchUnclaimed = async (): Promise<Partial<LiveResult>> => {
      const results = await Promise.all(unclaimed.map(async ({ source, query }) => ({ source, nodes: (await pickable("unclaimed", query)).unclaimed.nodes })));
      return { unclaimed: { nodes: mergeUnclaimed(results) } };
    };
    const merge = (parts: Partial<LiveResult>[]) => Object.assign({}, ...parts) as LiveResult;
    const forDetails = Promise.all([search("mine"), search("assigned"), searchUnclaimed()]);
    const others = Promise.all([search("reviews"), search("mentions"), search("involved"), search("asked"), search("ended"), search("closedIssues")]);
    const afterThem = forDetails.then((parts) => this.details(merge(parts), projects, problems));
    try {
      const [first, rest, details] = await Promise.all([forDetails, others, afterThem]);
      if (projects) this.projectsWarning = projectsWarning(problems);
      return { data: merge([...first, ...rest]), details };
    } catch (error) {
      // Another search failing doesn't lose what went wrong with projects so far; it can't say they went well either.
      if (projects && problems.length) this.projectsWarning = projectsWarning(problems);
      throw error;
    }
  }

  private variables(names: readonly Exclude<SearchName, "unclaimed">[], now: Date): Record<string, string> {
    const all = searchVariables(this.config, now);
    return Object.fromEntries(names.map((name) => [name, all[name]]));
  }

  // Behind counts [UPS-07], required checks [PRS-14], issue field option order [NXT-02] and colors [NXT-10], and the Status
  // options of the boards Next up's issues are on [NXT-03].
  private async details(data: Pick<LiveResult, "mine" | "assigned" | "unclaimed">, projects: boolean, problems: string[]): Promise<Details> {
    const prs = data.mine.nodes.filter((pr) => pr?.headRefName && !pr.isCrossRepository);
    // Priority's colors tint its pill, so its options are asked for even when the config orders it.
    const effort = nextUpField(this.config, "effort");
    const needsOptions = !!nextUpField(this.config, "priority") || (!!effort && !effort.order);
    const issues = [...data.unclaimed.nodes, ...data.assigned.nodes];
    const orgs = needsOptions ? [...new Set(issues.map((issue) => issue?.repository?.nameWithOwner.split("/")[0]).filter(Boolean))] : [];
    const refs = toLookUp(data.mine.nodes.filter((pr) => pr?.repository));
    const mergeStates = this.mergeStates(data.mine.nodes.filter((pr) => pr?.repository));
    const statuses = projects ? this.projectStatuses(issueBoardIds(issues), problems) : Promise.resolve({});
    const details: Details = { behind: {}, fieldOptions: {}, fieldColors: {}, projectStatuses: {}, issues: {}, checks: {}, mergeState: {} };
    if (prs.length === 0 && orgs.length === 0 && refs.length === 0) return { ...details, mergeState: await mergeStates, projectStatuses: await statuses };
    const { query, compares } = detailsQuery(prs, orgs as string[], refs);
    type Result = {
      ref?: { compare: { behindBy: number } | null } | null;
      issueFields?: { nodes: { name?: string; options?: { name: string; color?: GithubColor }[] }[] };
      issueOrPullRequest?: (LinkedIssue & { state?: string }) | null;
      pullRequest?: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] } } | null;
    } | null;
    // A reference to a repo I can't see fails only its own field.
    const result = await graphql<Record<string, Result>>(query);
    for (const [alias, value] of Object.entries(result)) {
      // Org fields come back as o0, o1, … in the order the orgs were asked for.
      const org = /^o\d+$/.test(alias) ? (orgs[Number(alias.slice(1))] as string).toLowerCase() : null;
      const behindBy = value?.ref?.compare?.behindBy;
      if (typeof behindBy === "number") details.behind[compares[alias]] = behindBy;
      const contexts = value?.pullRequest?.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes;
      if (contexts) details.checks[compares[alias]] = requiredChecks(contexts);
      for (const field of value?.issueFields?.nodes ?? []) {
        if (!org || !field.name || !field.options) continue;
        (details.fieldOptions[org] ??= {})[field.name] = field.options.map((o) => o.name);
        (details.fieldColors[org] ??= {})[field.name] = Object.fromEntries(field.options.flatMap((o) => (o.color ? [[o.name, o.color]] : [])));
      }
      const issue = value?.issueOrPullRequest; // empty for a PR
      if (issue?.state === "OPEN") details.issues[prKey(issue)] = { number: issue.number, title: issue.title, url: issue.url, repository: issue.repository };
    }
    return { ...details, mergeState: await mergeStates, projectStatuses: await statuses };
  }

  // Each board's Status options, once per board [NXT-03, GH-01]. A board that can't be read lists no statuses; the whole
  // request failing costs only the filter's statuses, never the refresh.
  // Bounded in time, so it can't hold up the refresh, in size, a batch of boards per request, and in how many go at once.
  private async projectStatuses(ids: string[], problems: string[]): Promise<Details["projectStatuses"]> {
    const batches = Array.from({ length: Math.ceil(ids.length / BOARDS_PER_REQUEST) }, (_, i) => ids.slice(i * BOARDS_PER_REQUEST, (i + 1) * BOARDS_PER_REQUEST));
    const read = async (batch: string[]) => {
      try {
        const { data, errors } = await graphqlResult<ProjectStatusesResult>(projectStatusesQuery(batch), {}, { timeoutMs: PROJECTS_SEARCH_TIMEOUT_MS });
        if (errors.length) problems.push(errors.join("; "));
        return batch.flatMap((id, index) => (data?.[`b${index}`]?.field?.options ? [[id, data[`b${index}`]!.field!.options!] as const] : []));
      } catch (error) {
        problems.push((error as Error).message);
        return [];
      }
    };
    const results: Awaited<ReturnType<typeof read>>[] = [];
    for (let at = 0; at < batches.length; at += BOARD_BATCHES_AT_ONCE) results.push(...(await Promise.all(batches.slice(at, at + BOARD_BATCHES_AT_ONCE).map(read))));
    if (problems.length) console.error("Reading projects:", problems.join("; "));
    return Object.fromEntries(results.flat());
  }

  // My PRs' merge state, a few per request in parallel, as GitHub only works it out for a few at a time; search's answer
  // for more is BLOCKED for all [PRS-13]. A request that fails leaves its PRs to search's answer.
  private async mergeStates(prs: PullRequestNode[]): Promise<Details["mergeState"]> {
    const batches = Array.from({ length: Math.ceil(prs.length / MERGE_STATE_BATCH) }, (_, i) => prs.slice(i * MERGE_STATE_BATCH, (i + 1) * MERGE_STATE_BATCH));
    const results = await Promise.all(
      batches.map(async (batch) => {
        const { query, keys } = mergeStateQuery(batch);
        const result = await graphql<Record<string, { pullRequest: { mergeStateStatus?: MergeStateStatus } | null } | null>>(query).catch(() => ({}) as Record<string, never>);
        return Object.entries(result).flatMap(([alias, value]) => (value?.pullRequest?.mergeStateStatus ? [[keys[alias], value.pullRequest.mergeStateStatus] as const] : []));
      }),
    );
    return Object.fromEntries(results.flat());
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

  private fetchedAt(): Record<FeedId, string | null> {
    return { live: this.state.live?.fetchedAt ?? null, history: this.state.history?.fetchedAt ?? null };
  }

  private view(): AttentionView {
    const status = (id: FeedId): FeedStatus => ({
      fetchedAt: this.state[id]?.fetchedAt ?? null,
      refreshing: this.feeds[id].inFlight !== null,
      error: this.feeds[id].error ?? this.configError,
    });
    const now = Date.now();
    const pending = Object.fromEntries(Object.entries(this.state.pending).filter(([, entry]) => isPending(entry, this.fetchedAt(), now)));
    const shown = applyPending(this.state.live?.attention ?? null, this.state.history?.items ?? [], pending);
    return buildView(
      shown.attention,
      shown.history,
      this.state.dismissed,
      {
      feeds: { live: status("live"), history: status("history") },
      scopes: this.state.scopes,
      sources: this.state.sources,
      projectFilter: this.state.projectFilter,
      historyFilter: this.state.historyFilter,
      config: this.config,
      pending: Object.keys(pending).length,
      ...(FIXTURE ? { fixtureAgents: FIXTURE_AGENTS } : {}),
      },
      this.state.changes,
    );
  }
}
