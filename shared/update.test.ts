import { describe, expect, it } from "vitest";
import { updateNotice } from "./update";

// Trimmed from what `paseo plugin update attention-span --check --json` printed on Paseo 0.15.0.
const npm = (outcome: string, from: string, to: string) => [
  {
    id: "attention-span",
    outcome,
    current: { identity: { kind: "npm", packageName: "@andrioid/paseo-attention-span", pluginPath: "." }, currentRevision: from },
    target: { kind: "npm", version: to },
    links: [`https://www.npmjs.com/package/@andrioid/paseo-attention-span/v/${from}`, `https://www.npmjs.com/package/@andrioid/paseo-attention-span/v/${to}`],
  },
];
const OLD = "0c6bc21d884cc5e430a70d30ca112e71d6828277";
const NEW = "476d3e5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMPARE = `https://github.com/andrioid/paseo-attention-span/compare/${OLD}...${NEW}`;
const git = [{ id: "attention-span", outcome: "update", current: { identity: { kind: "git" }, currentRevision: OLD }, target: { kind: "git", commit: NEW }, links: [COMPARE] }];

describe("updateNotice", () => {
  it("UPD-01: offers a newer npm or registry release, with the command and the release notes", () => {
    expect(updateNotice("attention-span", npm("update", "0.4.2", "0.4.3"))).toEqual({
      id: "attention-span",
      current: "0.4.2",
      latest: "0.4.3",
      source: "npm",
      args: ["--version", "0.4.3"],
      command: "paseo plugin update attention-span",
      notes: "https://github.com/andrioid/paseo-attention-span/releases",
    });
  });

  it("UPD-01: updates a registry install to its reviewed pin, which Paseo won't let it name", () => {
    const registry = npm("update", "0.4.2", "0.4.3").map((entry) => ({ ...entry, current: { ...entry.current, identity: { ...entry.current.identity, registry: { url: "https://plugins.paseo.sh", id: "andrioid/attention-span" } } } }));
    expect(updateNotice("attention-span", registry)).toMatchObject({ source: "registry", args: ["--yes"], latest: "0.4.3" });
  });

  it("UPD-01: offers new commits on a Git install, short, with Paseo's compare link", () => {
    expect(updateNotice("attention-span", git)).toMatchObject({ current: "0c6bc21", latest: "476d3e5", source: "git", args: ["--ref", NEW], notes: COMPARE });
  });

  it("UPD-01: names the runtime ID it's installed under", () => {
    const dev = npm("update", "0.4.2", "0.4.3").map((entry) => ({ ...entry, id: "attention-span-dev" }));
    expect(updateNotice("attention-span-dev", dev)?.command).toBe("paseo plugin update attention-span-dev");
  });

  it("UPD-01: says nothing when it's current, a directory install, failed, or about another plugin", () => {
    expect(updateNotice("attention-span", npm("current", "0.4.3", "0.4.3"))).toBeNull();
    expect(updateNotice("attention-span", [{ id: "attention-span", outcome: "local", current: { identity: { kind: "directory", path: "/plugin" } }, links: [] }])).toBeNull();
    expect(updateNotice("attention-span", [{ id: "attention-span", outcome: "error", links: [], error: "Plugin is not configured: attention-span" }])).toBeNull();
    expect(updateNotice("attention-span", npm("update", "0.4.2", "0.4.3").map((entry) => ({ ...entry, id: "other" })))).toBeNull();
    expect(updateNotice("attention-span", "not json output")).toBeNull();
  });
});
