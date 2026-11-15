import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Target } from "../shared/attention";

const gh = vi.hoisted(() => ({ runGh: vi.fn(), graphql: vi.fn() }));
vi.mock("./gh", () => gh);

const { clip, reviewAgainContext, sessionContext } = await import("./context");

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

  it("SES-04: keeps links whole: parentheses, underscores, uppercase schemes and Markdown or angle-bracket wrappers", () => {
    const links = [
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
      "https://example.com/file_",
      "HTTPS://jam.dev/c/123",
      "https://md.example/a",
      "https://angle.example/b",
      "https://bold.example/c",
      "https://em.example/d",
      "https://code.example/e",
    ];
    const text = `${"a".repeat(10)} ${links[0]}, ${links[1]} and ${links[2]}. [md](${links[3]}) <${links[4]}> **${links[5]}** _${links[6]}_ \`${links[7]}\``;
    expect(clip(text, 5)).toBe(`aaaaa\n…(truncated)\nLinks in the cut part:\n${links.map((url) => `- ${url}`).join("\n")}`);
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

describe("sessionContext: review asked for again", () => {
  const reviewed = { at: "2026-11-10T00:00:00Z", oid: "old", head: "new" };
  const again: Target = { ...pr, stack: [{ number: 7, head: "feature", base: "main", review: true, reviewed }] };
  type Review = { author: { login: string }; state: string; body: string; submittedAt: string; commit: { oid: string } | null };
  const review = (login: string, state: string, body: string, oid: string | null = "old"): Review => ({ author: { login }, state, body, submittedAt: "2026-11-10T00:00:00Z", commit: oid ? { oid } : null });
  const thread = (isResolved: boolean, ...comments: [string, string][]) => ({
    isResolved,
    path: "src/cart.ts",
    line: 12,
    comments: { totalCount: comments.length, nodes: comments.map(([login, body]) => ({ author: { login }, body })) },
  });
  const github = (reviews: Review[], threads: ReturnType<typeof thread>[], head = "new") =>
    gh.graphql.mockResolvedValue({
      viewer: { login: "Me" },
      repository: { pullRequest: { url: pr.url, baseRefName: "main", headRefOid: head, reviews: { nodes: reviews }, reviewThreads: { totalCount: threads.length, nodes: threads } } },
    });

  it("REV-02: gives what I said last time, the threads I'm in with their replies, and how to find the commits since", async () => {
    view("Body");
    github(
      [review("me", "CHANGES_REQUESTED", "Rounding is off"), review("bob", "APPROVED", "LGTM"), review("me", "COMMENTED", "")],
      [thread(false, ["me", "Round per line"], ["alice", "Done in abc"]), thread(true, ["bob", "Nit"])],
    );
    const context = await sessionContext("review", again);
    expect(context).toContain("Description:\nBody");
    expect(context).toContain("Your last review: commented on 2026-11-10T00:00:00Z.");
    expect(context).toContain("You reviewed commit old; the head is now new.");
    expect(context).toContain("`git diff old..new`");
    expect(context).toContain("`git range-diff old...new`");
    expect(context).toContain("What you wrote in your reviews:\n- changes_requested, 2026-11-10T00:00:00Z: Rounding is off");
    expect(context).toContain("- src/cart.ts:12 (unresolved)\n  you: Round per line\n  @alice: Done in abc");
    expect(context).not.toContain("LGTM");
    expect(context).not.toContain("Nit");
  });

  it("REV-02: says how many long threads weren't read far enough to tell whether I'm in them", async () => {
    const long = { ...thread(false, ["bob", "Opening"]), comments: { totalCount: 30, nodes: [{ author: { login: "bob" }, body: "Opening" }] } };
    github([review("me", "COMMENTED", "")], [long, thread(false, ["me", "Mine"])]);
    const context = await reviewAgainContext(again);
    expect(context).toContain("1 long review thread was read only to comment 20 and may have yours further down; see https://github.com/acme/app/pull/7");
    expect(context).toContain("you: Mine");
  });

  it("REV-02: says when there's nothing new to diff, or the commit I reviewed is gone", async () => {
    github([review("me", "COMMENTED", "")], [], "old");
    expect(await reviewAgainContext(again)).toContain("No commits since: the head is still old.");
    github([review("me", "COMMENTED", "", null)], []);
    expect(await reviewAgainContext(again)).toContain("GitHub no longer has the commit you reviewed, so review the whole diff against main");
  });

  it("REV-02, ATT-04: a stack gets a part for each PR asked again, after its branches", async () => {
    github([review("me", "COMMENTED", "")], []);
    const stacked: Target = { ...pr, stack: [{ number: 5, head: "a", base: "main", review: true, reviewed }, { number: 6, head: "b", base: "a", review: true }] };
    const context = await sessionContext("review", stacked);
    expect(context).toMatch(/^Stack, bottom first:/);
    expect(context).toContain("Your last review of #5: commented");
    expect(context).not.toContain("of #6");
    expect(gh.graphql).toHaveBeenCalledTimes(1);
  });

  it("REV-02: nothing extra when nobody asked again", async () => {
    view("Body");
    expect(await sessionContext("review", { ...pr, stack: [{ number: 7, head: "feature", base: "main", review: true }] })).toBe("Description:\nBody");
    expect(gh.graphql).not.toHaveBeenCalled();
  });
});
