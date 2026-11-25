import { describe, expect, it } from "vitest";
import type { AgentSummary } from "./attention";
import { applySnapshot, applyUpdates, emptyEntries, type SessionEntries, sessionsOf, writeResult } from "./session-cache";
import { paseoWorkspace, startedAgent } from "./test-builders";

const ids = (entries: SessionEntries) => sessionsOf(entries).map((session) => session.id);
const status = (entries: SessionEntries, id: string) => sessionsOf(entries).find((session: AgentSummary) => session.id === id)?.status;
const a = startedAgent("a", "acme/shop#1");
const b = startedAgent("b", "acme/shop#2");

describe("the session cache", () => {
  it("FRESH-04: a list gives its sessions; a later list without one drops it", () => {
    const listed = applySnapshot(undefined, { agents: [a, b], workspaces: [] }, 1);
    expect(ids(listed)).toEqual(["a", "b"]);
    expect(ids(applySnapshot(listed, { agents: [b], workspaces: [] }, 2))).toEqual(["b"]);
  });

  it("FRESH-04: Paseo's stream adds, changes, archives and removes sessions", () => {
    const listed = applySnapshot(undefined, { agents: [a], workspaces: [] }, 1);
    const added = applyUpdates(listed, [{ of: "agent", kind: "upsert", entry: b, at: 2 }]);
    expect(ids(added)).toEqual(["a", "b"]);
    expect(status(applyUpdates(added, [{ of: "agent", kind: "upsert", entry: { ...b, status: "running" }, at: 3 }]), "b")).toBe("running");
    expect(ids(applyUpdates(added, [{ of: "agent", kind: "upsert", entry: { ...a, archivedAt: "2026-11-25" }, at: 3 }]))).toEqual(["b"]);
    expect(ids(applyUpdates(added, [{ of: "agent", kind: "remove", id: "b", at: 3 }]))).toEqual(["a"]);
  });

  it("FRESH-04: a session loses its workspace when Paseo removes it", () => {
    const inside = startedAgent("a", "acme/shop#1", "fix", { workspaceId: "w1" });
    const listed = applySnapshot(undefined, { agents: [inside], workspaces: [paseoWorkspace("w1", "fix-1")] }, 1);
    expect(sessionsOf(listed)[0].workspace).toMatchObject({ branch: "fix-1" });
    expect(sessionsOf(applyUpdates(listed, [{ of: "workspace", kind: "remove", id: "w1", at: 2 }]))[0].workspace).toBeUndefined();
  });

  it("FRESH-04: an update older on the stream than the last for that session is dropped; a new generation counts afresh", () => {
    const working = applyUpdates(emptyEntries(), [{ of: "agent", kind: "upsert", entry: { ...a, status: "running" }, at: 1, seq: 5, generation: "g1" }]);
    const late = applyUpdates(working, [{ of: "agent", kind: "upsert", entry: { ...a, status: "initializing" }, at: 2, seq: 4, generation: "g1" }]);
    expect(status(late, "a")).toBe("running");
    expect(status(applyUpdates(working, [{ of: "agent", kind: "upsert", entry: a, at: 2, seq: 1, generation: "g2" }]), "a")).toBe("idle");
  });

  it("FRESH-04: what the stream said after a list was asked for stands when the list lands; what it said before doesn't", () => {
    const streamed = applyUpdates(emptyEntries(), [
      { of: "agent", kind: "upsert", entry: { ...a, status: "running" }, at: 5 },
      { of: "agent", kind: "upsert", entry: b, at: 5 },
    ]);
    const landed = applySnapshot(streamed, { agents: [a], workspaces: [] }, 3);
    expect(ids(landed)).toEqual(["a", "b"]);
    expect(status(landed, "a")).toBe("running");
    const removed = applyUpdates(applySnapshot(undefined, { agents: [a, b], workspaces: [] }, 1), [{ of: "agent", kind: "remove", id: "b", at: 5 }]);
    expect(ids(applySnapshot(removed, { agents: [a, b], workspaces: [] }, 3))).toEqual(["a"]);
    expect(status(applySnapshot(streamed, { agents: [a], workspaces: [] }, 7), "a")).toBe("idle");
    expect(ids(applySnapshot(streamed, { agents: [a], workspaces: [] }, 7))).toEqual(["a"]);
  });

  it("FRESH-04: an action's archive can't be undone by a list asked for before it, or an update that arrived before it", () => {
    const listed = applySnapshot(undefined, { agents: [a, b], workspaces: [] }, 1);
    const archived = writeResult(listed, { archivedAgents: ["a"] }, 4);
    expect(ids(archived)).toEqual(["b"]);
    expect(ids(applySnapshot(archived, { agents: [a, b], workspaces: [] }, 3))).toEqual(["b"]);
    expect(ids(applyUpdates(archived, [{ of: "agent", kind: "upsert", entry: { ...a, status: "running" }, at: 2 }]))).toEqual(["b"]);
    // Once it's undone in Paseo, say, the stream and lists after it are believed again.
    expect(ids(applyUpdates(archived, [{ of: "agent", kind: "upsert", entry: a, at: 5 }]))).toEqual(["a", "b"]);
    expect(ids(applySnapshot(archived, { agents: [a, b], workspaces: [] }, 5))).toEqual(["a", "b"]);
  });

  it("FRESH-04: a list asked for before an archive can't bring it back after a newer list already dropped it", () => {
    const listed = applySnapshot(undefined, { agents: [a, b], workspaces: [] }, 1);
    // An old list asked at 2, the archive at 3, a newer list asked at 4 lands first, then the old one.
    const archived = writeResult(listed, { archivedAgents: ["a"] }, 3);
    const newer = applySnapshot(archived, { agents: [b], workspaces: [] }, 4);
    expect(ids(applySnapshot(newer, { agents: [a, b], workspaces: [] }, 2))).toEqual(["b"]);
  });

  it("FRESH-04: a session an action started stays until a list asked for after it has Paseo's own", () => {
    const started = writeResult(applySnapshot(undefined, { agents: [a], workspaces: [] }, 1), { agents: [{ ...b, status: "running" }], workspaces: [paseoWorkspace("w2", "fix-2")] }, 4);
    expect(ids(applySnapshot(started, { agents: [a], workspaces: [] }, 3))).toEqual(["a", "b"]);
    expect(status(applySnapshot(started, { agents: [a, b], workspaces: [] }, 5), "b")).toBe("idle");
  });
});
