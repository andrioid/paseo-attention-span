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

  it("ATT-11: a cache with an item in a section that's gone is dropped, so it can't break the screen", async () => {
    await mkdir(newDir(), { recursive: true });
    const old = { key: "acme/shop#1", section: "too_long" };
    const live = { fetchedAt: "x", attention: { login: "me", items: [old], assigned: [], unclaimed: [] } };
    await writeFile(join(newDir(), "state.json"), JSON.stringify({ live, history: { fetchedAt: "x", items: [{ ...old, section: "done" }, old] } }));
    const state = await store.loadState();
    expect([state.live, state.history]).toEqual([null, null]);
    const fine = { ...live, attention: { ...live.attention, items: [{ ...old, section: "wait_review" }] } };
    expect(store.State.parse({ live: fine }).live).toEqual(fine);
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

  it("NXT-04: choosing fields keeps a field's hand-written order, and None is saved as null", async () => {
    await mkdir(newDir(), { recursive: true });
    const effort = { field: "Effort", order: ["Tiny", "Large"] };
    await writeFile(join(newDir(), "config.json"), JSON.stringify({ nextUp: { repos: ["acme/shop"], effort, priority: { field: "Prio", order: ["A"] } } }));
    const config = await store.saveNextUpFields({ priority: "Priority", effort: "effort", scope: null });
    expect(config.nextUp).toMatchObject({ repos: ["acme/shop"], priority: { field: "Priority" }, effort: { field: "effort", order: ["Tiny", "Large"] }, scope: null });
    expect(JSON.parse(await readFile(join(newDir(), "config.json"), "utf8")).nextUp.priority).toEqual({ field: "Priority" });
  });

  it("NXT-04: choosing one field leaves the others as they are, so one never chosen is still found by its name", async () => {
    await mkdir(newDir(), { recursive: true });
    await writeFile(join(newDir(), "config.json"), JSON.stringify({ nextUp: { effort: { field: "Size" } } }));
    await store.saveNextUpFields({ scope: "Team" });
    expect(JSON.parse(await readFile(join(newDir(), "config.json"), "utf8")).nextUp).toEqual({ effort: { field: "Size" }, scope: { field: "Team" } });
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
