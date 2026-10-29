import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { blocks, type SetupStatus } from "../shared/setup";

// Fixture mode: names are checked against made-up GitHub data, and gh counts as signed in.
let dir: string;
let setup: typeof import("./setup");
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "attention-span-setup-"));
  process.env.PASEO_ATTENTION_SPAN_DIR = dir;
  process.env.PASEO_ATTENTION_SPAN_FIXTURE = "1";
  vi.resetModules(); // both are read once, at import
  setup = await import("./setup");
  return () => {
    delete process.env.PASEO_ATTENTION_SPAN_FIXTURE;
  };
});

const status = (gh: Partial<SetupStatus["gh"]>, error: string | null = null): SetupStatus => ({
  gh: { found: true, login: "me", error: null, ...gh },
  config: { error, orgs: [], repos: [] },
});

describe("setup", () => {
  it("SET-01: blocks while gh is missing or signed out, or config.json is broken", () => {
    expect(blocks(status({}))).toBe(false);
    expect(blocks(status({ found: false, login: null }))).toBe(true);
    expect(blocks(status({ login: null, error: "gh auth login" }))).toBe(true);
    expect(blocks(status({}, "config.json is invalid"))).toBe(true);
  });

  it("SET-01: reports a broken config.json with the reason", async () => {
    await writeFile(join(dir, "config.json"), "{ not json");
    const result = await setup.setupStatus();
    expect(result.gh.login).toBe("me");
    expect(result.config.error).toMatch(/Can't read .*config\.json/);
  });

  it("SRC-02: checks an org or repo before it's saved, keeping GitHub's exact name", async () => {
    expect(await setup.checkCoverage("repo", " https://github.com/ACME/Shop/ ")).toEqual({ name: "acme/shop", error: null });
    expect(await setup.checkCoverage("org", "Acme")).toEqual({ name: "acme", error: null });
    expect((await setup.checkCoverage("repo", "acme/shpo")).error).toMatch(/acme\/shpo wasn't found/);
    expect((await setup.checkCoverage("repo", "shop")).error).toMatch(/owner\/name/);
    expect((await setup.checkCoverage("org", "acme/shop")).error).toMatch(/organization's name/);
  });
});
