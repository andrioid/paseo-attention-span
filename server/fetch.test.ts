import { describe, expect, it, vi } from "vitest";
import { lookupBatches, mergeIssueFields, projectStatuses, readDetails } from "./fetch";
import { builders } from "./fixture";
import type { GraphqlFailure } from "./gh";
import { prKey } from "./queries";

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
