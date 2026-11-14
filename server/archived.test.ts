import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { ArchivedInPaseo, archivedItem, type ArchiveEvent, stillOpen } from "./archived";

type Paseo = PluginHandlerContext["paseo"];

const AT = "2026-11-14T12:00:00.000Z";
const event = (fields: Partial<ArchiveEvent> = {}): ArchiveEvent => ({ agentId: "a", parentAgentId: null, archivedAt: AT, ...fields });
const labelled = (itemKey: string, marker = "attention-span") => ({ [marker]: "1", [`${marker}-item`]: itemKey });

interface FakeAgent {
  id: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}

// Paseo's agents as the archive decision reads them: label filters, archived ones only on request, two per page.
function paseoFor(agents: FakeAgent[], fail: { refresh?: boolean; list?: boolean } = {}) {
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          if (fail.refresh) throw new Error("offline");
          const agent = agents.find((other) => other.id === id);
          return agent ? { agent } : null;
        },
      }),
      list: async ({ filter, page }: { filter?: { labels?: Record<string, string>; includeArchived?: boolean }; page?: { cursor?: string } } = {}) => {
        if (fail.list) throw new Error("offline");
        const matching = agents.filter(
          (agent) => (filter?.includeArchived || !agent.archivedAt) && Object.entries(filter?.labels ?? {}).every(([key, value]) => agent.labels?.[key] === value),
        );
        const start = Number(page?.cursor ?? 0);
        const next = start + 2;
        return { entries: matching.slice(start, next).map((agent) => ({ agent })), pageInfo: { hasMore: next < matching.length, nextCursor: next < matching.length ? String(next) : null } };
      },
    },
  };
  return api as unknown as Paseo;
}

function watcher(groups: Record<string, string[]> = {}) {
  const acknowledged: { keys: string[]; upTo: string }[] = [];
  const archived = new ArchivedInPaseo({
    groupKeysOf: (itemKey) => groups[itemKey] ?? [itemKey],
    acknowledge: async (keys, upTo) => void acknowledged.push({ keys, upTo }),
  });
  return { archived, acknowledged };
}

describe("the item of a session archived in Paseo", () => {
  it("ATT-22: a session Attention Span started, under any of its names, gives its item", () => {
    expect(archivedItem(event(), { labels: labelled("acme/shop#1"), archivedAt: AT })).toEqual({ itemKey: "acme/shop#1" });
    expect(archivedItem(event(), { labels: labelled("acme/shop#1", "github-inbox"), archivedAt: AT })).toEqual({ itemKey: "acme/shop#1" });
  });

  it("ATT-22: sub-agents, unlabelled sessions and restored ones acknowledge nothing", () => {
    expect(archivedItem(event({ parentAgentId: "p" }), { labels: labelled("acme/shop#1"), archivedAt: AT })).toBe("drop");
    expect(archivedItem(event(), { labels: { ...labelled("acme/shop#1"), "paseo.parent-agent-id": "p" }, archivedAt: AT })).toBe("drop");
    expect(archivedItem(event(), { labels: {}, archivedAt: AT })).toBe("drop");
    expect(archivedItem(event(), { labels: labelled("acme/shop#1"), archivedAt: null })).toBe("drop");
    expect(archivedItem(event(), { labels: labelled("acme/shop#1"), archivedAt: "2026-11-14T13:00:00.000Z" })).toBe("drop");
  });

  it("ATT-22: a session Paseo can't find yet waits", () => {
    expect(archivedItem(event(), null)).toBe("wait");
  });

  it("ATT-22: another open session on any key holds it back, ignoring case", () => {
    const open = [{ labels: labelled("Acme/Shop#2"), archivedAt: null }];
    expect(stillOpen(["acme/shop#1", "acme/shop#2"], open)).toBe(true);
    expect(stillOpen(["acme/shop#1"], open)).toBe(false);
    expect(stillOpen(["acme/shop#2"], [{ labels: labelled("acme/shop#2"), archivedAt: AT }])).toBe(false);
  });
});

describe("noticing sessions archived in Paseo", () => {
  it("HIS-07, ATT-22: the last session on the group acknowledges the group's notes up to the archive", async () => {
    const { archived, acknowledged } = watcher({ "acme/shop#1": ["acme/shop#1", "acme/shop#2"] });
    await archived.notice(paseoFor([{ id: "a", labels: labelled("acme/shop#1"), archivedAt: AT }]), event());
    expect(acknowledged).toEqual([{ keys: ["acme/shop#1", "acme/shop#2"], upTo: AT }]);
    expect(archived.waiting).toBe(0);
  });

  it("HIS-07, ATT-22: an open session on another part of the stack, on a later page, holds it back", async () => {
    const { archived, acknowledged } = watcher({ "acme/shop#1": ["acme/shop#1", "acme/shop#2"] });
    const others = ["x", "y", "z"].map((id) => ({ id, labels: labelled("acme/other#9"), archivedAt: null }));
    const paseo = paseoFor([{ id: "a", labels: labelled("acme/shop#1"), archivedAt: AT }, ...others, { id: "b", labels: labelled("acme/shop#2"), archivedAt: null }]);
    await archived.notice(paseo, event());
    expect(acknowledged).toEqual([]);
    expect(archived.waiting).toBe(0);
  });

  it("HIS-07, ATT-22: a session that couldn't be looked up is tried again, and a restored one is let go", async () => {
    const { archived, acknowledged } = watcher();
    const agents: FakeAgent[] = [{ id: "a", labels: labelled("acme/shop#1"), archivedAt: AT }];
    await archived.notice(paseoFor(agents, { list: true }), event());
    expect(acknowledged).toEqual([]);
    expect(archived.waiting).toBe(1);
    await archived.notice(paseoFor(agents));
    expect(acknowledged).toHaveLength(1);
    expect(archived.waiting).toBe(0);

    await archived.notice(paseoFor(agents, { list: true }), event());
    agents[0].archivedAt = null;
    await archived.notice(paseoFor(agents));
    expect(acknowledged).toHaveLength(1);
    expect(archived.waiting).toBe(0);
  });

  it("ATT-22: a session restored while its archive is decided holds it back", async () => {
    const { archived, acknowledged } = watcher();
    const agents: FakeAgent[] = [{ id: "a", labels: labelled("acme/shop#1"), archivedAt: AT }];
    const paseo = paseoFor(agents);
    const refresh = paseo.agents.ref("a").refresh;
    (paseo.agents as { ref: unknown }).ref = () => ({
      refresh: async () => {
        const found = await refresh();
        agents[0] = { ...agents[0], archivedAt: null }; // restored right after the lookup
        return found;
      },
    });
    await archived.notice(paseo, event());
    expect(acknowledged).toEqual([]);
    expect(archived.waiting).toBe(0);
  });

  it("ATT-22: a sub-agent's archive is never looked up", async () => {
    const { archived, acknowledged } = watcher();
    await archived.notice(paseoFor([], { refresh: true, list: true }), event({ parentAgentId: "p" }));
    expect(acknowledged).toEqual([]);
    expect(archived.waiting).toBe(0);
  });
});
