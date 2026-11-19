import { describe, expect, it, vi } from "vitest";
import { AttentionConfig } from "../shared/config";
import { gitHub, lookupBatches, mergeIssueFields, projectStatuses, readDetails } from "./fetch";
import { builders } from "./fixture";
import type { GraphqlFailure } from "./gh";
import { prKey, unclaimedSearches } from "./queries";

type Answer = { data: Record<string, unknown> | null; errors?: string[]; failures?: GraphqlFailure[] };

// gh answering each request with `answer`, keeping what was asked and how many were in flight at most.
function fakeGh(answer: (query: string) => Answer | Error) {
  const asked: { query: string; options?: { timeoutMs?: number } }[] = [];
  let inFlight = 0;
  let most = 0;
  const graphqlResult = vi.fn(async (query: string, _variables?: Record<string, unknown>, options?: { timeoutMs?: number }) => {
    asked.push({ query, options });
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    const result = answer(query);
    if (result instanceof Error) throw result;
    return { data: result.data, errors: result.errors ?? [], failures: result.failures ?? [] };
  });
  const gh = { graphqlResult, graphql: vi.fn() } as never;
  return { gh, asked, most: () => most };
}

// The ids a request asked about, in its alias order.
const idsIn = (query: string) => [...query.matchAll(/node\(id: "([^"]+)"\)/g)].map((match) => match[1]);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `N_${i}`);

describe("lookupBatches", () => {
  it("GH-01: asks a batch per request, one at a time unless told otherwise", async () => {
    const { gh, asked, most } = fakeGh((query) => ({ data: Object.fromEntries(idsIn(query).map((id, i) => [`a${i}`, { id }])) }));
    const query = (batch: string[]) => batch.map((id, i) => `a${i}: node(id: "${id}") { id }`).join("\n");
    const found = await lookupBatches(gh, ids(45), "a", query, { size: 20 });
    expect(asked.map((ask) => idsIn(ask.query).length)).toEqual([20, 20, 5]);
    expect(most()).toBe(1);
    expect(found.size).toBe(45);
    expect(found.get("N_44")).toEqual({ id: "N_44" });
  });

  it("GH-01: runs `atOnce` requests at a time", async () => {
    const { gh, asked, most } = fakeGh(() => ({ data: {} }));
    await lookupBatches(gh, ids(9), "a", (batch) => batch.map((id) => `node(id: "${id}")`).join(), { size: 2, atOnce: 2 });
    expect([asked.length, most()]).toEqual([5, 2]);
  });

  it("HIS-07: a node GitHub can't find is null; one it failed on, or in a failed request, is left out to be asked again", async () => {
    const problems: string[] = [];
    const { gh } = fakeGh((query) => {
      if (idsIn(query).includes("N_3")) return new Error("timeout");
      return {
        data: { a0: { id: "N_0" }, a1: null, a2: null },
        errors: ["gone", "boom"],
        failures: [
          { message: "gone", type: "NOT_FOUND", path: ["a1"] },
          { message: "boom", type: "INTERNAL", path: ["a2"] },
        ],
      };
    });
    const found = await lookupBatches(gh, ids(4), "a", (batch) => batch.map((id) => `node(id: "${id}")`).join(), { size: 3, problem: (message) => problems.push(message) });
    expect([...found]).toEqual([
      ["N_0", { id: "N_0" }],
      ["N_1", null],
    ]);
    expect(problems).toEqual(["gone; boom", "timeout"]);
  });
});

describe("project statuses", () => {
  it("NXT-03, GH-01: 50 boards a request, two at once, each bounded in time; a board that can't be read lists none", async () => {
    const options = [{ name: "Todo", color: "BLUE" }];
    const { gh, asked, most } = fakeGh((query) => ({
      data: Object.fromEntries(idsIn(query).map((id, i) => [`b${i}`, id === "N_7" ? { field: null } : { field: { options } }])),
      errors: query.includes("N_100") ? ["SSO"] : [],
    }));
    const problems: string[] = [];
    const statuses = await projectStatuses(gh, ids(120), problems);
    expect(asked.map((ask) => idsIn(ask.query).length)).toEqual([50, 50, 20]);
    expect(asked.every((ask) => ask.options?.timeoutMs === 20_000)).toBe(true);
    expect(most()).toBe(2);
    expect(Object.keys(statuses)).toHaveLength(119);
    expect(statuses.N_0).toEqual(options);
    expect(problems).toEqual(["SSO"]);
  });
});

describe("details", () => {
  const { pr } = builders(new Date("2026-11-14T12:00:00Z"));
  const mine = pr(7);
  const contexts = [
    { isRequired: true, status: "COMPLETED", conclusion: "SUCCESS" },
    { isRequired: true, status: "IN_PROGRESS" },
    { isRequired: false, status: "COMPLETED", conclusion: "FAILURE" },
  ];
  const issue = { number: 3, title: "Bug", url: "u", repository: { nameWithOwner: "acme/shop" } };

  it("UPS-07, PRS-14, NXT-02, NXT-10: reads behind counts, required checks, org field options and colors, and open issues", () => {
    const result = {
      c0: { ref: { compare: { behindBy: 4 } } },
      p0: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } } },
      o0: { issueFields: { nodes: [{ name: "Priority", options: [{ name: "P0", color: "RED" as const }, { name: "P1" }] }, { name: "Notes" }] } },
      i0: { issueOrPullRequest: { ...issue, state: "OPEN" } },
      i1: { issueOrPullRequest: { ...issue, number: 4, state: "CLOSED" } },
      x0: null,
    };
    const details = readDetails(result, ["Acme"], { c0: prKey(mine), p0: prKey(mine) });
    expect(details).toEqual({
      behind: { "acme/shop#7": 4 },
      checks: { "acme/shop#7": { required: 2, failing: 0, pending: 1 } },
      fieldOptions: { acme: { Priority: ["P0", "P1"] } },
      fieldColors: { acme: { Priority: { P0: "RED" } } },
      issues: { "acme/shop#3": issue },
    });
  });

  it("NXT-04: settings' fields merge by name across orgs, first spelling kept, sorted, fields without options skipped", () => {
    const field = (name: string, ...options: string[]) => ({ name, options: options.map((option) => ({ name: option })) });
    const fields = mergeIssueFields(["acme", "globex", "me"], {
      o0: { issueFields: { nodes: [field("Priority", "P0", "P1"), field("Effort", "S")] } },
      o1: { issueFields: { nodes: [field("priority", "High"), { name: "Notes" }] } },
      o2: null,
    });
    expect(fields).toEqual([
      { name: "Effort", options: ["S"], orgs: ["acme"] },
      { name: "Priority", options: ["P0", "P1"], orgs: ["acme", "globex"] },
    ]);
  });
});

