import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { ArchivedInPaseo, type ArchiveEvent } from "./archived";

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

describe("which archives acknowledge", () => {
  // Whether archiving session "a", as Paseo has it now, acknowledges its group's notes, with these other sessions about.
  async function acknowledges(session: Omit<FakeAgent, "id">, others: FakeAgent[] = []) {
    const { archived, acknowledged } = watcher({ "acme/shop#1": ["acme/shop#1", "acme/shop#2"] });
    await archived.notice(paseoFor([{ id: "a", ...session }, ...others]), event());
    return acknowledged.length > 0;
  }

  it.each([
    ["a session Attention Span started", labelled("acme/shop#1"), AT, true],
    ["one started under the plugin's old name", labelled("acme/shop#1", "github-inbox"), AT, true],
    ["a sub-agent", { ...labelled("acme/shop#1"), "paseo.parent-agent-id": "p" }, AT, false],
    ["a session without an item", {}, AT, false],
    ["a restored session", labelled("acme/shop#1"), null, false],
    ["a session archived again since", labelled("acme/shop#1"), "2026-11-14T13:00:00.000Z", false],
  ])("ATT-22: %s acknowledges: %s", async (_, labels, archivedAt, expected) => {
    expect(await acknowledges({ labels, archivedAt })).toBe(expected);
  });

  it("ATT-22: another open session on any key of the group holds it back, ignoring case; archived ones and other work don't", async () => {
    const session = { labels: labelled("acme/shop#1"), archivedAt: AT };
    expect(await acknowledges(session, [{ id: "b", labels: labelled("Acme/Shop#2"), archivedAt: null }])).toBe(false);
    expect(await acknowledges(session, [{ id: "b", labels: labelled("acme/shop#2"), archivedAt: AT }])).toBe(true);
    expect(await acknowledges(session, [{ id: "b", labels: labelled("acme/other#9"), archivedAt: null }])).toBe(true);
  });

  it("ATT-22: a session Paseo can't find yet waits", async () => {
    const { archived, acknowledged } = watcher();
    await archived.notice(paseoFor([]), event());
    expect(acknowledged).toEqual([]);
    expect(archived.waiting).toBe(1);
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
