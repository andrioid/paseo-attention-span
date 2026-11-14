import type { GithubColor } from "../shared/attention";
import { type AttentionConfig, nextUpField } from "../shared/config";
import type { IssueField } from "../shared/setup";
import { type ChangeLedger, changeCandidates, type Lookups, nextLedger, type ReopenLookups, reopenCandidates, withGotIt } from "./changes";
import { issueBoardIds } from "./classify";
import type { graphql, graphqlResult } from "./gh";
import type { AssignmentSubject, Details, HistoryResult, LinkedIssue, LiveResult, MergeStateStatus, PullRequestNode, ReopenSubject } from "./github-types";
import { searchWithProjects } from "./projects";
import {
  ASSIGNMENT_BATCH,
  assignmentsQuery,
  type CheckContext,
  detailsQuery,
  HISTORY_SEARCHES,
  issueFieldsQuery,
  MERGE_STATE_BATCH,
  mergeStateQuery,
  mergeUnclaimed,
  type OrgFields,
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
} from "./queries";
import { toLookUp } from "./references";

// What the service asks GitHub, one request shape each [GH-01]. Previews answer from made-up data instead (fixture.ts).

export interface Gh {
  graphql: typeof graphql;
  graphqlResult: typeof graphqlResult;
}

export type ProbeResult = Awaited<ReturnType<typeof graphqlResult<{ viewer: { projectsV2: unknown } | null }>>> | Error;

// What a refresh learns about reading projects [NXT-12]: whether to, what went wrong, and a search that had to go without.
export interface ProjectsReport {
  on: boolean;
  problems: string[];
  failed(message: string): void;
}

export interface GitHub {
  // The account gh is signed in as, for My repos [NXT-04].
  login(): Promise<string>;
  // Whether the gh login may read projects [NXT-12].
  probeProjects(): Promise<ProbeResult>;
  live(config: AttentionConfig, now: Date, unclaimed: UnclaimedSearch[], projects: ProjectsReport): Promise<{ data: LiveResult; details: Details }>;
  // The ledger after what others did to my work since the last refresh [HIS-07]. `gotIt` is read once the lookups are back.
  changes(ledger: ChangeLedger, data: LiveResult, now: Date, config: AttentionConfig, gotIt: () => string[]): Promise<ChangeLedger>;
  history(config: AttentionConfig, now: Date): Promise<HistoryResult>;
  // The single-select fields of these orgs, merged by name [NXT-04].
  issueFields(owners: string[]): Promise<IssueField[]>;
}

// The check waits this long at most, as the refresh waits on it.
const PROBE_TIMEOUT_MS = 10_000;
// A search with projects, or a batch of boards' statuses, waits this long at most before the refresh goes on without them.
const PROJECTS_SEARCH_TIMEOUT_MS = 20_000;
const BOARDS_PER_REQUEST = 50;
// Batches of boards asked at once, so many boards don't burst requests [GH-01].
const BOARD_BATCHES_AT_ONCE = 2;

export function gitHub(gh: Gh): GitHub {
  return {
    login: async () => (await gh.graphql<{ viewer: { login: string } }>("{ viewer { login } }")).viewer.login,
    // Given PROBE_TIMEOUT_MS, so a stuck gh can't hold up the refresh waiting on it.
    probeProjects: () => gh.graphqlResult<{ viewer: { projectsV2: unknown } | null }>(PROJECTS_PROBE, {}, { timeoutMs: PROBE_TIMEOUT_MS }).catch((error: Error) => error),
    live: (config, now, unclaimed, projects) => searchLive(gh, config, now, unclaimed, projects),
    changes: (ledger, data, now, config, gotIt) => trackChanges(gh, ledger, data, now, config, gotIt),
    history: (config, now) => gh.graphql<HistoryResult>(searchQuery(HISTORY_SEARCHES, true), variables(config, HISTORY_SEARCHES, now)),
    issueFields: (owners) => issueFields(gh, owners),
  };
}

