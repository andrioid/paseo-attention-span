import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { blocks, type SetupStatus } from "../shared/setup";
import { checkCoverage, setupStatus } from "./setup";
import { createStore, type Store } from "./store";

// Fixture mode: names are checked against made-up GitHub data, and gh counts as signed in.
let dir: string;
let store: Store;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "attention-span-setup-"));
  store = createStore(dir);
});

const status = (gh: Partial<SetupStatus["gh"]>, error: string | null = null): SetupStatus => ({
  gh: { found: true, login: "me", error: null, ...gh },
  config: { error, orgs: [], repos: [], nextUp: { mine: false, orgs: [], repos: [] }, fields: {}, followThreads: false },
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
    const result = await setupStatus(store, true);
    expect(result.gh.login).toBe("me");
    expect(result.config.error).toMatch(/Can't read .*config\.json/);
  });

  it("SRC-02: checks an org or repo before it's saved, keeping GitHub's exact name", async () => {
    expect(await checkCoverage("repo", " https://github.com/ACME/Shop/ ", true)).toEqual({ name: "acme/shop", error: null });
    expect(await checkCoverage("org", "Acme", true)).toEqual({ name: "acme", error: null });
    expect((await checkCoverage("repo", "acme/shpo", true)).error).toMatch(/acme\/shpo wasn't found/);
    expect((await checkCoverage("repo", "shop", true)).error).toMatch(/owner\/name/);
    expect((await checkCoverage("org", "acme/shop", true)).error).toMatch(/organization's name/);
  });
});
