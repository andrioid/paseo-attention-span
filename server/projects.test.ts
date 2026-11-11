import { describe, expect, it } from "vitest";
import { probeAnswer, projectsWarning, searchWithProjects } from "./projects";

const SCOPE = "Your token has not been granted the required scopes to execute this query. The 'title' field requires one of the following scopes: ['read:project']";

describe("projects probe", () => {
  it("NXT-12: is on only when GitHub actually lists the viewer's projects", () => {
    expect(probeAnswer({ data: { viewer: { projectsV2: { totalCount: 3 } } }, errors: [] }, "unknown")).toEqual({ state: "on" });
    // A partial answer with errors isn't a yes.
    expect(probeAnswer({ data: { viewer: null }, errors: ["Resource protected by organization SAML enforcement"] }, "unknown")).toEqual({
      state: "failed",
      error: "Resource protected by organization SAML enforcement",
    });
    expect(probeAnswer({ data: { viewer: { projectsV2: null } }, errors: [SCOPE] }, "unknown")).toEqual({ state: "missing" });
  });

  it("NXT-12, GH-01: tells the missing scope from other failures, like a timeout, and keeps projects on through a blip", () => {
    expect(probeAnswer(new Error(SCOPE), "unknown")).toEqual({ state: "missing" });
    expect(probeAnswer(new Error("GitHub didn't answer within 10 s"), "unknown")).toEqual({ state: "failed", error: "GitHub didn't answer within 10 s" });
    expect(probeAnswer(new Error("GitHub didn't answer within 10 s"), "on")).toEqual({ state: "on", error: "GitHub didn't answer within 10 s" });
    // The scope gone is news even after projects worked.
    expect(probeAnswer(new Error(SCOPE), "on")).toEqual({ state: "missing" });
  });
});

describe("projects warning", () => {
  it("NXT-12: says each problem of a refresh once, and nothing when it read projects cleanly", () => {
    expect(projectsWarning([])).toBeUndefined();
    expect(projectsWarning(["SAML enforcement; Not found", "SAML enforcement", "GitHub didn't answer within 20 s"])).toBe("SAML enforcement; Not found; GitHub didn't answer within 20 s");
  });
});

describe("searches with projects", () => {
  type Result = { unclaimed: { nodes: number[] } | null };
  const has = (data: Result) => !!data.unclaimed;
  const without = async (): Promise<Result> => ({ unclaimed: { nodes: [1, 2] } });

  it("NXT-12: keeps an answer that has its results, even with errors about boards it can't see", async () => {
    const result = await searchWithProjects(async () => ({ data: { unclaimed: { nodes: [1] } }, errors: ["SAML enforcement"] }), without, has);
    expect(result).toEqual({ data: { unclaimed: { nodes: [1] } }, partly: "SAML enforcement" });
  });

  it("NXT-12: searches again without projects when GitHub fails the search or answers without its results, whatever the words", async () => {
    // Without results, with an error that doesn't mention the scope.
    expect(await searchWithProjects(async () => ({ data: { unclaimed: null }, errors: ["Resource not accessible by integration"] }), without, has)).toEqual({
      data: { unclaimed: { nodes: [1, 2] } },
      failure: "Resource not accessible by integration",
    });
    // Failed outright.
    const thrown = await searchWithProjects(async () => Promise.reject(new Error(SCOPE)), without, has);
    expect(thrown).toEqual({ data: { unclaimed: { nodes: [1, 2] } }, failure: SCOPE });
  });

  it("NXT-12: lets the search's own failure through, as it isn't about projects", async () => {
    const failing = (): Promise<Result> => Promise.reject(new Error("Bad credentials"));
    await expect(searchWithProjects(async () => Promise.reject(new Error("x")), failing, has)).rejects.toThrow("Bad credentials");
  });
});
