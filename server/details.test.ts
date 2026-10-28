import { describe, expect, it } from "vitest";
import { excerpt } from "./details";

describe("sheet details", () => {
  it("ATT-06: shows the description's opening, without template comments or images", () => {
    expect(excerpt("<!-- Describe your change -->\r\nRetries failed deliveries.\n\n\n\n![shot](https://x/y.png)")).toBe("Retries failed deliveries.");
    expect(excerpt("<!-- only a template -->")).toBeNull();
  });

  it("ATT-06: cuts a long description at a word", () => {
    const text = excerpt("word ".repeat(200), 50)!;
    expect(text.endsWith("word…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(51);
  });
});
