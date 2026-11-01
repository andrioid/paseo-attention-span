import { describe, expect, it } from "vitest";
import { SECTIONS, type SectionId } from "../shared/attention";
import { pick, PR_RULES, type PrState } from "./rules";

// Every combination of a PR's flags, so no state falls through to an accidental default.
function prStates(): PrState[] {
  const flags = ["draft", "ciFailing", "ciPending", "changes", "approved", "conflicts", "blocked", "autoMerge", "autoMergeAllowed", "stacked", "stale", "asked", "replied", "tooLong"] as const;
  const states: PrState[] = [];
  for (let bits = 0; bits < 1 << flags.length; bits++) {
    const s = Object.fromEntries(flags.map((flag, index) => [flag, !!(bits & (1 << index))])) as Omit<PrState, "waiting" | "behindBy">;
    // CI is one of passing, running or failing.
    if (s.ciFailing && s.ciPending) continue;
    for (const behindBy of [0, 3]) states.push({ ...s, behindBy });
  }
  return states;
}

describe("rules", () => {
  it("ATT-02: every state of my PRs lands in a section", () => {
    for (const s of prStates()) expect(pick(PR_RULES, s), JSON.stringify(s)).toBeDefined();
  });

  it("WAI-01: the Waiting tab's rules never overlap, so their order decides nothing", () => {
    const waiting = (Object.keys(PR_RULES) as SectionId[]).filter((id) => SECTIONS[id].tab === "waiting");
    for (const s of prStates()) expect(waiting.filter((id) => PR_RULES[id]!.when(s)).length, JSON.stringify(s)).toBeLessThanOrEqual(1);
  });

  it("ATT-02: someone waiting on me comes first, draft or not", () => {
    const [s] = prStates();
    const waiting = { login: "alice", bot: false, since: "2026-10-28T00:00:00Z" };
    expect(pick(PR_RULES, { ...s, draft: true, waiting })).toBe("reply");
  });
});
