import { describe, expect, it } from "vitest";
import type { Attention, Item, NextUpIssue } from "../shared/attention";
import { AttentionConfig } from "../shared/config";
import { renderPrompt } from "../shared/prompts";
import { applyPending, buildView, doneItem, isPending, type Pending, SETTLE_MS } from "./view";

const config = AttentionConfig.parse({});
const feed = { fetchedAt: null, refreshing: false, error: null };
const meta = { feeds: { live: feed, history: feed }, scopes: [], sources: [], config, pending: 0 };

function item(key: string, section: Item["section"], othersActivityAt: string): Item {
  return {
    key,
    section,
    kind: "pr",
    repo: "o/r",
    number: 1,
    title: key,
    url: "https://x",
    draft: false,
    chips: [],
    actions: [],
    children: [],
    target: { kind: "pr", repo: "o/r", number: 1, title: key, url: "https://x" },
    othersActivityAt,
  };
}

const attention = (items: Item[]): Attention => ({ login: "me", items, assigned: [], unclaimed: [] });

describe("dismiss", () => {
  it("ATT-08: hides a dismissed item until someone else acts on it or its reason changes", () => {
    const dismissed = { a: { at: "2026-10-01T00:00:00Z", section: "reply" as const } };
    const hidden = buildView(attention([item("a", "reply", "2026-10-01T00:00:00Z")]), [], dismissed, meta);
    expect(hidden).toMatchObject({ count: 0, dismissedCount: 1, doing: [] });

    const newActivity = buildView(attention([item("a", "reply", "2026-10-02T00:00:00Z")]), [], dismissed, meta);
    expect(newActivity.count).toBe(1);

    const newReason = buildView(attention([item("a", "ci", "2026-10-01T00:00:00Z")]), [], dismissed, meta);
    expect(newReason.doing.map((section) => section.id)).toEqual(["ci"]);
  });

  it("ATT-09: counts what is visible in Doing; other tabs get their own lists", () => {
    const view = buildView(attention([item("a", "reply", "x"), item("b", "drafts", "x"), item("c", "wait_ci", "x")]), [item("d", "done", "x")], {}, meta);
    expect(view.count).toBe(2);
    expect(view.doing.map((section) => section.title)).toEqual(["Waiting for your reply", "My drafts"]);
    expect(view.waiting.map((section) => section.id)).toEqual(["wait_ci"]);
    expect(view.history.map((h) => h.key)).toEqual(["d"]);
  });
});

