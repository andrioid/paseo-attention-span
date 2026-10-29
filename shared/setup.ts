// What getting started needs, for the setup checklist [SET-01] and the settings screen [SRC-02].

export interface ConfigStatus {
  // Why config.json can't be read, if it can't. The settings screen won't overwrite it then.
  error: string | null;
  orgs: string[];
  repos: string[];
}

export interface SetupStatus {
  gh: {
    found: boolean;
    // The account gh is signed in as; null when it isn't, with gh's reason in `error`.
    login: string | null;
    error: string | null;
  };
  config: ConfigStatus;
}

// Nothing loads until these are fixed, so the checklist takes the tabs' place.
export function blocks(status: SetupStatus): boolean {
  return !status.gh.found || !status.gh.login || !!status.config.error;
}

// An org or repo checked on GitHub before it's saved: its exact name, or why it can't be added.
export type CoverageCheck = { name: string; error: null } | { name: null; error: string };
export type CoverageKind = "org" | "repo";
