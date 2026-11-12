import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Target } from "../shared/attention";

const gh = vi.hoisted(() => ({ runGh: vi.fn(), graphql: vi.fn() }));
vi.mock("./gh", () => gh);

const { clip, sessionContext } = await import("./context");

const issue: Target = { kind: "issue", repo: "acme/app", number: 35, title: "Bug", url: "https://github.com/acme/app/issues/35" };
const pr: Target = { ...issue, kind: "pr", number: 7, url: "https://github.com/acme/app/pull/7" };

const view = (body: string, comments: string[] = []) =>
  gh.runGh.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ body, comments: comments.map((c, i) => ({ author: { login: `u${i}` }, body: c })) }) });

beforeEach(() => vi.resetAllMocks());

describe("clip", () => {
  it("SES-04: leaves short text as it is", () => {
    expect(clip("  see https://jam.dev/c/1  ", 100)).toBe("see https://jam.dev/c/1");
  });

  it("SES-04: lists the links from the cut part, once each", () => {
    const text = `${"a".repeat(20)} https://kept.example/x. ${"b".repeat(40)} https://jam.dev/c/abc, and (https://jam.dev/c/abc) ![shot](https://img.example/1.png)`;
    expect(clip(text, 50)).toBe(`${text.slice(0, 50)}\n…(truncated)\nLinks in the cut part:\n- https://jam.dev/c/abc\n- https://img.example/1.png`);
  });

  it("SES-04: lists a link the cut splits in half whole", () => {
    const text = `${"a".repeat(10)} https://jam.dev/c/13189e9c-f95e`;
    expect(clip(text, 25)).toBe(`${text.slice(0, 25)}\n…(truncated)\nLinks in the cut part:\n- https://jam.dev/c/13189e9c-f95e`);
  });

  it("SES-04: says nothing about links when the cut part has none", () => {
    expect(clip("x".repeat(30), 10)).toBe(`${"x".repeat(10)}\n…(truncated)`);
  });
});

describe("sessionContext: start and review", () => {
  it("SES-04: sends the whole description, however long", async () => {
    const body = `${"word ".repeat(1500)}\nRecording: https://jam.dev/c/13189e9c`;
    view(body);
    const context = await sessionContext("start", issue);
    expect(context).toBe(`Description:\n${body.trim()}`);
    expect(gh.runGh).toHaveBeenCalledWith(["issue", "view", "35", "--repo", "acme/app", "--json", "body,comments"]);
  });

  it("SES-04: shows the last five comments and says where the rest are", async () => {
    view("Body", ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    const context = await sessionContext("start", issue);
    expect(context).toContain("Showing the last 5 of 7 comments; the rest are at https://github.com/acme/app/issues/35");
    expect(context).not.toContain("c2");
    expect(context).toContain("@u6: c7");
  });

  it("SES-04: doesn't mention older comments when there are none", async () => {
    view("Body", ["c1", "c2"]);
    expect(await sessionContext("review", pr)).toBe("Description:\nBody\n\nRecent comments:\n@u0: c1\n\n@u1: c2");
  });

  it("ATT-04: Review of a stack links each PR asking for review instead of quoting it", async () => {
    const stacked: Target = {
      ...pr,
      stack: [
        { number: 5, head: "a", base: "main" },
        { number: 6, head: "b", base: "a", review: true },
      ],
    };
    expect(await sessionContext("review", stacked)).toBe(
      "Stack, bottom first:\n- #5: a (on main), mine\n- #6: b (on a), review requested: https://github.com/acme/app/pull/6",
    );
    expect(gh.runGh).not.toHaveBeenCalled();
  });
});

describe("sessionContext: address", () => {
  const thread = (comments: number, totalCount = comments) => ({
    isResolved: false,
    path: "src/a.ts",
    line: 3,
    comments: { totalCount, nodes: Array.from({ length: comments }, (_, i) => ({ author: { login: "rev" }, body: `note ${i}` })) },
  });
  const feedback = (reviews: { totalCount: number; nodes: unknown[] }, threads: { totalCount: number; nodes: unknown[] }) =>
    gh.graphql.mockResolvedValue({ repository: { pullRequest: { reviews, reviewThreads: threads } } });

  it("SES-04: says nothing extra when everything fit", async () => {
    feedback({ totalCount: 0, nodes: [] }, { totalCount: 1, nodes: [thread(1)] });
    expect(await sessionContext("address", pr)).toBe("Unresolved review threads:\n- src/a.ts:3\n  @rev: note 0");
  });

  it("SES-04: says how many reviews, threads and comments were left out, and where to read them", async () => {
    feedback({ totalCount: 23, nodes: [{ author: { login: "rev" }, state: "COMMENTED", body: "Looks off" }] }, { totalCount: 130, nodes: [thread(20, 26)] });
    const context = await sessionContext("address", pr);
    expect(context).toContain("  6 more comments not shown, see https://github.com/acme/app/pull/7");
    expect(context).toContain("22 older reviews not shown, see https://github.com/acme/app/pull/7");
    expect(context).toContain("129 more review threads (resolved or not) not shown, see https://github.com/acme/app/pull/7");
  });

  it("SES-04: doesn't claim there are no unresolved threads when some weren't fetched", async () => {
    feedback({ totalCount: 0, nodes: [] }, { totalCount: 101, nodes: [{ ...thread(1), isResolved: true }] });
    const context = await sessionContext("address", pr);
    expect(context).not.toContain("No unresolved review threads.");
    expect(context).toBe("100 more review threads (resolved or not) not shown, see https://github.com/acme/app/pull/7");
  });
});
