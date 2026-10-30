import { describe, expect, it } from "vitest";
import { linkList } from "./format";

describe("linkList", () => {
  it("HIS-03: lists each item as a Markdown link, one per line", () => {
    expect(
      linkList([
        { title: "Link each PR to GitHub", url: "https://github.com/acme/app/pull/42" },
        { title: "Settings hides options", url: "https://github.com/acme/app/issues/38" },
      ]),
    ).toBe("- [Link each PR to GitHub](https://github.com/acme/app/pull/42)\n- [Settings hides options](https://github.com/acme/app/issues/38)");
  });

  it("HIS-03: escapes brackets in titles so the link stays intact", () => {
    expect(linkList([{ title: "[WIP] Fix a\\b", url: "https://github.com/acme/app/pull/1" }])).toBe("- [\\[WIP\\] Fix a\\\\b](https://github.com/acme/app/pull/1)");
  });
});
