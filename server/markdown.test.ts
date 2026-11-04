import { describe, expect, it } from "vitest";
import { asksQuestion, excerpt, plainText, taggedIn } from "./markdown";

describe("markdown", () => {
  it("MEN-07: drops template comments and images", () => {
    expect(excerpt("<!-- Describe your change -->\r\nRetries failed deliveries.\n\n\n\n![shot](https://x/y.png)")).toBe("Retries failed deliveries.");
    expect(excerpt("<!-- only a template -->")).toBeNull();
  });

  it("MEN-07: keeps Markdown, stopping after the last whole block that fits", () => {
    const body = "Retries with **backoff**, see [the runbook](https://x/runbook).\n\n- logs each attempt\n- gives up after 5\n\n" + "More detail. ".repeat(60);
    expect(excerpt(body)).toBe("Retries with **backoff**, see [the runbook](https://x/runbook).\n\n- logs each attempt\n- gives up after 5\n\n…");
  });

  it("MEN-07: keeps a code block whole, even with blank lines inside", () => {
    expect(excerpt("Run:\n\n```sh\nnpm test\n\nnpm run check\n```")).toBe("Run:\n\n```sh\nnpm test\n\nnpm run check\n```");
  });

  it("MEN-07: closes a code block cut short", () => {
    const text = excerpt(`\`\`\`\n${"line\n".repeat(40)}\`\`\``, 50)!;
    expect(text.endsWith("line\n```\n\n…")).toBe(true);
  });

  it("MEN-07: keeps the text of HTML like <details>, outside code", () => {
    expect(excerpt("<details><summary>Logs</summary>\n\nAll green\n</details>\n\n```html\n<b>kept</b>\n```")).toBe("Logs\n\nAll green\n\n```html\n<b>kept</b>\n```");
  });

  it("MEN-07: cuts a long paragraph at a word", () => {
    const text = excerpt("word ".repeat(200), 50)!;
    expect(text.endsWith("word…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(51);
  });

  it("ATT-05: quotes are plain text: links keep their text, marks go", () => {
    expect(plainText("See [the runbook](https://x/r), **really** and *soon*: `npm test` ~~old~~ <b>bold</b> <https://x/y>")).toBe(
      "See the runbook, really and soon: npm test old bold https://x/y",
    );
  });

  it("ATT-05: drops quoted replies, headings, list markers and code fences, but keeps snake_case", () => {
    expect(plainText("> @me earlier\n## Plan\n- [x] done_thing\n1. next\n```ts\nconst a = 1;\n```")).toBe("\nPlan\ndone_thing\nnext\n\nconst a = 1;\n");
  });

  it("WAI-02: reads tags from GitHub's links to people and teams, skipping nested quotes, other links and repeats", () => {
    const user = (login: string, host = "https://github.com") => `<a class="user-mention notranslate" data-hovercard-type="user" href="${host}/${login}">@${login}</a>`;
    const team = '<a class="team-mention js-team-mention notranslate" href="https://github.com/orgs/acme/teams/frontend">@acme/frontend</a>';
    const html = [
      `<blockquote><blockquote><p>${user("carol")}</p></blockquote><p>${user("dave")}</p></blockquote>`,
      `<p>${user("alice")} see <a href="https://github.com/bob">bob's profile</a>, ${team} and ${user("Alice")}</p>`,
      `<p>${user("erin", "https://ghe.example.com")} <code>@frank</code> @kubernetes/sig-node</p>`,
    ].join("");
    expect(taggedIn(html)).toEqual([
      { login: "alice", team: false },
      { login: "acme/frontend", team: true },
      { login: "erin", team: false },
    ]);
    expect(taggedIn(undefined)).toEqual([]);
  });

  it("WAI-01: a question is a ? in my own words, not in quotes, code or links", () => {
    expect(asksQuestion("@bob which shops?")).toBe(true);
    expect(asksQuestion("Can you check？")).toBe(true);
    expect(asksQuestion("@bob deployed to staging")).toBe(false);
    expect(asksQuestion("> did it work?\n\nIt did.")).toBe(false);
    expect(asksQuestion("Use `a ? b : c` here.\n\n```ts\nconst x = y ?? z;\n```")).toBe(false);
    expect(asksQuestion("See https://example.com/list?page=2 and [this](https://x.dev/?q=1)")).toBe(false);
    expect(asksQuestion(undefined)).toBe(false);
  });
});
