import { describe, expect, it } from "vitest";
import { agent } from "./test-builders";
import { type AgentSummary, itemSessions, looseSessions, sessionTitle } from "./attention";

const at = (id: string, itemKey: string, lastActivityAt: string, requiresAttention = false) => agent(id, itemKey, { lastActivityAt, requiresAttention });
const item = { key: "acme/shop#90", closedAt: undefined, children: [{ key: "acme/shop#103" }] } as Parameters<typeof itemSessions>[1];

describe("itemSessions", () => {
  it("SES-03: finds sessions started on the item or on any PR under it", () => {
    const agents = [at("a", "acme/shop#90", "2026-10-01"), at("b", "acme/shop#103", "2026-10-02"), at("c", "acme/shop#7", "2026-10-03")];
    expect(itemSessions(agents, item).map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("SES-03: puts a session that needs me first, then the most recent", () => {
    const agents = [at("old", "acme/shop#90", "2026-10-01", true), at("new", "acme/shop#103", "2026-10-05"), at("mid", "acme/shop#90", "2026-10-03")];
    expect(itemSessions(agents, item).map((a) => a.id)).toEqual(["old", "new", "mid"]);
  });

  it("SES-03: matches keys whatever their case", () => {
    expect(itemSessions([at("a", "Acme/Shop#90", "2026-10-01")], item)).toHaveLength(1);
  });

  it("SES-03: has none once the item is merged or closed", () => {
    expect(itemSessions([at("a", "acme/shop#90", "2026-10-01")], { ...item, closedAt: "2026-10-02" })).toEqual([]);
  });
});

describe("looseSessions", () => {
  const kinded = (id: string, kind?: AgentSummary["kind"]): AgentSummary => ({ ...at(id, "acme/shop#90", "2026-10-01"), kind });

  it("SES-03: keeps sessions with no kind, or whose action the item no longer offers, in order", () => {
    const sessions = [kinded("old"), kinded("fix", "fix"), kinded("address", "address"), kinded("review", "review")];
    expect(looseSessions(sessions, ["address", "rebase"]).map((a) => a.id)).toEqual(["old", "fix", "review"]);
  });

  it("SES-03: leaves out sessions that sit in one of the item's action lines", () => {
    expect(looseSessions([kinded("a", "rebase")], ["rebase"])).toEqual([]);
  });
});

describe("sessionTitle", () => {
  const pr = { kind: "pr" as const, number: 123, title: "Faster product search" };
  it("names a review as one [SES-09]", () => {
    expect(sessionTitle("review", pr)).toBe("Review PR 123: Faster product search");
  });
  it("leaves work on my own PRs and issues unprefixed", () => {
    expect(sessionTitle("fix", pr)).toBe("PR 123: Faster product search");
    expect(sessionTitle("start", { kind: "issue", number: 95, title: "Customers forget unpaid invoices" })).toBe("Issue 95: Customers forget unpaid invoices");
  });
  it("keeps a long name within 120 characters", () => {
    expect(sessionTitle("review", { ...pr, title: "x".repeat(200) })).toHaveLength(120);
  });
});
