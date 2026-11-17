import { describe, expect, it } from "vitest";
import type { PrState } from "../shared/attention";
import { item } from "../shared/test-builders";
import { prStateMark, stackMark, stateMark } from "./mark";

describe("PR state marks", () => {
  it.each([
    ["OPEN", "pr", "good", undefined],
    ["DRAFT", "draft", "neutral", undefined],
    ["CLOSED", "prClosed", "bad", undefined],
    ["MERGED", "merge", "good", "PURPLE"],
  ] as const)("ATT-05, ATT-06: %s has the same mark on a card and in a stack", (state, icon, tone, color) => {
    const mark = prStateMark(state as PrState);
    expect(mark).toEqual({ icon, tone, ...(color ? { color } : {}) });
    expect(stackMark({ state, draft: true })).toEqual(mark);
  });

  it("ATT-06: legacy rows use their own merge and draft facts, independently of their parent", () => {
    expect(stackMark({ draft: false })).toEqual(prStateMark("OPEN"));
    expect(stackMark({ draft: true })).toEqual(prStateMark("DRAFT"));
    expect(stackMark({ draft: true, mergedAt: "2026-11-17T00:00:00Z" })).toEqual(prStateMark("MERGED"));
  });

  it("ATT-22: a PR closed without merging stays closed, including when marked as a draft", () => {
    expect(stateMark(item("o/r#1", "wrap", { closedAt: "2026-11-17T00:00:00Z", closedUnmerged: true, draft: true }))).toEqual(prStateMark("CLOSED"));
    expect(stateMark(item("o/r#2", "done", { closedAt: "2026-11-17T00:00:00Z" }))).toEqual(prStateMark("MERGED"));
  });
});