// One request per search, in parallel. The details request starts once the searches it needs are back [GH-01].
export async function searchLive(gh: Gh, config: AttentionConfig, now: Date, unclaimed: UnclaimedSearch[], projects: ProjectsReport): Promise<{ data: LiveResult; details: Details }> {
  const all = searchVariables(config, now);
  // Next up's searches read projects too, when they can [NXT-12]. Projects are extra, so they can never cost the search:
  // whatever goes wrong with them (the scope gone since the check, an org's SSO, no results at all), the search runs again
  // without them and Settings says why. Boards the token can't see come back empty and are left out.
  const pickable = async <K extends "assigned" | "unclaimed">(name: K, query: string): Promise<Pick<LiveResult, K>> => {
    const plain = () => gh.graphql<Pick<LiveResult, K>>(searchQuery([name]), { [name]: query });
    if (!projects.on) return plain();
    // Bounded, so a stuck request falls back rather than hold up the refresh.
    const withProjects = () => gh.graphqlResult<Pick<LiveResult, K>>(searchQuery([name], false, { projects: true }), { [name]: query }, { timeoutMs: PROJECTS_SEARCH_TIMEOUT_MS });
    const { data, failure, partly } = await searchWithProjects(withProjects, plain, (result) => !!result[name]);
    for (const problem of [partly, failure]) if (problem) (projects.problems.push(problem), console.error(`Next up's ${name} search with projects:`, problem));
    if (failure) projects.failed(failure);
    return data;
  };
  const search = (name: keyof typeof all): Promise<Partial<LiveResult>> =>
    name === "assigned" ? pickable(name, all[name]) : gh.graphql<Partial<LiveResult>>(searchQuery([name], name === "mine"), { [name]: all[name] });
  // One per Next up source [NXT-09].
  const searchUnclaimed = async (): Promise<Partial<LiveResult>> => {
    const results = await Promise.all(unclaimed.map(async ({ source, query }) => ({ source, nodes: (await pickable("unclaimed", query)).unclaimed.nodes })));
    return { unclaimed: { nodes: mergeUnclaimed(results) } };
  };
  const merge = (parts: Partial<LiveResult>[]) => Object.assign({}, ...parts) as LiveResult;
  const forDetails = Promise.all([search("mine"), search("assigned"), searchUnclaimed()]);
  const others = Promise.all([search("reviews"), search("mentions"), search("involved"), search("asked"), search("ended"), search("closedIssues")]);
  const afterThem = forDetails.then((parts) => details(gh, config, merge(parts), projects.on, projects.problems));
  const [first, rest, found] = await Promise.all([forDetails, others, afterThem]);
  return { data: merge([...first, ...rest]), details: found };
}

function variables(config: AttentionConfig, names: readonly Exclude<SearchName, "unclaimed">[], now: Date): Record<string, string> {
  const all = searchVariables(config, now);
  return Object.fromEntries(names.map((name) => [name, all[name]]));
}

// Behind counts [UPS-07], required checks [PRS-14], issue field option order [NXT-02] and colors [NXT-10], and the Status
// options of the boards Next up's issues are on [NXT-03].
async function details(gh: Gh, config: AttentionConfig, data: Pick<LiveResult, "mine" | "assigned" | "unclaimed">, projects: boolean, problems: string[]): Promise<Details> {
  const prs = data.mine.nodes.filter((pr) => pr?.headRefName && !pr.isCrossRepository);
  // Priority's colors tint its pill, so its options are asked for even when the config orders it.
  const effort = nextUpField(config, "effort");
  const needsOptions = !!nextUpField(config, "priority") || (!!effort && !effort.order);
  const issues = [...data.unclaimed.nodes, ...data.assigned.nodes];
  const orgs = needsOptions ? [...new Set(issues.map((issue) => issue?.repository?.nameWithOwner.split("/")[0]).filter(Boolean))] : [];
  const refs = toLookUp(data.mine.nodes.filter((pr) => pr?.repository));
  const mergeState = mergeStates(gh, data.mine.nodes.filter((pr) => pr?.repository));
  const statuses = projects ? projectStatuses(gh, issueBoardIds(issues), problems) : Promise.resolve({});
  const found: Details = { behind: {}, fieldOptions: {}, fieldColors: {}, projectStatuses: {}, issues: {}, checks: {}, mergeState: {} };
  if (prs.length === 0 && orgs.length === 0 && refs.length === 0) return { ...found, mergeState: await mergeState, projectStatuses: await statuses };
  const { query, compares } = detailsQuery(prs, orgs as string[], refs);
  type Result = {
    ref?: { compare: { behindBy: number } | null } | null;
    issueFields?: { nodes: { name?: string; options?: { name: string; color?: GithubColor }[] }[] };
    issueOrPullRequest?: (LinkedIssue & { state?: string }) | null;
    pullRequest?: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] } } | null;
  } | null;
  // A reference to a repo I can't see fails only its own field.
  const result = await gh.graphql<Record<string, Result>>(query);
  for (const [alias, value] of Object.entries(result)) {
    // Org fields come back as o0, o1, … in the order the orgs were asked for.
    const org = /^o\d+$/.test(alias) ? (orgs[Number(alias.slice(1))] as string).toLowerCase() : null;
    const behindBy = value?.ref?.compare?.behindBy;
    if (typeof behindBy === "number") found.behind[compares[alias]] = behindBy;
    const contexts = value?.pullRequest?.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes;
    if (contexts) found.checks[compares[alias]] = requiredChecks(contexts);
    for (const field of value?.issueFields?.nodes ?? []) {
      if (!org || !field.name || !field.options) continue;
      (found.fieldOptions[org] ??= {})[field.name] = field.options.map((o) => o.name);
      (found.fieldColors[org] ??= {})[field.name] = Object.fromEntries(field.options.flatMap((o) => (o.color ? [[o.name, o.color]] : [])));
    }
    const issue = value?.issueOrPullRequest; // empty for a PR
    if (issue?.state === "OPEN") found.issues[prKey(issue)] = { number: issue.number, title: issue.title, url: issue.url, repository: issue.repository };
  }
  return { ...found, mergeState: await mergeState, projectStatuses: await statuses };
}

