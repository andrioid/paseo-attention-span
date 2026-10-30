import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { AttentionView, ItemDetails, Target } from "./attention";
import { SessionKind } from "./config";
import type { ConfigStatus, CoverageCheck, SetupStatus } from "./setup";

// Both sides are this plugin, so the types are checked by TypeScript, not repeated as schemas.
const view = z.custom<AttentionView>();
const target = z.custom<Target>();
const done = z.object({ ok: z.literal(true) });

// The cached view. Feeds older than their schedule are refreshed from GitHub first; `refresh` fetches that feed now (⟳).
export const getAttention = defineRpc({ name: "attention.get", input: z.object({ refresh: z.enum(["live", "history"]).optional() }), output: view });
export const dismissItem = defineRpc({ name: "attention.dismiss", input: z.object({ key: z.string() }), output: view });
// Undo one dismissal [ATT-08].
export const undismissItem = defineRpc({ name: "attention.undismiss", input: z.object({ key: z.string() }), output: view });
export const restoreDismissed = defineRpc({ name: "attention.restore-dismissed", input: z.object({}), output: view });
// Adds one entry to codeRepos in config.json [SES-07].
export const setCodeRepo = defineRpc({ name: "config.set-code-repo", input: z.object({ issueRepo: z.string(), codeRepo: z.string() }), output: view });
// What the setup checklist shows when nothing loads [SET-01].
export const setupStatus = defineRpc({ name: "setup.status", input: z.object({}), output: z.custom<SetupStatus>() });
// The settings screen: the orgs and repos in config.json, each checked on GitHub as it's added [SRC-02].
export const getCoverage = defineRpc({ name: "config.coverage", input: z.object({}), output: z.custom<ConfigStatus>() });
export const checkCoverage = defineRpc({ name: "config.check-coverage", input: z.object({ kind: z.enum(["org", "repo"]), name: z.string() }), output: z.custom<CoverageCheck>() });
export const setCoverage = defineRpc({ name: "config.set-coverage", input: z.object({ orgs: z.array(z.string()), repos: z.array(z.string()) }), output: done });
// Where Next up looks, chosen in settings [NXT-04]; orgs are picked from the ones I belong to.
export const setNextUpSources = defineRpc({ name: "config.set-next-up", input: z.object({ mine: z.boolean(), orgs: z.array(z.string()), repos: z.array(z.string()) }), output: done });
export const myOrgs = defineRpc({ name: "config.my-orgs", input: z.object({}), output: z.object({ orgs: z.array(z.string()) }) });
// Remember the scopes and sources ticked in Next up's filter [NXT-03, NXT-09].
export const setScopes = defineRpc({ name: "next-up.scopes", input: z.object({ scopes: z.array(z.string()) }), output: done });
export const setSources = defineRpc({ name: "next-up.sources", input: z.object({ sources: z.array(z.string()) }), output: done });

// GitHub changes, each from an explicit tap [SAFE-01].
export const updateBranch = defineRpc({ name: "pr.update-branch", input: z.object({ target }), output: done });
export const mergePullRequest = defineRpc({ name: "pr.merge", input: z.object({ target }), output: done });
export const closePullRequest = defineRpc({ name: "pr.close", input: z.object({ target, comment: z.string().optional() }), output: done });
export const claimIssue = defineRpc({ name: "issue.claim", input: z.object({ target }), output: done });
export const unclaimIssue = defineRpc({ name: "issue.unclaim", input: z.object({ target }), output: done });
// Close an issue from Next up; reopen is its Undo [NXT-11].
export const closeIssue = defineRpc({ name: "issue.close", input: z.object({ target, reason: z.enum(["completed", "not_planned"]), comment: z.string().optional() }), output: done });
export const reopenIssue = defineRpc({ name: "issue.reopen", input: z.object({ target }), output: done });
// `ready: false` and `on: false` are the Undo of each.
export const setReady = defineRpc({ name: "pr.ready", input: z.object({ target, ready: z.boolean() }), output: done });
export const setAutoMerge = defineRpc({ name: "pr.auto-merge", input: z.object({ target, on: z.boolean() }), output: done });
export const react = defineRpc({ name: "comment.react", input: z.object({ subjectIds: z.array(z.string()), on: z.boolean() }), output: done });
export const rerunFailed = defineRpc({ name: "checks.rerun", input: z.object({ repo: z.string(), runIds: z.array(z.number()) }), output: done });

// What an item's sheet shows beyond the card [ATT-06]. `checks` asks for failing checks too, for Rerun.
export const itemDetails = defineRpc({
  name: "item.details",
  input: z.object({ subject: z.object({ kind: z.enum(["pr", "issue"]), repo: z.string(), number: z.number() }), target: target.optional(), checks: z.boolean() }),
  output: z.custom<ItemDetails>(),
});

// The branch a session on an issue starts from, when its code lives in another repo [SES-07].
export const defaultBranch = defineRpc({ name: "repo.default-branch", input: z.object({ repo: z.string() }), output: z.object({ name: z.string().nullable() }) });

// Context for a session prompt: failing logs, unresolved threads, descriptions [SES-04].
export const sessionContext = defineRpc({
  name: "session.context",
  input: z.object({ kind: SessionKind, target }),
  output: z.object({ context: z.string() }),
});
