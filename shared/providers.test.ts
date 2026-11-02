import { describe, expect, it } from "vitest";
import { chooseAgent, NO_PROVIDER, readyProviders } from "./providers";

const claude = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude",
  models: [{ id: "sonnet" }, { id: "opus", isDefault: true }],
  defaultModeId: "default",
};
const codex = { provider: "codex", status: "ready", enabled: true, label: "Codex", models: [{ id: "gpt-5" }] };

describe("readyProviders", () => {
  it("SES-06: keeps ready, enabled providers with their default model", () => {
    const entries = [{ ...claude, status: "loading" }, { ...codex, enabled: false }, claude, codex];
    expect(readyProviders(entries)).toEqual([
      { provider: "claude", label: "Claude", defaultModel: "opus", defaultModeId: "default" },
      { provider: "codex", label: "Codex", defaultModel: "gpt-5", defaultModeId: undefined },
    ]);
  });

  it("SES-06: names a provider without a label by its id", () => {
    expect(readyProviders([{ ...codex, label: undefined }])[0].label).toBe("codex");
  });
});

describe("chooseAgent", () => {
  const providers = readyProviders([claude, codex]);

  it("SES-06: starts with the first ready provider's default model when no profile matches", () => {
    expect(chooseAgent(undefined, providers)).toEqual({
      label: "Paseo default (Claude)",
      agent: { provider: "claude/opus", modeId: "default" },
    });
  });

  it("SES-06: skips providers that list no model", () => {
    expect(chooseAgent(undefined, readyProviders([{ ...claude, models: [] }, codex])).agent.provider).toBe("codex/gpt-5");
  });

  it("SES-06: says no provider is ready when none is", () => {
    expect(() => chooseAgent(undefined, [])).toThrow(NO_PROVIDER);
  });

  it("SES-01: gives a profile without a model its provider's default model", () => {
    const profile = { name: "Review", provider: "codex", modeId: "auto" };
    expect(chooseAgent(profile, providers)).toEqual({ label: "Review", agent: { provider: "codex/gpt-5", modeId: "auto" } });
  });

  it("SES-01: keeps the model a profile names", () => {
    expect(chooseAgent({ name: "Deep", provider: "claude", model: "sonnet" }, []).agent.provider).toBe("claude/sonnet");
  });

  it("SES-01: leaves the model to Paseo when the profile's provider isn't ready", () => {
    expect(chooseAgent({ name: "Gem", provider: "gemini" }, providers).agent.provider).toBe("gemini");
  });
});
