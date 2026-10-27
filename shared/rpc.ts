import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SessionKind } from "./config";
import type { InboxView, Target } from "./inbox";

// Both sides are this plugin, so the types are checked by TypeScript, not repeated as schemas.
const view = z.custom<InboxView>();
const target = z.custom<Target>();
const done = z.object({ ok: z.literal(true) });

// The cached inbox. Feeds older than their schedule are refreshed from GitHub first; `refresh` fetches that feed now (⟳).
export const getInbox = defineRpc({ name: "inbox.get", input: z.object({ refresh: z.enum(["live", "history"]).optional() }), output: view });
export const dismissItem = defineRpc({ name: "inbox.dismiss", input: z.object({ key: z.string() }), output: view });
// Undo one dismissal [ATT-08].
export const undismissItem = defineRpc({ name: "inbox.undismiss", input: z.object({ key: z.string() }), output: view });
export const restoreDismissed = defineRpc({ name: "inbox.restore-dismissed", input: z.object({}), output: view });
// Adds one entry to codeRepos in config.json [SES-07].
export const setCodeRepo = defineRpc({ name: "config.set-code-repo", input: z.object({ issueRepo: z.string(), codeRepo: z.string() }), output: view });

// GitHub changes, each from an explicit tap [SAFE-01].
export const updateBranch = defineRpc({ name: "pr.update-branch", input: z.object({ target }), output: done });
export const mergePullRequest = defineRpc({ name: "pr.merge", input: z.object({ target }), output: done });
export const closePullRequest = defineRpc({ name: "pr.close", input: z.object({ target, comment: z.string().optional() }), output: done });
export const claimIssue = defineRpc({ name: "issue.claim", input: z.object({ target }), output: done });

// The branch a session on an issue starts from, when its code lives in another repo [SES-07].
export const defaultBranch = defineRpc({ name: "repo.default-branch", input: z.object({ repo: z.string() }), output: z.object({ name: z.string().nullable() }) });

// Context for a session prompt: failing logs, unresolved threads, descriptions [SES-04].
export const sessionContext = defineRpc({
  name: "session.context",
  input: z.object({ kind: SessionKind, target }),
  output: z.object({ context: z.string() }),
});
