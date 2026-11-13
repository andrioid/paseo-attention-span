import { describe, expect, it } from "vitest";
import { ALL_NOTES, allNotesBusy, noteBusy } from "./got-it";

describe("Got it and Mark all as read", () => {
  it("ATT-21: holds a row's Got it while Mark all as read runs", () => {
    expect(noteBusy(new Set([ALL_NOTES]), "pr:1")).toBe(true);
    expect(noteBusy(new Set(), "pr:1")).toBe(false);
  });

  it("ATT-21: holds Mark all as read while any of its rows' Got it runs", () => {
    expect(allNotesBusy(new Set(["pr:2"]), ["pr:1", "pr:2"])).toBe(true);
    expect(allNotesBusy(new Set(["pr:9"]), ["pr:1", "pr:2"])).toBe(false);
  });
});