describe("requests", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  // An issue assigned to me in an org whose Priority field Next up uses, so the details request has something to ask.
  const config = AttentionConfig.parse({ orgs: ["acme"], nextUp: { priority: { field: "Priority" } } });
  const assigned = builders(now).pickable(5, {});
  // gh recording each request by the searches it carries, answering each search with what it found.
  function recordingGh() {
    const requests: string[][] = [];
    const answer = (variables: Record<string, unknown> = {}) => {
      const searches = Object.keys(variables).sort();
      requests.push(searches);
      return { viewer: { login: "me", id: "U_me" }, ...Object.fromEntries(searches.map((name) => [name, { nodes: name === "assigned" ? [assigned] : [] }])) };
    };
    const gh = {
      graphql: async (_query: string, variables?: Record<string, unknown>) => answer(variables),
      graphqlResult: async (_query: string, variables?: Record<string, unknown>) => ({ data: answer(variables), errors: [], failures: [] }),
    } as never;
    return { gh, requests };
  }

  it("GH-01: a live refresh sends each search as its own request, then one details request", async () => {
    const { gh, requests } = recordingGh();
    const { searches } = unclaimedSearches(config, [], null);
    await gitHub(gh).live(config, now, searches, { on: false, problems: [], failed: () => {} });
    expect(requests.sort()).toEqual([[], ["asked"], ["assigned"], ["closedIssues"], ["ended"], ["involved"], ["mentions"], ["mine"], ["reviews"], ["unclaimed"]]);
  });

  it("ATT-03: the details request looks up the issue another's PR atop my stack closes, and not one my PR only mentions", async () => {
    const { pr } = builders(now);
    const mine = pr(30, { headRefName: "a", body: "First of two for #51" });
    const theirs = pr(31, { baseRefName: "a", body: "Closes #50", author: { login: "alice", avatarUrl: "" } });
    const queries: string[] = [];
    const answer = (query: string, variables: Record<string, unknown> = {}) => {
      if (Object.keys(variables).length === 0) queries.push(query);
      const nodes = (name: string) => (name === "mine" ? [mine] : name === "reviews" ? [theirs] : []);
      return { viewer: { login: "me", id: "U_me" }, ...Object.fromEntries(Object.keys(variables).map((name) => [name, { nodes: nodes(name) }])) };
    };
    const gh = {
      graphql: async (query: string, variables?: Record<string, unknown>) => answer(query, variables),
      graphqlResult: async (query: string, variables?: Record<string, unknown>) => ({ data: answer(query, variables), errors: [], failures: [] }),
    } as never;
    await gitHub(gh).live(config, now, unclaimedSearches(config, [], null).searches, { on: false, problems: [], failed: () => {} });
    const details = queries.find((query) => query.startsWith("query Details")) ?? "";
    expect(details).toContain("issueOrPullRequest(number: 50)");
    expect(details).not.toContain("issueOrPullRequest(number: 51)");
  });

  it("GH-01, HIS-01: History's three searches go in one request", async () => {
    const { gh, requests } = recordingGh();
    await gitHub(gh).history(config, now, "UTC");
    expect(requests).toEqual([["closed", "merged", "reviewed"]]);
  });
});
