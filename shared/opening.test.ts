import { describe, expect, it } from "vitest";
import { LatestOnly } from "./opening";

describe("LatestOnly", () => {
  it("ATT-06: a second tap supersedes the first, whichever request finishes first", () => {
    const pending = new LatestOnly();
    const cancelled: string[] = [];
    const a = pending.start(() => cancelled.push("a"));
    const b = pending.start(() => cancelled.push("b"));
    expect(cancelled).toEqual(["a"]);
    // B's details arrive first, then A's: only B opens.
    expect(b.isCurrent()).toBe(true);
    b.done();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
  });

  it("ATT-06: another sheet taking over cancels what was waiting to open", () => {
    const pending = new LatestOnly();
    const cancelled: string[] = [];
    const a = pending.start(() => cancelled.push("a"));
    pending.cancel();
    expect(cancelled).toEqual(["a"]);
    expect(a.isCurrent()).toBe(false);
  });

  it("ATT-06: a card that goes away while waiting leaves nothing pending, and doesn't cancel a newer one", () => {
    const pending = new LatestOnly();
    const a = pending.start(() => {});
    const b = pending.start(() => {});
    a.done();
    expect(b.isCurrent()).toBe(true);
  });
});
