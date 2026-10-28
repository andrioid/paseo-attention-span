import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let store: typeof import("./store");
const oldDir = () => join(home, ".config", "paseo-github-attention");
const newDir = () => join(home, ".config", "paseo-attention-span");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "attention-span-home-"));
  process.env.HOME = home;
  delete process.env.PASEO_ATTENTION_SPAN_DIR;
  delete process.env.PASEO_GITHUB_ATTENTION_DIR;
  vi.resetModules(); // the folders are read once, at import
  store = await import("./store");
  return () => rm(home, { recursive: true, force: true });
});

describe("local files", () => {
  it("PRIV-01: moves the files from before the rename once", async () => {
    await mkdir(oldDir(), { recursive: true });
    await writeFile(join(oldDir(), "config.json"), JSON.stringify({ orgs: ["acme"] }));
    await store.moveOldFiles();
    expect(JSON.parse(await readFile(join(newDir(), "config.json"), "utf8"))).toEqual({ orgs: ["acme"] });
    expect((await store.loadConfig()).orgs).toEqual(["acme"]);
  });

  it("PRIV-01: leaves the old folder alone once the new one exists", async () => {
    await mkdir(oldDir(), { recursive: true });
    await mkdir(newDir(), { recursive: true });
    await writeFile(join(oldDir(), "config.json"), JSON.stringify({ orgs: ["old"] }));
    await store.moveOldFiles();
    expect(JSON.parse(await readFile(join(oldDir(), "config.json"), "utf8"))).toEqual({ orgs: ["old"] });
    expect((await store.loadConfig()).orgs).toEqual([]);
  });

  it("ATT-08: an outdated cache is dropped without losing dismissals", async () => {
    await mkdir(newDir(), { recursive: true });
    const dismissed = { "acme/shop#1": { at: "2026-10-01T00:00:00Z", section: "reply" } };
    await writeFile(join(newDir(), "state.json"), JSON.stringify({ dismissed, live: { fetchedAt: "x", inbox: { unclaimed: [] } } }));
    const state = await store.loadState();
    expect(state.dismissed).toEqual(dismissed);
    expect(state.live).toBeNull();
  });
});

describe("settings", () => {
  it("SRC-02: saving orgs and repos keeps the rest of config.json", async () => {
    await mkdir(newDir(), { recursive: true });
    await writeFile(join(newDir(), "config.json"), JSON.stringify({ orgs: ["old"], nextUp: { repos: ["acme/shop"] }, extra: 1 }));
    const config = await store.saveCoverage(["acme"], ["me/tool"]);
    expect([config.orgs, config.repos]).toEqual([["acme"], ["me/tool"]]);
    expect(JSON.parse(await readFile(join(newDir(), "config.json"), "utf8"))).toEqual({ orgs: ["acme"], repos: ["me/tool"], nextUp: { repos: ["acme/shop"] }, extra: 1 });
  });

  it("SRC-02: leaves a config.json that doesn't parse alone", async () => {
    await mkdir(newDir(), { recursive: true });
    for (const broken of ["{ not json", JSON.stringify({ refreshMinutes: "soon" })]) {
      await writeFile(join(newDir(), "config.json"), broken);
      await expect(store.saveCoverage(["acme"], [])).rejects.toThrow();
      expect(await readFile(join(newDir(), "config.json"), "utf8")).toBe(broken);
    }
  });
});
