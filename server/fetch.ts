import type { GithubColor } from "../shared/attention";
import { type AttentionConfig, nextUpField } from "../shared/config";
import type { IssueField } from "../shared/setup";
import { type ChangeLedger, changeCandidates, type Lookups, nextLedger, type ReopenLookups, reopenCandidates, withGotIt } from "./changes";
import { issueBoardIds } from "./classify";
import type { graphql, graphqlResult } from "./gh";
import type { Details, HistoryResult, LinkedIssue, LiveResult, MergeStateStatus, PullRequestNode } from "./github-types";
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
  if (prs.length === 0 && orgs.length === 0 && refs.length === 0) return { ...readDetails({}, [], {}), mergeState: await mergeState, projectStatuses: await statuses };
  const { query, compares } = detailsQuery(prs, orgs as string[], refs);
  // A reference to a repo I can't see fails only its own field.
  const result = await gh.graphql<Record<string, DetailsField>>(query);
  return { ...readDetails(result, orgs as string[], compares), mergeState: await mergeState, projectStatuses: await statuses };
}

type DetailsField = {
  ref?: { compare: { behindBy: number } | null } | null;
  issueFields?: { nodes: { name?: string; options?: { name: string; color?: GithubColor }[] }[] };
  issueOrPullRequest?: (LinkedIssue & { state?: string }) | null;
  pullRequest?: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] } } | null;
} | null;

// The details request's answer, by alias: `compares` maps a PR's aliases to its key, and org fields come back as o0, o1,
// … in the order `orgs` were asked for.
export function readDetails(result: Record<string, DetailsField>, orgs: string[], compares: Record<string, string>): Omit<Details, "mergeState" | "projectStatuses"> {
  const found: Omit<Details, "mergeState" | "projectStatuses"> = { behind: {}, fieldOptions: {}, fieldColors: {}, issues: {}, checks: {} };
  for (const [alias, value] of Object.entries(result)) {
    const org = /^o\d+$/.test(alias) ? orgs[Number(alias.slice(1))].toLowerCase() : null;
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
  return found;
}

// Each board's Status options, once per board [NXT-03, GH-01]. A board that can't be read lists no statuses; the whole
// request failing costs only the filter's statuses, never the refresh.
// Bounded in time, so it can't hold up the refresh, in size, a batch of boards per request, and in how many go at once.
export async function projectStatuses(gh: Gh, ids: string[], problems: string[]): Promise<Details["projectStatuses"]> {
  const found = await lookupBatches<string, NonNullable<ProjectStatusesResult[string]>>(gh, ids, "b", projectStatusesQuery, {
    size: BOARDS_PER_REQUEST,
    atOnce: BOARD_BATCHES_AT_ONCE,
    timeoutMs: PROJECTS_SEARCH_TIMEOUT_MS,
    problem: (message) => problems.push(message),
  });
  if (problems.length) console.error("Reading projects:", problems.join("; "));
  return Object.fromEntries([...found].flatMap(([id, board]) => (board?.field?.options ? [[id, board.field.options]] : [])));
}

// My PRs' merge state, a few per request in parallel, as GitHub only works it out for a few at a time; search's answer
// for more is BLOCKED for all [PRS-13]. A request that fails leaves its PRs to search's answer.
async function mergeStates(gh: Gh, prs: PullRequestNode[]): Promise<Details["mergeState"]> {
  const found = await lookupBatches<PullRequestNode, { pullRequest: { mergeStateStatus?: MergeStateStatus } | null }>(gh, prs, "m", mergeStateQuery, {
    size: MERGE_STATE_BATCH,
    atOnce: Infinity,
  });
  return Object.fromEntries([...found].flatMap(([pr, node]) => (node?.pullRequest?.mergeStateStatus ? [[prKey(pr), node.pullRequest.mergeStateStatus]] : [])));
}

// Nodes asked for `size` to a request, `atOnce` requests at a time, each aliased `prefix` and its index in the batch
// [GH-01]. Answers each item's node, or null when GitHub can't find it, as that one is gone for good. An item whose
// request, or own field, failed is left out, to be asked again next refresh. `problem` hears what went wrong.
export async function lookupBatches<T, N>(
  gh: Gh,
  items: T[],
  prefix: string,
  query: (batch: T[]) => string,
  { size, atOnce = 1, timeoutMs, problem }: { size: number; atOnce?: number; timeoutMs?: number; problem?: (message: string) => void },
): Promise<Map<T, N | null>> {
  const batches = Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
  const read = async (batch: T[]): Promise<[T, N | null][]> => {
    try {
      const { data, errors, failures } = await gh.graphqlResult<Record<string, N | null>>(query(batch), {}, timeoutMs ? { timeoutMs } : {});
      if (errors.length) problem?.(errors.join("; "));
      return batch.flatMap((item, index) => {
        const alias = `${prefix}${index}`;
        const failed = failures.some((failure) => failure.path?.[0] === alias && failure.type !== "NOT_FOUND");
        return failed ? [] : [[item, data?.[alias] ?? null]];
      });
    } catch (error) {
      problem?.((error as Error).message);
      return [];
    }
  };
  const found: [T, N | null][] = [];
  for (let at = 0; at < batches.length; at += atOnce) for (const answer of await Promise.all(batches.slice(at, at + atOnce).map(read))) found.push(...answer);
  return new Map(found);
}

// What others did to my work since the last refresh [HIS-07]. Only PRs whose hands changed and issues that left my assigned
// search are looked up, a batch per request; a failed batch is asked again next time [GH-01]. Kept long enough for History.
export async function trackChanges(gh: Gh, ledger: ChangeLedger, data: LiveResult, now: Date, config: AttentionConfig, gotIt: () => string[]): Promise<ChangeLedger> {
  const me = data.viewer.login;
  const lookups: Lookups = await lookupBatches(gh, changeCandidates(ledger, data, me), "a", assignmentsQuery, {
    size: ASSIGNMENT_BATCH,
    problem: (message) => console.error("Couldn't look up who changed my work:", message),
  });
  // PRs Attention Span saw closed, so a reopen by someone else is noticed.
  const reopens: ReopenLookups = await lookupBatches(gh, reopenCandidates(ledger, data), "a", reopenQuery, {
    size: ASSIGNMENT_BATCH,
    problem: (message) => console.error("Couldn't check whether a closed PR reopened:", message),
  });
  const keepDays = Math.max(config.mentionDays, config.historyWeeks * 7 + 7);
  // A Got it tapped, or an archive acknowledging, while this refresh ran still counts.
  // Got its tapped while the lookups ran decide too, so a handover cleared meanwhile survives its work coming back.
  const current = { ...ledger, gotIt: gotIt() };
  return withGotIt(nextLedger(current, data, me, lookups, now, config.mentionDays, keepDays, reopens), gotIt());
}

// The fields settings offers for Next up, merged by name across orgs [NXT-04]. No orgs, no request.
async function issueFields(gh: Gh, owners: string[]): Promise<IssueField[]> {
  if (owners.length === 0) return [];
  return mergeIssueFields(owners, await gh.graphql<Record<string, OrgFields>>(issueFieldsQuery(owners)));
}

// Each org's fields as o0, o1, … in the order of `owners`, merged by name, case aside; a field without options isn't one.
export function mergeIssueFields(owners: string[], result: Record<string, OrgFields>): IssueField[] {
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

