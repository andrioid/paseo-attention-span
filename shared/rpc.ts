import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { InboxView, Target } from "./inbox";
import { SessionKind } from "./config";

// Returns the cached inbox, refreshing from GitHub first when it is older than maxAgeSeconds.
// Without maxAgeSeconds the configured refresh interval applies.
export const getInbox = defineRpc({
  name: "inbox.get",
  input: z.object({ maxAgeSeconds: z.number().min(0).optional() }),
  output: InboxView,
});

export const dismissItem = defineRpc({
  name: "inbox.dismiss",
  input: z.object({ key: z.string() }),
  output: InboxView,
});

export const restoreDismissed = defineRpc({
  name: "inbox.restore-dismissed",
  input: z.object({}),
  output: InboxView,
});

const done = z.object({ ok: z.literal(true) });

// Bring a conflict-free PR up to date with its base [UPS-03].
export const updateBranch = defineRpc({
  name: "pr.update-branch",
  input: z.object({ target: Target }),
  output: done,
});

export const mergePullRequest = defineRpc({
  name: "pr.merge",
  input: z.object({ target: Target }),
  output: done,
});

// Close a stale draft, with a comment only if I wrote one [PRS-07, SAFE-01].
export const closePullRequest = defineRpc({
  name: "pr.close",
  input: z.object({ target: Target, comment: z.string().optional() }),
  output: done,
});

// Context for a session prompt: failing logs, unresolved threads, descriptions [SES-04].
export const sessionContext = defineRpc({
  name: "session.context",
  input: z.object({ kind: SessionKind, target: Target }),
  output: z.object({ context: z.string() }),
});
