import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SessionKind } from "./config";
import type { InboxView, Target } from "./inbox";

// Both sides are this plugin, so the types are checked by TypeScript, not repeated as schemas.
const view = z.custom<InboxView>();
const target = z.custom<Target>();
const done = z.object({ ok: z.literal(true) });

// The cached inbox, refreshed from GitHub first when older than maxAgeSeconds
// (default: the configured refresh interval).
export const getInbox = defineRpc({ name: "inbox.get", input: z.object({ maxAgeSeconds: z.number().min(0).optional() }), output: view });
export const dismissItem = defineRpc({ name: "inbox.dismiss", input: z.object({ key: z.string() }), output: view });
// Undo one dismissal [ATT-08].
export const undismissItem = defineRpc({ name: "inbox.undismiss", input: z.object({ key: z.string() }), output: view });
export const restoreDismissed = defineRpc({ name: "inbox.restore-dismissed", input: z.object({}), output: view });

// GitHub changes, each from an explicit tap [SAFE-01].
export const updateBranch = defineRpc({ name: "pr.update-branch", input: z.object({ target }), output: done });
export const mergePullRequest = defineRpc({ name: "pr.merge", input: z.object({ target }), output: done });
export const closePullRequest = defineRpc({ name: "pr.close", input: z.object({ target, comment: z.string().optional() }), output: done });
export const claimIssue = defineRpc({ name: "issue.claim", input: z.object({ target }), output: done });

// Context for a session prompt: failing logs, unresolved threads, descriptions [SES-04].
export const sessionContext = defineRpc({
  name: "session.context",
  input: z.object({ kind: SessionKind, target }),
  output: z.object({ context: z.string() }),
});
