import { describe, expect, it } from "vitest";
import type { AttentionView, FeedStatus, Item, NextUpIssue, Section, WaitingGroup } from "./attention";
import { AttentionConfig } from "./config";
import { historyClear, isClear, nextUpClear, sceneAt, waitingClear } from "./still";
import { feed, item } from "./test-builders";

const never = feed({ fetchedAt: null });

// A view with nothing in any tab, both feeds as given.
function empty(status: FeedStatus = feed(), fields: Partial<AttentionView> = {}) {
  return { doing: [], waiting: [], history: [], assigned: [], unclaimed: [], unclaimedFrom: "config", feeds: { live: status, history: status }, config: AttentionConfig.parse({}), ...fields } as AttentionView;
}

describe("sceneAt", () => {
  it.each([
    [0, 0, "night"],
    [4, 59, "night"],
    [5, 0, "morning"],
    [10, 59, "morning"],
    [11, 0, "midday"],
    [15, 59, "midday"],
    [16, 0, "evening"],
    [20, 59, "evening"],
    [21, 0, "night"],
  ])("ATT-18: at %i:%i local time it's %s, changing on the hour", (hour, minute, scene) => {
    expect(sceneAt(new Date(2026, 10, 9, hour, minute))).toBe(scene);
  });
});

describe("calm scenes", () => {
  const scenes = {
    Doing: (view: AttentionView, failed?: boolean) => isClear(view, failed),
    Waiting: (view: AttentionView, failed?: boolean) => waitingClear(view, failed),
    History: (view: AttentionView, failed?: boolean) => historyClear(view, 0, failed),
    "Next up": (view: AttentionView, failed?: boolean) => nextUpClear(view, failed) === "clear",
  };

  it.each(Object.entries(scenes))("ATT-18, WAI-04, HIS-08, NXT-13: %s is calm when empty after a refresh that worked, even while another runs", (_, calm) => {
    expect(calm(empty())).toBe(true);
    expect(calm(empty(feed({ refreshing: true })))).toBe(true);
  });

  it.each(Object.entries(scenes))("ATT-18, WAI-04, HIS-08, NXT-13: %s is never calm before the first refresh, after a failed one, or when loading the view failed", (_, calm) => {
    expect(calm(empty(never))).toBe(false);
    expect(calm(empty(feed({ error: "gh: not logged in" })))).toBe(false);
    expect(calm(empty(), true)).toBe(false);
  });

  it("ATT-18, ATT-22: Doing isn't calm while anything needs me, nor until Wrap up's rows are archived", () => {
    expect(isClear(empty(feed(), { doing: [{ id: "reply", title: "Waiting for your reply", items: [] } as unknown as Section] }))).toBe(false);
    expect(isClear(empty(), false, 1)).toBe(false);
  });

  it("WAI-04: Waiting isn't calm while anything waits on anyone", () => {
    expect(waitingClear(empty(feed(), { waiting: [{ who: null, items: [] } as unknown as WaitingGroup] }))).toBe(false);
  });

  it("HIS-08: History isn't calm with anything finished in its weeks, or a note unread", () => {
    const done: Item = item("a", "done", { closedAt: new Date().toISOString() });
    expect(historyClear(empty(feed(), { history: [done] }), 0)).toBe(false);
    expect(historyClear(empty(), 1)).toBe(false);
  });

  it("NXT-13: Next up asks for setup when there's nowhere to look, even before a refresh, and shows any issue, filtered or not", () => {
    const issue = { key: "i" } as NextUpIssue;
    expect(nextUpClear(empty(feed(), { unclaimedFrom: "none" }))).toBe("setup");
    expect(nextUpClear(empty(never, { unclaimedFrom: "none" }))).toBe("setup");
    expect(nextUpClear(empty(feed(), { unclaimedFrom: "none", assigned: [issue] }))).toBe(null);
    expect(nextUpClear(empty(feed(), { unclaimed: [issue] }))).toBe(null);
  });
});
