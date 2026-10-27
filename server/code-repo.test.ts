import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findCheckout } from "../client/sessions";
import { codeRepoFor, InboxConfig } from "../shared/config";
import type { Target } from "../shared/inbox";

let dir: string;
let store: typeof import("./store");
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "github-attention-"));
  process.env.PASEO_GITHUB_ATTENTION_DIR = dir;
  store = await import("./store");
});

const issue: Target = { kind: "issue", repo: "acme/issues", number: 7, title: "Export breaks", url: "u", defaultBranch: "trunk" };
const paseo = (keys: string[]) =>
  ({ projects: { list: async () => ({ projects: keys.map((key, i) => ({ projectId: `p${i}`, projectKey: key, projectRootPath: `/src/${i}` })) }) } }) as never;
const branches = async (repo: string) => (repo === "acme/shop" ? "main" : null);

describe("code repos", () => {
  it("SES-07: maps an issue repo to the repo its code lives in, ignoring case", () => {
    const config = InboxConfig.parse({ codeRepos: { "Acme/Issues": "acme/shop" } });
    expect(codeRepoFor(config, "acme/issues")).toBe("acme/shop");
    expect(codeRepoFor(config, "acme/shop")).toBe("acme/shop");
  });

  it("SES-07: starts an issue in the mapped repo's checkout, from that repo's default branch", async () => {
    const config = InboxConfig.parse({ codeRepos: { "acme/issues": "acme/shop" } });
    const checkout = await findCheckout(paseo(["remote:github.com/acme/shop"]), config, issue, branches);
    expect(checkout).toEqual({ repo: "acme/shop", project: { repo: "acme/shop", projectId: "p0", rootPath: "/src/0" }, baseBranch: "main" });
  });

  it("SES-05: without a mapping, uses the item's own repo and default branch", async () => {
    const checkout = await findCheckout(paseo(["remote:github.com/acme/issues"]), InboxConfig.parse({}), issue, branches);
    expect(checkout).toMatchObject({ repo: "acme/issues", project: { projectId: "p0" }, baseBranch: "trunk" });
    const missing = await findCheckout(paseo(["remote:github.com/acme/shop"]), InboxConfig.parse({}), issue, branches);
    expect(missing).toMatchObject({ repo: "acme/issues", project: null });
  });

  it("SES-05: pull requests keep their own repo even when it is mapped", async () => {
    const pr: Target = { ...issue, kind: "pr", repo: "acme/issues" };
    const config = InboxConfig.parse({ codeRepos: { "acme/issues": "acme/shop" } });
    expect((await findCheckout(paseo(["remote:github.com/acme/issues"]), config, pr, branches)).repo).toBe("acme/issues");
  });

  it("SES-07: saving a mapping keeps the rest of config.json", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ orgs: ["acme"], codeRepos: { "ACME/ISSUES": "acme/old", "acme/other": "acme/x" }, extra: 1 }));
    const config = await store.saveCodeRepo("acme/issues", "acme/shop");
    expect(config.codeRepos).toEqual({ "acme/other": "acme/x", "acme/issues": "acme/shop" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ orgs: ["acme"], codeRepos: { "acme/other": "acme/x", "acme/issues": "acme/shop" }, extra: 1 });
  });

  it("SES-07: leaves a broken config.json alone", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not json");
    await expect(store.saveCodeRepo("acme/issues", "acme/shop")).rejects.toThrow(/Can't read/);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});
