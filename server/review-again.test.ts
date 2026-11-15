import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import { sendFollowUp } from "./review-again";

type Paseo = PluginHandlerContext["paseo"];

// One agent as Paseo has it now, recording what it was sent.
function paseoWith(agent: { status: string; pendingPermissions?: unknown[] } | null) {
  const sent: string[] = [];
  const api = { agents: { ref: () => ({ refresh: async () => (agent ? { agent } : null), send: async (text: string) => void sent.push(text) }) } };
  return { paseo: api as unknown as Paseo, sent };
}

describe("sending a Review session the follow-up", () => {
  it("REV-02: an idle session is sent it", async () => {
    const { paseo, sent } = paseoWith({ status: "idle", pendingPermissions: [] });
    expect(await sendFollowUp(paseo, "a1", async () => "what changed")).toBe("sent");
    expect(sent).toEqual(["what changed"]);
  });

  it("REV-02: a session working, starting, or waiting on a permission is sent nothing, and nothing is fetched for it", async () => {
    for (const agent of [{ status: "running" }, { status: "initializing" }, { status: "idle", pendingPermissions: [{}] }]) {
      const { paseo, sent } = paseoWith(agent);
      const prompt = vi.fn(async () => "what changed");
      expect(await sendFollowUp(paseo, "a1", prompt)).toBe("busy");
      expect(sent).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
    }
  });

  it("REV-02: a session that starts working while the prompt is fetched is sent nothing", async () => {
    const agent = { status: "idle" };
    const { paseo, sent } = paseoWith(agent);
    expect(await sendFollowUp(paseo, "a1", async () => ((agent.status = "running"), "what changed"))).toBe("busy");
    expect(sent).toEqual([]);
  });

  it("REV-02: a session Paseo no longer has fails, so the screen says so", async () => {
    await expect(sendFollowUp(paseoWith(null).paseo, "a1", async () => "")).rejects.toThrow("The review session wasn't found");
  });
});
