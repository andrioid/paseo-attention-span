import type { ConfigStatus, CoverageCheck, CoverageKind, SetupStatus } from "../shared/setup";
import { FIXTURE_ORGS, FIXTURE_REPOS } from "./fixture";
import { FIXTURE, runGh } from "./gh";
import { CONFIG, loadConfig } from "./store";

// What the setup checklist needs [SET-01]. Asked only when Attention Span can't load.
export async function setupStatus(): Promise<SetupStatus> {
  return { gh: FIXTURE ? { found: true, login: "me", error: null } : await ghStatus(), config: await configStatus() };
}

// `gh api user` answers both questions at once: is gh there, and who is it signed in as.
async function ghStatus(): Promise<SetupStatus["gh"]> {
  try {
    const { code, stdout, stderr } = await runGh(["api", "user", "--jq", ".login"]);
    const login = stdout.trim();
    return code === 0 && login ? { found: true, login, error: null } : { found: true, login: null, error: stderr.trim() || `gh exited with ${code}` };
  } catch (error) {
    return { found: false, login: null, error: (error as Error).message };
  }
}

export async function configStatus(): Promise<ConfigStatus> {
  try {
    const { orgs, repos } = await loadConfig();
    return { path: CONFIG, error: null, orgs, repos };
  } catch (error) {
    return { path: CONFIG, error: (error as Error).message, orgs: [], repos: [] };
  }
}

// An org or repo is checked on GitHub before it's saved, so a typo shows right away [SRC-02].
// Pasted GitHub URLs are accepted. The exact name GitHub returns is what gets saved.
export async function checkCoverage(kind: CoverageKind, input: string): Promise<CoverageCheck> {
  const name = input.trim().replace(/^(https?:\/\/)?github\.com\//i, "").replace(/\/+$/, "");
  if (kind === "org" && !/^[\w.-]+$/.test(name)) return { name: null, error: "Use the organization's name, like acme" };
  if (kind === "repo" && !/^[\w.-]+\/[\w.-]+$/.test(name)) return { name: null, error: "Use owner/name, like acme/shop" };
  if (FIXTURE) {
    const known = (kind === "org" ? FIXTURE_ORGS : FIXTURE_REPOS).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return known ? { name: known, error: null } : { name: null, error: `${name} wasn't found on GitHub` };
  }
  const { code, stdout, stderr } = await runGh(["api", kind === "org" ? `users/${name}` : `repos/${name}`, "--jq", kind === "org" ? ".login + \" \" + .type" : ".full_name"]);
  if (code !== 0) return { name: null, error: /404|Not Found/i.test(stderr) ? `${name} wasn't found on GitHub, or gh's account can't see it` : stderr.trim() || `gh exited with ${code}` };
  if (kind === "repo") return { name: stdout.trim(), error: null };
  // Searches use org:, which matches organizations only.
  const [login, type] = stdout.trim().split(" ");
  return type === "Organization" ? { name: login, error: null } : { name: null, error: `${login} is a person, not an organization. Add their repos instead` };
}
