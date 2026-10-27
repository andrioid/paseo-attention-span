import { describe, expect, it } from "vitest";
import { InboxConfig } from "../shared/config";
import type { Inbox, Item } from "../shared/inbox";
import { renderPrompt } from "../shared/prompts";
import { buildView } from "./view";

const config = InboxConfig.parse({});
const meta = { fetchedAt: null, refreshing: false, error: null, config };

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

const inbox = (items: Item[]): Inbox => ({ login: "me", items, assigned: [], unclaimed: [] });

describe("dismiss", () => {
  it("ATT-08: hides a dismissed item until someone else acts on it or its reason changes", () => {
    const dismissed = { a: { at: "2026-10-01T00:00:00Z", section: "reply" as const } };
    const hidden = buildView(inbox([item("a", "reply", "2026-10-01T00:00:00Z")]), dismissed, meta);
    expect(hidden).toMatchObject({ count: 0, dismissedCount: 1, doing: [] });

    const newActivity = buildView(inbox([item("a", "reply", "2026-10-02T00:00:00Z")]), dismissed, meta);
    expect(newActivity.count).toBe(1);

    const newReason = buildView(inbox([item("a", "ci", "2026-10-01T00:00:00Z")]), dismissed, meta);
    expect(newReason.doing.map((section) => section.id)).toEqual(["ci"]);
  });

  it("ATT-09: counts what is visible in Doing; other tabs get their own lists", () => {
    const view = buildView(inbox([item("a", "reply", "x"), item("b", "drafts", "x"), item("c", "wait_ci", "x"), item("d", "done", "x")]), {}, meta);
    expect(view.count).toBe(2);
    expect(view.doing.map((section) => section.title)).toEqual(["Waiting for your reply", "My drafts"]);
    expect(view.waiting.map((section) => section.id)).toEqual(["wait_ci"]);
    expect(view.history.map((h) => h.key)).toEqual(["d"]);
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

  it("SES-04: a template in config.json replaces the built-in one", () => {
    const custom = InboxConfig.parse({ prompts: { fix: "Fix {{repo}}#{{number}} on {{head}}: {{context}}" } });
    expect(renderPrompt("fix", target, "log", custom)).toBe("Fix o/r#7 on feature: log");
  });
});
