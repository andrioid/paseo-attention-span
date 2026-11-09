import { describe, expect, it } from "vitest";
import type { AttentionView, Section } from "./attention";
import { isClear, sceneAt } from "./still";

const at = (hour: number, minute = 0) => new Date(2026, 10, 9, hour, minute);
const view = (doing: Section[], live: Partial<AttentionView["feeds"]["live"]> = {}): Pick<AttentionView, "doing" | "feeds"> => ({
  doing,
  feeds: { live: { fetchedAt: "2026-11-09T10:00:00Z", refreshing: false, error: null, ...live }, history: { fetchedAt: null, refreshing: false, error: null } },
});

describe("sceneAt", () => {
  it("ATT-18: follows fixed local hours", () => {
    expect([4, 5, 10, 11, 15, 16, 20, 21, 23, 0].map((hour) => sceneAt(at(hour)))).toEqual([
      "night",
      "morning",
      "morning",
      "midday",
      "midday",
      "evening",
      "evening",
      "night",
      "night",
      "night",
    ]);
  });

  it("ATT-18: changes on the hour, not before", () => {
    expect(sceneAt(at(15, 59))).toBe("midday");
    expect(sceneAt(at(16, 0))).toBe("evening");
  });
});

describe("isClear", () => {
  it("ATT-18: is clear when Doing is empty after a refresh that worked", () => {
    expect(isClear(view([]))).toBe(true);
  });

  it("ATT-18: stays clear while a background refresh runs", () => {
    expect(isClear(view([], { refreshing: true }))).toBe(true);
  });

  it("ATT-18: is never clear before the first refresh, after a failed one, or when loading the view failed", () => {
    expect(isClear(view([], { fetchedAt: null }))).toBe(false);
    expect(isClear(view([], { error: "gh: not logged in" }))).toBe(false);
    expect(isClear(view([]), true)).toBe(false);
  });

  it("ATT-18: is not clear while anything needs me", () => {
    expect(isClear(view([{ id: "reply", title: "Waiting for your reply", items: [] } as unknown as Section]))).toBe(false);
  });
});