describe("pending changes", () => {
  const at = "2026-10-30T12:00:00.000Z";
  const time = new Date(at).getTime();
  const after = (ms: number) => new Date(time + ms).toISOString();
  const issue = (key: string): NextUpIssue => ({ key, repo: "o/r", number: 2, title: key, url: "https://x/2", createdAt: at, sources: [], openPrs: [] });
  const pending = (effect: Pending["effect"]): Pending => ({ at, effect });
  const lists = (items: Item[], assigned: NextUpIssue[] = [], unclaimed: NextUpIssue[] = []): Attention => ({ login: "me", items, assigned, unclaimed });

  it("FRESH-02: a merged PR leaves Doing and shows in History at once", () => {
    const pr = item("a", "ready", "x");
    const { attention, history } = applyPending(lists([pr, item("b", "ci", "x")]), [item("old", "done", "x")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(attention!.items.map((i) => i.key)).toEqual(["b"]);
    expect(history.map((i) => [i.key, i.section, i.closedAt])).toEqual([["a", "done", at], ["old", "done", undefined]]);
  });

  it("FRESH-02: once History has it, the prediction isn't shown twice", () => {
    const pr = item("a", "ready", "x");
    const { history } = applyPending(lists([]), [item("a", "done", "x")], { a: pending({ kind: "done", item: doneItem(pr, at) }) });
    expect(history).toHaveLength(1);
  });

  it("FRESH-02: an issue closed as not planned says so in History", () => {
    expect(doneItem(issue("i"), at, true)).toMatchObject({ kind: "issue", section: "done", chips: [{ text: "not planned" }] });
  });

  it("FRESH-02: a closed item leaves every list; claim and unclaim move the issue", () => {
    const shown = applyPending(lists([item("pr", "drafts", "x")], [issue("mine"), issue("back")], [issue("take"), issue("shut")]), [], {
      pr: pending({ kind: "gone" }),
      take: pending({ kind: "claimed" }),
      back: pending({ kind: "unclaimed" }),
      shut: pending({ kind: "gone" }),
    }).attention!;
    expect(shown.items).toEqual([]);
    expect(shown.assigned.map((i) => i.key)).toEqual(["mine", "take"]);
    expect(shown.unclaimed.map((i) => i.key)).toEqual(["back"]);
  });

  it("FRESH-02: a change whose outcome is uncertain keeps the card in place, with a chip", () => {
    const chip = { text: "rerunning", tone: "neutral" as const };
    const shown = applyPending(lists([item("a", "ci", "x")]), [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(shown.items[0]).toMatchObject({ section: "ci", chips: [chip] });
    const again = applyPending(shown, [], { a: pending({ kind: "chip", chip }) }).attention!;
    expect(again.items[0].chips).toHaveLength(1);
  });

  it("FRESH-02: shown until a fetch begun after GitHub caught up, or ten minutes at most", () => {
    const gone = pending({ kind: "gone" });
    expect(isPending(gone, { live: after(1_000), history: null }, time + 5_000)).toBe(true);
    expect(isPending(gone, { live: after(SETTLE_MS), history: null }, time + SETTLE_MS + 5_000)).toBe(false);
    expect(isPending(gone, { live: null, history: null }, time + 10 * 60_000)).toBe(false);
    const done = pending({ kind: "done", item: doneItem(item("a", "ready", "x"), at) });
    expect(isPending(done, { live: after(SETTLE_MS), history: after(1_000) }, time + SETTLE_MS + 5_000)).toBe(true);
    expect(isPending(done, { live: after(SETTLE_MS), history: after(SETTLE_MS) }, time + SETTLE_MS + 5_000)).toBe(false);
  });
});

describe("prompts", () => {
  const target = { kind: "pr" as const, repo: "o/r", number: 7, title: "T", url: "https://x/7", headRefName: "feature", baseRefName: "main", stack: [{ number: 7, head: "feature", base: "main" }, { number: 8, head: "next", base: "feature" }] };

  it("SES-04: fills a built-in template with the item and its context", () => {
    const prompt = renderPrompt("rebase", target, "Branches: feature", config);
    expect(prompt).toContain("o/r#7");
    expect(prompt).toContain("#7 → #8");
    expect(prompt).toContain("--update-refs");
    expect(prompt).toContain('reply "push"'); // UPS-05: stops for approval after resolving conflicts
    expect(prompt).toMatch(/no conflicts, push .*--force-with-lease/); // UPS-06: a clean rebase pushes by itself
    expect(prompt).toContain("Branches: feature");
  });

  it("SES-04: review sweeps the browser only if equipped and reports a verdict; address applies only trivial fixes", () => {
    const review = renderPrompt("review", target, "", config);
    expect(review).toMatch(/Browser sweep, only if you're equipped/);
    expect(review).toContain("Verdict");
    expect(review).toContain("Do not post anything to GitHub.");
    const address = renderPrompt("address", target, "", config);
    expect(address).toContain("Trivial means no behavior change");
    expect(address).toContain("Commit, but don't push.");
    expect(address).toContain("Do not reply on GitHub.");
  });

  it("SES-04: a template in config.json replaces the built-in one", () => {
    const custom = AttentionConfig.parse({ prompts: { fix: "Fix {{repo}}#{{number}} on {{head}}: {{context}}" } });
    expect(renderPrompt("fix", target, "log", custom)).toBe("Fix o/r#7 on feature: log");
  });
});
