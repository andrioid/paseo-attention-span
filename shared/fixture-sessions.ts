// The preview's sessions, as Paseo would list them: the preview daemon has no agent provider, so the client's preview
// session source serves these instead of Paseo's own lists (client/session-source.ts).
import type { SessionKind } from "./config";
import { ITEM_LABEL, KIND_LABEL, LABEL, type SessionWorkspaceEntry } from "./item-sessions";
import { PARENT_AGENT_LABEL, type PaseoAgentEntry } from "./linked-sessions";

// The fixture's repo, as in server/fixture.ts.
const REPO = "acme/shop";

interface Session {
  id: string;
  itemKey: string;
  kind?: SessionKind;
  status: string;
  minutesAgo: number;
  requiresAttention?: boolean;
  title?: string;
  workspace?: Worktree;
  // Sub-agents it started, idle.
  subAgents?: number;
}

interface Worktree {
  branch: string;
  dirty?: boolean;
  ahead?: number;
  preview?: SessionWorkspaceEntry["preview"];
}

// A worktree Paseo made, clean or with uncommitted or unpushed work [ATT-22].
const worktree = (branch: string, dirty?: boolean, ahead?: number): Worktree => ({ branch, dirty, ahead });

// Sessions the preview shows as started from items: working, needs me, failed, idle.
// Each sits in its action's line in the sheet. Issue 90 has two: an old one with no kind, which leads, and Rebase stack on its PR.
// #113 waits on CI while its Fix CI session works, though Fix CI isn't one of its actions any more.
// #120's was started outside Attention Span, in a workspace Paseo linked to the PR, so it has no kind [SES-08].
// #197's too, so it shows on its stack, led by #196 [ATT-04].
// #198 is asked to be reviewed again while its Review session is still open: the card opens it [REV-02].
const SESSIONS: Session[] = [
  { id: "agent-101", itemKey: `${REPO}#101`, kind: "fix", status: "running", minutesAgo: 4 },
  { id: "agent-102", itemKey: `${REPO}#102`, kind: "address", status: "idle", minutesAgo: 30, requiresAttention: true },
  { id: "agent-108", itemKey: `${REPO}#108`, kind: "rebase", status: "error", minutesAgo: 90 },
  // Started on assigned #150, and on someone else's issue Next up doesn't know, which needs me: In progress [SES-11].
  { id: "agent-150", itemKey: `${REPO}#150`, kind: "start", status: "idle", minutesAgo: 300, title: "Orders export times out for big shops" },
  { id: "agent-205", itemKey: "acme/platform#205", kind: "start", status: "idle", minutesAgo: 8, requiresAttention: true, title: "Plan single sign-on for partners" },
  { id: "agent-90", itemKey: `${REPO}#90`, status: "idle", minutesAgo: 120, requiresAttention: true },
  { id: "agent-103", itemKey: `${REPO}#103`, kind: "rebase", status: "running", minutesAgo: 6 },
  { id: "agent-113", itemKey: `${REPO}#113`, kind: "fix", status: "running", minutesAgo: 2 },
  { id: "agent-120", itemKey: `${REPO}#120`, status: "running", minutesAgo: 3 },
  { id: "agent-197", itemKey: `${REPO}#197`, status: "idle", minutesAgo: 15 },
  { id: "agent-198", itemKey: `${REPO}#198`, kind: "review", status: "idle", minutesAgo: 2880, title: "Review PR 198: Show shipping estimates at checkout" },
  // Wrap up: finished work whose sessions are all idle [ATT-22].
  { id: "agent-183", itemKey: `${REPO}#183`, kind: "fix", status: "idle", minutesAgo: 20, workspace: worktree("retry-webhooks", false, 0), title: "Retry webhooks" },
  // Its sheet counts lines and names the terminals archiving closes, as Paseo's own sheet would.
  {
    id: "agent-186",
    itemKey: `${REPO}#186`,
    kind: "fix",
    status: "idle",
    minutesAgo: 40,
    workspace: { ...worktree("split-invoice-pdf", true, 1), preview: { dirtyFiles: 2, dirtyLines: { added: 12, deleted: 3 }, terminals: ["dev", "shell"] } },
    title: "Split invoice PDF",
  },
  { id: "agent-190", itemKey: `${REPO}#190`, kind: "review", status: "idle", minutesAgo: 60, workspace: worktree("add-vat-export", false, 0), title: "Review PR 190: Add the VAT export" },
  // On a PR under an issue Wrap up asks to close: it joins that row [ATT-24].
  // A session started from the close-issue prompt stays visible while working, even though it cannot be archived.
  { id: "agent-195", itemKey: `${REPO}#195`, kind: "fix", status: "running", minutesAgo: 10, workspace: worktree("statement-pdf-download", false, 0), title: "Statement PDF download" },
  // With a review sub-agent it started, archived along with it.
  { id: "agent-172", itemKey: `${REPO}#172`, kind: "fix", status: "idle", minutesAgo: 240, workspace: worktree("fix-vat-credit-notes", false, 0), title: "Fix VAT on credit notes", subAgents: 1 },
  { id: "agent-172b", itemKey: `${REPO}#172`, kind: "address", status: "idle", minutesAgo: 250, workspace: worktree("credit-note-tests"), title: "Credit note tests" },
];

export interface FixtureEntries {
  agents: PaseoAgentEntry[];
  workspaces: SessionWorkspaceEntry[];
}

// The made-up sessions as Paseo's entries, their times counted back from `now`.
export function fixtureEntries(now: number): FixtureEntries {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const agents: PaseoAgentEntry[] = [];
  const workspaces: SessionWorkspaceEntry[] = [];
  for (const session of SESSIONS) {
    const workspaceId = session.workspace ? `WS_${session.id}` : null;
    agents.push({
      id: session.id,
      labels: { [LABEL]: "1", [ITEM_LABEL]: session.itemKey, ...(session.kind ? { [KIND_LABEL]: session.kind } : {}) },
      status: session.status,
      requiresAttention: !!session.requiresAttention,
      title: session.title ?? `Fixture session ${session.id}`,
      workspaceId,
      updatedAt: at(session.minutesAgo),
    });
    for (let n = 1; n <= (session.subAgents ?? 0); n++) {
      agents.push({ id: `${session.id}-sub-${n}`, labels: { [PARENT_AGENT_LABEL]: session.id }, status: "idle", title: "Review", workspaceId, updatedAt: at(session.minutesAgo) });
    }
    if (session.workspace && workspaceId) {
      const { branch, dirty, ahead, preview } = session.workspace;
      workspaces.push({
        id: workspaceId,
        workspaceKind: "worktree",
        name: `Workspace for ${branch}`,
        workspaceDirectory: `/tmp/attention-span/${branch}`,
        gitRuntime: { currentBranch: branch, isDirty: dirty ?? null, aheadOfOrigin: ahead ?? null },
        ...(preview ? { preview } : {}),
      });
    }
  }
  return { agents, workspaces };
}

// While the view says so, the sessions started on issues are as good as archived, so Doing can clear [SES-11].
export const startedOnIssue = (agent: PaseoAgentEntry): boolean => agent.labels?.[KIND_LABEL] === "start";