// Each board's Status options, once per board [NXT-03, GH-01]. A board that can't be read lists no statuses; the whole
// request failing costs only the filter's statuses, never the refresh.
// Bounded in time, so it can't hold up the refresh, in size, a batch of boards per request, and in how many go at once.
async function projectStatuses(gh: Gh, ids: string[], problems: string[]): Promise<Details["projectStatuses"]> {
  const batches = Array.from({ length: Math.ceil(ids.length / BOARDS_PER_REQUEST) }, (_, i) => ids.slice(i * BOARDS_PER_REQUEST, (i + 1) * BOARDS_PER_REQUEST));
  const read = async (batch: string[]) => {
    try {
      const { data, errors } = await gh.graphqlResult<ProjectStatusesResult>(projectStatusesQuery(batch), {}, { timeoutMs: PROJECTS_SEARCH_TIMEOUT_MS });
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
async function mergeStates(gh: Gh, prs: PullRequestNode[]): Promise<Details["mergeState"]> {
  const batches = Array.from({ length: Math.ceil(prs.length / MERGE_STATE_BATCH) }, (_, i) => prs.slice(i * MERGE_STATE_BATCH, (i + 1) * MERGE_STATE_BATCH));
  const results = await Promise.all(
    batches.map(async (batch) => {
      const { query, keys } = mergeStateQuery(batch);
      const result = await gh.graphql<Record<string, { pullRequest: { mergeStateStatus?: MergeStateStatus } | null } | null>>(query).catch(() => ({}) as Record<string, never>);
      return Object.entries(result).flatMap(([alias, value]) => (value?.pullRequest?.mergeStateStatus ? [[keys[alias], value.pullRequest.mergeStateStatus] as const] : []));
    }),
  );
  return Object.fromEntries(results.flat());
}

// What others did to my work since the last refresh [HIS-07]. Only PRs whose hands changed and issues that left my assigned
// search are looked up, a batch per request; a failed batch is asked again next time [GH-01]. Kept long enough for History.
export async function trackChanges(gh: Gh, ledger: ChangeLedger, data: LiveResult, now: Date, config: AttentionConfig, gotIt: () => string[]): Promise<ChangeLedger> {
  const me = data.viewer.login;
  const candidates = changeCandidates(ledger, data, me);
  const lookups: Lookups = new Map();
  for (let at = 0; at < candidates.length; at += ASSIGNMENT_BATCH) {
    const batch = candidates.slice(at, at + ASSIGNMENT_BATCH);
    try {
      const { data: result, failures } = await gh.graphqlResult<Record<string, AssignmentSubject | null>>(assignmentsQuery(batch));
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
  const reopens = await reopenLookups(gh, reopenCandidates(ledger, data));
  const keepDays = Math.max(config.mentionDays, config.historyWeeks * 7 + 7);
  // A Got it tapped, or an archive acknowledging, while this refresh ran still counts.
  // Got its tapped while the lookups ran decide too, so a handover cleared meanwhile survives its work coming back.
  const current = { ...ledger, gotIt: gotIt() };
  return withGotIt(nextLedger(current, data, me, lookups, now, config.mentionDays, keepDays, reopens), gotIt());
}

// PRs Attention Span saw closed, asked about a batch per request so a reopen by someone else is noticed [HIS-07, GH-01].
// A batch that fails leaves its PRs tracked for the next refresh; one GitHub can't find is gone.
async function reopenLookups(gh: Gh, candidates: string[]): Promise<ReopenLookups> {
  const lookups: ReopenLookups = new Map();
  for (let at = 0; at < candidates.length; at += ASSIGNMENT_BATCH) {
    const batch = candidates.slice(at, at + ASSIGNMENT_BATCH);
    try {
      const { data, failures } = await gh.graphqlResult<Record<string, ReopenSubject | null>>(reopenQuery(batch));
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

// The fields settings offers for Next up, merged by name across orgs [NXT-04]. No orgs, no request.
async function issueFields(gh: Gh, owners: string[]): Promise<IssueField[]> {
  if (owners.length === 0) return [];
  const result = await gh.graphql<Record<string, OrgFields>>(issueFieldsQuery(owners));
  const merged = new Map<string, IssueField>();
  owners.forEach((org, index) => {
    for (const field of result[`o${index}`]?.issueFields?.nodes ?? []) {
      if (!field.name || !field.options) continue;
      const known = merged.get(field.name.toLowerCase());
      if (known) known.orgs.push(org);
      else merged.set(field.name.toLowerCase(), { name: field.name, options: field.options.map((option) => option.name), orgs: [org] });
    }
  });
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
