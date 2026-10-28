import { describe, expect, it } from "vitest";
import { excerpt, plainText } from "./markdown";

describe("markdown", () => {
  it("ATT-06: shows the description's opening, without template comments or images", () => {
    expect(excerpt("<!-- Describe your change -->\r\nRetries failed deliveries.\n\n\n\n![shot](https://x/y.png)")).toBe("Retries failed deliveries.");
    expect(excerpt("<!-- only a template -->")).toBeNull();
  });

  it("ATT-06: keeps Markdown, stopping after the last whole block that fits", () => {
    const body = "Retries with **backoff**, see [the runbook](https://x/runbook).\n\n- logs each attempt\n- gives up after 5\n\n" + "More detail. ".repeat(60);
    expect(excerpt(body)).toBe("Retries with **backoff**, see [the runbook](https://x/runbook).\n\n- logs each attempt\n- gives up after 5\n\n…");
  });

  it("ATT-06: keeps a code block whole, even with blank lines inside", () => {
    expect(excerpt("Run:\n\n```sh\nnpm test\n\nnpm run check\n```")).toBe("Run:\n\n```sh\nnpm test\n\nnpm run check\n```");
  });

  it("ATT-06: closes a code block cut short", () => {
    const text = excerpt(`\`\`\`\n${"line\n".repeat(40)}\`\`\``, 50)!;
    expect(text.endsWith("line\n```\n\n…")).toBe(true);
  });

  it("ATT-06: keeps the text of HTML like <details>, outside code", () => {
    expect(excerpt("<details><summary>Logs</summary>\n\nAll green\n</details>\n\n```html\n<b>kept</b>\n```")).toBe("Logs\n\nAll green\n\n```html\n<b>kept</b>\n```");
  });

  it("ATT-06: cuts a long paragraph at a word", () => {
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
});
