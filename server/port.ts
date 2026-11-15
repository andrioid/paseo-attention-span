import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ArchiveResult } from "../shared/archive";
import { githubRepoOf } from "../shared/config";
import { archiveSessions } from "./archive";
import { type GitHub, gitHub } from "./fetch";
import { graphql, graphqlResult } from "./gh";
import type { Store } from "./store";

type Paseo = PluginHandlerContext["paseo"];

// Everything the service reaches outside itself: GitHub, Paseo, its files and the clock. Real here; made up for previews
// in fixture.ts, and for tests.
export interface Port {
  github: GitHub;
  paseo: {
    // My Paseo projects' GitHub repos [NXT-08].
    projectRepos(paseo: Paseo): Promise<string[]>;
    // Archives sessions, and `worktrees` kept before, tried again on their own [ATT-22].
    archive(paseo: Paseo, agentIds: string[], confirm: boolean, terminals: string[], worktrees: string[]): Promise<ArchiveResult>;
  };
  store: Store;
  now(): number;
  // Runs `run` once after `ms`; calling the answer cancels it.
  setTimer(run: () => void, ms: number): () => void;
}

export function setTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export function realPort(store: Store): Port {
  return {
    github: gitHub({ graphql, graphqlResult }),
    paseo: {
      projectRepos: async (paseo) => {
        const { projects } = await paseo.projects.list();
        return [...new Set(projects.map((project) => githubRepoOf(project.projectKey)).filter((repo): repo is string => !!repo))].sort();
      },
      archive: archiveSessions,
    },
    store,
    now: Date.now,
    setTimer,
  };
}
