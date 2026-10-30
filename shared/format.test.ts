import { describe, expect, it } from "vitest";
import { linkList, shortValue } from "./format";

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

describe("shortValue", () => {
  it("NXT-10: drops a field value's leading emoji and trailing note", () => {
    expect(shortValue("🐟 Tiny (< 4h)")).toBe("Tiny");
    expect(shortValue("🏕P2 Medium")).toBe("P2 Medium");
    expect(shortValue("🕵 Full-stack")).toBe("Full-stack");
    expect(shortValue("Backend")).toBe("Backend");
    expect(shortValue("🔥")).toBe("🔥"); // nothing left: keep it as it is
  });
});
