import { describe, expect, it } from "vitest";
import { ALL_NOTES, ALL_WRAP, allNotesBusy, allWrapBusy, noteBusy, wrapBusy } from "./got-it";

describe("Got it and Mark all as read", () => {
  it("HIS-07: holds a row's Got it while Mark all as read runs", () => {
    expect(noteBusy(new Set([ALL_NOTES]), "pr:1")).toBe(true);
    expect(noteBusy(new Set(), "pr:1")).toBe(false);
  });

  it("HIS-07: holds Mark all as read while any of its rows' Got it runs", () => {
    expect(allNotesBusy(new Set(["pr:2"]), ["pr:1", "pr:2"])).toBe(true);
    expect(allNotesBusy(new Set(["pr:9"]), ["pr:1", "pr:2"])).toBe(false);
  });

  it("ATT-22: Archive session and Archive all clean wait for each other", () => {
    expect(wrapBusy(new Set([ALL_WRAP]), "wrap:a")).toBe(true);
    expect(wrapBusy(new Set(), "wrap:a")).toBe(false);
    expect(allWrapBusy(new Set(["wrap:a"]), ["wrap:a", "wrap:b"])).toBe(true);
    expect(allWrapBusy(new Set(["wrap:c"]), ["wrap:a", "wrap:b"])).toBe(false);
  });
});
