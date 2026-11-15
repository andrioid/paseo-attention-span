import { describe, expect, it } from "vitest";
import { checkoutPr } from "./attention";
import { AttentionConfig } from "./config";
import { renderFollowUp, renderPrompt } from "./prompts";

const config = AttentionConfig.parse({});
const target = { kind: "pr" as const, repo: "o/r", number: 7, title: "T", url: "https://x/7", headRefName: "feature", baseRefName: "main", stack: [{ number: 7, head: "feature", base: "main" }, { number: 8, head: "next", base: "feature" }] };

describe("prompts", () => {
  it("SES-04: fills a built-in template with the item, its stack and the fetched context", () => {
    const prompt = renderPrompt("fix", target, "Failing: lint", config);
    expect(prompt).toContain("o/r#7");
    expect(prompt).toContain("Failing: lint");
    expect(prompt).not.toContain("{{");
  });

  it("UPS-05, UPS-06: a rebase pushes a clean result itself, and after resolving conflicts only when I reply push", () => {
    const prompt = renderPrompt("rebase", target, "", config);
    expect(prompt).toContain("#7 → #8");
    expect(prompt).toMatch(/no conflicts, push .*--force-with-lease/);
    expect(prompt).toContain('reply "push"');
  });

  it("SAFE-01: review and address never post to GitHub, and address doesn't push", () => {
    expect(renderPrompt("review", target, "", config)).toContain("Do not post anything to GitHub.");
    const address = renderPrompt("address", target, "", config);
    expect(address).toContain("Do not reply on GitHub.");
    expect(address).toContain("Commit, but don't push.");
  });

  it("ATT-04: review of a stack checks out its top and reviews only the PRs asking for it; Rebase lists only my branches", () => {
    const mixed = { ...target, stack: [{ number: 6, head: "theirs", base: "main", review: true as const }, ...target.stack] };
    expect(renderPrompt("review", mixed, "", config)).toContain("Review the pull requests #6 in o/r, part of the stack #6 → #7 → #8");
    expect(renderPrompt("rebase", mixed, "", config)).toContain("Stack, bottom first: #7 → #8");
    expect(checkoutPr("review", mixed)).toEqual({ number: 8, head: "next" });
    expect(checkoutPr("rebase", mixed)).toEqual({ number: 7, head: "feature" });
    expect(checkoutPr("review", { ...target, stack: [target.stack[0]] })).toEqual({ number: 7, head: "feature" });
  });

  it("SES-04: a template in config.json replaces the built-in one", () => {
    const custom = AttentionConfig.parse({ prompts: { fix: "Fix {{repo}}#{{number}} on {{head}}: {{context}}" } });
    expect(renderPrompt("fix", target, "log", custom)).toBe("Fix o/r#7 on feature: log");
  });

  describe("review asked for again", () => {
    const reviewed = { at: "2026-11-10T00:00:00Z", oid: "old", head: "new" };
    const again = { ...target, stack: [{ number: 7, head: "feature", base: "main", review: true as const, reviewed }] };

    it("REV-02: the built-in Review focuses on what changed and asks how my earlier comments were taken up", () => {
      const prompt = renderPrompt("review", again, "Since: git diff old..new", config);
      expect(prompt).toContain("o/r#7");
      expect(prompt).toContain("what changed since your last review");
      expect(prompt).toContain("Your earlier comments, each: addressed, partly, or not");
      expect(prompt).toContain("Since: git diff old..new");
      expect(prompt).toContain("Do not post anything to GitHub.");
      expect(prompt).not.toContain("{{");
      expect(renderPrompt("review", { ...target, stack: [{ number: 7, head: "feature", base: "main", review: true }] }, "", config)).not.toContain("since your last review");
    });

    it("REV-02, SES-04: a review template in config.json still applies, and gets what changed as its context", () => {
      const custom = AttentionConfig.parse({ prompts: { review: "Look at {{repo}}#{{number}}. {{context}}" } });
      expect(renderPrompt("review", again, "since old", custom)).toBe("Look at o/r#7. since old");
    });

    it("REV-02, ATT-04: a stack's again names the PRs asked again, and the follow-up updates the checkout of its top first", () => {
      const stack = { ...target, stack: [again.stack[0], { number: 8, head: "next", base: "feature", review: true as const, reviewed }] };
      expect(renderPrompt("review", stack, "", config)).toContain("You reviewed some of them before");
      const mixed = { ...target, stack: [again.stack[0], { number: 8, head: "next", base: "feature" }] };
      expect(renderPrompt("review", mixed, "", config)).toContain("Review only #7; the rest of the stack is context.");
      const followUp = renderFollowUp(stack, "Your last review of #7: …");
      expect(followUp).toContain("Review was asked for again on #7, #8 in o/r");
      expect(followUp).toContain("if there are local changes, stop and ask me");
      expect(followUp).toContain("`gh pr checkout 8 --force`");
      expect(followUp).toContain("Report back, for each PR:");
      expect(followUp).toContain("Your last review of #7: …");
      expect(followUp).toContain("Do not post anything to GitHub.");
      expect(followUp).not.toContain("{{");
      expect(renderFollowUp(again, "")).toContain("`gh pr checkout 7 --force`");
    });
  });
});
