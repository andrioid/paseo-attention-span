import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDir } from "./feedback";

// A Paseo home whose config.json lists the given plugin sources, each with a manifest of the given ID.
function paseoHome(plugins: Record<string, string>): { home: string; dirs: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
  const dirs: Record<string, string> = {};
  for (const [key, id] of Object.entries(plugins)) {
    dirs[key] = join(home, "src", key);
    mkdirSync(dirs[key], { recursive: true });
    writeFileSync(join(dirs[key], "paseo-plugin.json"), JSON.stringify({ id }));
  }
  const config = { plugins: Object.fromEntries(Object.entries(dirs).map(([key, path]) => [key, { source: "directory", path }])) };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return { home, dirs };
}

describe("pluginDir", () => {
  it("FB-01: finds this plugin's source in Paseo's config.json", () => {
    const { home, dirs } = paseoHome({ other: "other-plugin", "attention-span": "attention-span" });
    expect(pluginDir(home)).toBe(dirs["attention-span"]);
  });

  it("FB-01: finds a copy installed under another ID by its manifest", () => {
    const { home, dirs } = paseoHome({ "attention-span-dev": "attention-span" });
    expect(pluginDir(home)).toBe(dirs["attention-span-dev"]);
  });

  it("FB-01: prefers the install under its own ID", () => {
    const { home, dirs } = paseoHome({ "attention-span-dev": "attention-span", "attention-span": "attention-span" });
    expect(pluginDir(home)).toBe(dirs["attention-span"]);
  });

  it("FB-01: has none, rather than failing, without a config", () => {
    expect(pluginDir(join(tmpdir(), "no-such-paseo-home"))).toBeNull();
  });
});
