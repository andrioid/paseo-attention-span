import { describe, expect, it } from "vitest";
import type { AttentionView, FeedStatus, Item, NextUpIssue, Section, WaitingGroup } from "./attention";
import { AttentionConfig } from "./config";
import { historyClear, isClear, nextUpClear, sceneAt, waitingClear } from "./still";

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

  it("ATT-18, ATT-22: Wrap up's rows keep the horizon away until they're archived", () => {
    expect(isClear(view([]), false, 1)).toBe(false);
    expect(isClear(view([]), false, 0)).toBe(true);
  });
});

const ok: FeedStatus = { fetchedAt: "2026-11-09T10:00:00Z", refreshing: false, error: null };
const never: FeedStatus = { fetchedAt: null, refreshing: false, error: null };
const broken: FeedStatus = { ...ok, error: "gh: not logged in" };

describe("waitingClear", () => {
  const waiting = (groups: unknown[], live = ok) => ({ waiting: groups as WaitingGroup[], feeds: { live, history: never } });

  it("WAI-04: is clear when nothing waits on anyone after a refresh that worked", () => {
    expect(waitingClear(waiting([]))).toBe(true);
    expect(waitingClear(waiting([{ who: null, items: [] }]))).toBe(false);
  });

  it("WAI-04: is never clear before the first refresh or after a failed one", () => {
    expect(waitingClear(waiting([], never))).toBe(false);
    expect(waitingClear(waiting([], broken))).toBe(false);
    expect(waitingClear(waiting([]), true)).toBe(false);
  });
});

describe("historyClear", () => {
  const done = { key: "a", title: "Ship it", url: "https://github.com/o/r/pull/1", section: "done", closedAt: new Date().toISOString() } as Item;
  const history = (items: Item[], feed = ok) => ({ history: items, feeds: { live: ok, history: feed }, config: AttentionConfig.parse({}) });

  it("HIS-08: is clear when nothing was finished and nothing is unread, after a refresh that worked", () => {
    expect(historyClear(history([]), 0)).toBe(true);
    expect(historyClear(history([done]), 0)).toBe(false);
    expect(historyClear(history([]), 1)).toBe(false);
  });

  it("HIS-08: is never clear before the first refresh of History's feed or after a failed one", () => {
    expect(historyClear(history([], never), 0)).toBe(false);
    expect(historyClear(history([], broken), 0)).toBe(false);
    expect(historyClear(history([]), 0, true)).toBe(false);
  });
});

describe("nextUpClear", () => {
  const issue = { key: "i" } as NextUpIssue;
  const next = (assigned: NextUpIssue[], unclaimed: NextUpIssue[], unclaimedFrom: AttentionView["unclaimedFrom"], live = ok) => ({
    assigned,
    unclaimed,
    unclaimedFrom,
    feeds: { live, history: never },
  });

  it("NXT-13: asks for setup when there's nowhere to look, even before a refresh", () => {
    expect(nextUpClear(next([], [], "none"))).toBe("setup");
    expect(nextUpClear(next([], [], "none", never))).toBe("setup");
  });

  it("NXT-13: is clear when nothing is assigned or unclaimed after a refresh that worked", () => {
    expect(nextUpClear(next([], [], "config"))).toBe("clear");
    expect(nextUpClear(next([], [], "projects", never))).toBe(null);
    expect(nextUpClear(next([], [], "config", broken))).toBe(null);
    expect(nextUpClear(next([], [], "config"), true)).toBe(null);
  });

  it("NXT-13: shows the list while anything is in it, a filter hiding it all included", () => {
    expect(nextUpClear(next([issue], [], "none"))).toBe(null);
    expect(nextUpClear(next([], [issue], "config"))).toBe(null);
  });
});
