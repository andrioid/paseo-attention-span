import { describe, expect, it, vi } from "vitest";
import type { StreamUpdate } from "../shared/session-cache";
import { startedAgent } from "../shared/test-builders";
import { paseoSource } from "./session-source";

type Listener = (update: Record<string, unknown>) => void;

// A host whose two lists answer when the test says, each with an owned subscription when asked to stream.
function host() {
  const listeners: { agents: Listener[]; workspaces: Listener[] } = { agents: [], workspaces: [] };
  const answers: Record<"agents" | "workspaces", { resolve: (value: unknown) => void; reject: (error: Error) => void }> = {} as never;
  const released: string[] = [];
  const subscription = (subscriptionId: string) => ({ subscriptionId, release: vi.fn(async () => void released.push(subscriptionId)) });
  const list = (kind: "agents" | "workspaces") => () => new Promise((resolve, reject) => (answers[kind] = { resolve, reject }));
  const paseo = {
    agents: { list: list("agents"), subscribe: (listener: Listener) => (listeners.agents.push(listener), () => {}) },
    workspaces: { list: list("workspaces"), subscribe: (listener: Listener) => (listeners.workspaces.push(listener), () => {}) },
  };
  const page = (entries: unknown[], id: string) => ({ entries, pageInfo: { hasMore: false }, subscription: subscription(id) });
  return {
    source: paseoSource(paseo as never),
    send: (update: Record<string, unknown>) => listeners.agents.forEach((listener) => listener(update)),
    answerAgents: (entries: unknown[] = [], id = "ours-a") => answers.agents.resolve(page(entries, id)),
    answerWorkspaces: (id = "ours-w") => answers.workspaces.resolve(page([], id)),
    failWorkspaces: () => answers.workspaces.reject(new Error("Paseo is restarting")),
    released,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Paseo's session source", () => {
  it("FRESH-04: removes from Paseo's own filtered lists are left out, even while ours are being listed; ours count", async () => {
    const h = host();
    const updates: StreamUpdate[] = [];
    h.source.subscribe((update) => updates.push(update));
    const listed = h.source.list(true);
    // Before either of our lists is back: a filtered list's remove, and an upsert, which is the whole entry anyway.
    h.send({ kind: "remove", agentId: "a", subscriptionId: "theirs" });
    h.send({ kind: "upsert", agent: startedAgent("b", "acme/shop#2"), subscriptionId: "theirs" });
    h.answerAgents();
    await tick();
    h.send({ kind: "remove", agentId: "c", subscriptionId: "ours-a" });
    h.answerWorkspaces();
    await listed;
    h.send({ kind: "remove", agentId: "d", subscriptionId: "theirs" });
    expect(updates.map((update) => (update.kind === "remove" ? `-${update.id}` : `+${update.entry.id}`))).toEqual(["+b", "-c"]);
  });

  it("FRESH-04: when one list fails, the other's subscription is released, even if it comes back after", async () => {
    const h = host();
    const listed = h.source.list(true);
    h.failWorkspaces();
    await tick();
    h.answerAgents();
    await expect(listed).rejects.toThrow("Paseo is restarting");
    expect(h.released).toEqual(["ours-a"]);
  });
});
