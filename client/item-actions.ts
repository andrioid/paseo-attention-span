import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ActionId, AgentSummary, AttentionView, HistoryFilter, IssueCloseReason, Item, NextUpIssue, Target, WrapItem } from "../shared/attention";
import type { AttentionConfig, SessionKind } from "../shared/config";
import { summarizeRerun } from "../shared/checks";
import { ALL_NOTES, ALL_WRAP } from "../shared/got-it";
import { type ArchiveOutcome, archiveTarget, type KeptRow } from "../shared/archive";
import type { FilterChange } from "../shared/next-up-filter";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import type { useAttention } from "./data";
import { DETAILS_STALE_MS, type DetailsQuery, detailsKey } from "./sheet";
import { AGENTS_QUERY_KEY, findCheckout, startSession, useStartRpcs } from "./sessions";

export type FetchDetails = (input: RpcInput<typeof rpc.itemDetails>) => Promise<RpcOutput<typeof rpc.itemDetails>>;

// What an item's sheet fetches when it opens; resting the pointer on its card fetches the same ahead. `checks` asks for
// failing checks too, for Rerun.
export function itemDetailsQuery(item: Item, fetchDetails: FetchDetails): DetailsQuery {
  const checks = item.actions.includes("rerun");
  const subject = { kind: item.kind, repo: item.repo, number: item.number };
  return { queryKey: detailsKey(subject, item.target, checks), queryFn: () => fetchDetails({ subject, target: item.target, checks }) };
}

// A start held back until I say where the issue's code lives [SES-07].
interface Placing {
  itemKey: string;
  kind: SessionKind;
  target: Target;
  missing: string;
  before?: () => Promise<unknown>;
}

// Session options, before it starts [SES-02].
export interface OptionsSpec {
  itemKey: string;
  title: string;
  kind: SessionKind;
  target: Target;
  // Claims an issue first [NXT-05].
  before?: () => Promise<unknown>;
}

// Something I just did, offered for undo until the tab changes [ATT-08, ATT-14].
export interface Undoable {
  id: number;
  text: string;
  dismissal?: boolean;
  undo: () => Promise<unknown>;
}

// What a card and its sheet can do.
export interface Actions {
  agents: AgentSummary[];
  startWithOptions: (spec: OptionsSpec) => void;
  busy: ReadonlySet<string>;
  config: AttentionConfig;
  login: string | null;
  fetchDetails: FetchDetails;
  act: (item: Item, action: ActionId) => void;
  requestReviewers: (item: Item, reviewers: string[]) => void;
  // Without run ids, it finds them first: Rerun pressed before the sheet had the failing checks.
  rerun: (item: Item, runIds?: number[]) => void;
  acknowledge: (item: Item, commentIds: string[]) => void;
  confirm: (item: Item, action: "merge" | "close", comment?: string) => void;
  dismiss: (item: Item) => void;
  gotItAll: (items: Item[]) => void;
  openAgent: (agentId: string) => void;
  // Opens a Review session on a review asked for again, sending it the follow-up first when it hasn't had it [REV-02].
  reviewAgain: (item: Item, agentId: string) => void;
  started: (agentId: string) => Promise<void>;
}

// A session just started on an item.
export interface Started {
  agentId: string;
  itemKey: string;
  kind: SessionKind;
  target: Target;
}

function issueTarget(issue: NextUpIssue): Target {
  return { kind: "issue", repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, defaultBranch: issue.defaultBranch };
}

// Everything the screen does on GitHub and in Paseo: each card's change runs on its own, with Undo where it can be taken
// back; sessions start here, and Wrap up archives here.
export function useItemActions(attention: ReturnType<typeof useAttention>, navigation: PluginScreenProps["navigation"]) {
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { fetchContext, defaultBranch, fetchProviders } = useStartRpcs();
  const dismiss = useRpc(rpc.dismissItem);
  const undismiss = useRpc(rpc.undismissItem);
  const restore = useRpc(rpc.restoreDismissed);
  const gotIt = useRpc(rpc.gotIt);
  const saveHistoryFilter = useRpc(rpc.setHistoryFilter);
  const archiveSessions = useRpc(rpc.archiveSessions);
  const archiveWorktreeRpc = useRpc(rpc.archiveWorktree);
  const dismissKept = useRpc(rpc.dismissKept);
  const saveScopes = useRpc(rpc.setScopes);
  const saveSources = useRpc(rpc.setSources);
  const saveProjects = useRpc(rpc.setProjectFilter);
  const closeIssue = useRpc(rpc.closeIssue);
  const reopenIssue = useRpc(rpc.reopenIssue);
  const update = useRpc(rpc.updateBranch);
  const merge = useRpc(rpc.mergePullRequest);
  const close = useRpc(rpc.closePullRequest);
  const claim = useRpc(rpc.claimIssue);
  const unclaim = useRpc(rpc.unclaimIssue);
  const setReady = useRpc(rpc.setReady);
  const setAutoMerge = useRpc(rpc.setAutoMerge);
  const react = useRpc(rpc.react);
  const requestReviewers = useRpc(rpc.requestReviewers);
  const rerunFailed = useRpc(rpc.rerunFailed);
  const fetchDetails = useRpc(rpc.itemDetails);
  const setCodeRepo = useRpc(rpc.setCodeRepo);
  const sendReviewAgain = useRpc(rpc.reviewAgain);
  // Every card with a change still running: each runs on its own.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Sessions archived here, hidden before Paseo's list catches up; in previews, where nothing really archives, this is what
  // makes a Wrap up row go away after its screenshot [ATT-22].
  const [archivedSessions, setArchivedSessions] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<Undoable[]>([]);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [options, setOptions] = useState<OptionsSpec | null>(null);
  const view = attention.data;

  async function run(key: string, label: string, work: () => Promise<unknown>) {
    setBusy((keys) => new Set(keys).add(key));
    try {
      await work();
    } catch (error) {
      toast.error(`${label} failed: ${(error as Error).message}`);
    } finally {
      setBusy((keys) => new Set([...keys].filter((other) => other !== key)));
    }
  }

  // A change from one tap, without confirming: Undo instead, where it can be taken back [SAFE-01, ATT-08, ATT-14].
  // The server answers each with the list after it, so nothing needs a refresh.
  function change(key: string, label: string, work: () => Promise<AttentionView>, done: string, undo?: () => Promise<AttentionView>, dismissal?: boolean) {
    void run(key, label, async () => {
      attention.setView(await work());
      if (!undo) return toast.show(done, { variant: "success" });
      const id = Date.now() + Math.random();
      setUndoable((rows) => [...rows, { id, text: done, undo: async () => attention.setView(await undo()), dismissal }]);
    });
  }

  function openAgent(agentId: string) {
    if (navigation?.openAgent) navigation.openAgent({ agentId });
    else toast.show("Session started. Open it from the sidebar.", { variant: "success" });
  }

  // A session started from somewhere with no card for it (a new issue, feedback): open it, or it'd be hard to find.
  async function started(agentId: string) {
    await queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    openAgent(agentId);
  }

  // A session started on an item leaves me here, so I can start several in a row; the item's card offers Open session
  // [SES-10]. The session goes on the list at once, so the card offers it even if the poll after fails, rather than Start
  // again; the next poll that succeeds replaces it with Paseo's own.
  async function startedOn({ agentId, itemKey, kind, target }: Started) {
    queryClient.setQueryData<AgentSummary[]>(AGENTS_QUERY_KEY, (agents = []) =>
      agents.some((agent) => agent.id === agentId)
        ? agents
        : [...agents, { id: agentId, itemKey, kind, status: "running", requiresAttention: false, title: null, workspaceId: null, lastActivityAt: new Date().toISOString() }],
    );
    await queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    toast.show(`Session started on #${target.number}`, { variant: "success" });
  }

  // One tap: start a session with defaults [SES-01]. An open one is offered first, by the card [SES-03].
  async function startWithDefaults(itemKey: string, kind: SessionKind, target: Target, before?: () => Promise<unknown>) {
    if (!view) return;
    await run(itemKey, "Starting the session", () => startNow(itemKey, kind, target, view.config, before));
  }

  async function startNow(itemKey: string, kind: SessionKind, target: Target, config: AttentionConfig, before?: () => Promise<unknown>) {
    const checkout = await findCheckout(paseo, config, target, defaultBranch);
    // Ask where an issue's code lives before claiming it, so a failed start doesn't leave it taken [SES-07].
    if (!checkout.project && target.kind === "issue") return setPlacing({ itemKey, kind, target, missing: checkout.repo, before });
    await before?.();
    const { context } = await fetchContext({ kind, target });
    const prompt = renderPrompt(kind, target, context, config);
    const agentId = await startSession(paseo, { itemKey, kind, target, prompt, config, fetchProviders, checkout });
    await startedOn({ agentId, itemKey, kind, target });
  }

  function place(codeRepo: string) {
    if (!placing) return;
    const { itemKey, kind, target, before } = placing;
    setPlacing(null);
    void run(itemKey, "Starting the session", async () => {
      const next = await setCodeRepo({ issueRepo: target.repo, codeRepo });
      attention.setView(next);
      await startNow(itemKey, kind, target, next.config, before);
    });
  }

  // Archive sessions, with the busy key that makes it wait for Archive all clean and the other way round [ATT-22].
  // No Undo: Paseo's SDK can't restore a workspace and its agents, so the sheet is the safeguard instead.
  // `terminals` are the ones the confirm sheet named; archiving closes no other.
  async function archiveRows(items: WrapItem[], confirm: boolean, key = ALL_WRAP, terminals: string[] = []): Promise<ArchiveOutcome | null> {
    if (items.length === 0) return null;
    setBusy((keys) => new Set(keys).add(key));
    try {
      const outcome = await archiveSessions({ targets: items.map(archiveTarget), confirm, terminals });
      attention.setView(outcome.view);
      if (outcome.ok) {
        const archived = new Set(items.flatMap((item) => item.wrap.sessions.map((session) => session.id)));
        setArchivedSessions((known) => new Set([...known, ...archived]));
        const sessions = archived.size;
        // A worktree that stayed lingers as a row saying why; the toast only confirms [ATT-22].
        const kept = outcome.kept.length ? ` · ${outcome.kept.length === 1 ? "worktree" : "worktrees"} kept` : "";
        toast.show(`${sessions === 1 ? `Archived the session on #${items[0].number}` : `Archived ${sessions} sessions`}${kept}`, { variant: "success" });
      } else if (outcome.reason === "working") {
        toast.error(`Couldn't archive: ${outcome.message}`);
      }
      return outcome;
    } catch (error) {
      toast.error(`Archive failed: ${(error as Error).message}`);
      return null;
    } finally {
      setBusy((keys) => new Set([...keys].filter((other) => other !== key)));
    }
  }

  // A kept worktree tried again on its own: Archive worktree, or Try again [ATT-22].
  async function archiveWorktree(row: KeptRow, confirm: boolean, terminals: string[] = []): Promise<ArchiveOutcome | null> {
    const key = `kept:${row.workspaceId}`;
    setBusy((keys) => new Set(keys).add(key));
    try {
      const outcome = await archiveWorktreeRpc({ workspaceId: row.workspaceId, confirm, terminals });
      attention.setView(outcome.view);
      if (outcome.ok && !outcome.kept.length) toast.show(`Archived ${row.name}`, { variant: "success" });
      else if (!outcome.ok && outcome.reason === "working") toast.error(`Couldn't archive: ${outcome.message}`);
      return outcome;
    } catch (error) {
      toast.error(`Archive failed: ${(error as Error).message}`);
      return null;
    } finally {
      setBusy((keys) => new Set([...keys].filter((other) => other !== key)));
    }
  }

  function itemActions(view: AttentionView, agents: AgentSummary[]): Actions {
    return {
      agents,
      startWithOptions: setOptions,
      busy,
      config: view.config,
      login: view.login,
      fetchDetails,
      openAgent,
      reviewAgain: (item, agentId) =>
        void run(item.key, "Review again", async () => {
          const { outcome } = await sendReviewAgain({ key: item.key, agentId, target: item.target });
          openAgent(agentId);
          if (outcome === "sent") toast.show("Sent the review session what changed since your last review", { variant: "success" });
          if (outcome === "busy") toast.show("The review session is busy, so nothing was sent. Press Review again once it's done.");
        }),
      started,
      act: (item, action) => {
        const session = ACTION_SESSION[action];
        const { target } = item;
        if (action === "reply") return void openExternalUrl(item.person?.url ?? item.url);
        // [HIS-07]
        if (action === "got_it" && item.change) {
          const { id } = item.change;
          return change(item.key, "Got it", () => gotIt({ ids: [id], on: true }), `Cleared the note on “${item.title}”`, () => gotIt({ ids: [id], on: false }));
        }
        if (session) return void startWithDefaults(item.key, session, target);
        if (action === "update") change(item.key, "Update", () => update({ key: item.key, target }), `Updating PR ${target.number} with ${target.baseRefName}`);
        // [PRS-11]
        if (action === "ready")
          change(item.key, "Ready for review", () => setReady({ key: item.key, target, ready: true }), `PR ${target.number} is ready for review`, () => setReady({ key: item.key, target, ready: false }));
        // [PRS-10]
        if (action === "automerge")
          change(item.key, "Auto-merge", () => setAutoMerge({ key: item.key, target, on: true }), `PR ${target.number} merges once checks pass`, () => setAutoMerge({ key: item.key, target, on: false }));
      },
      // [PRS-09]
      rerun: (item, known) => {
        if (!known) toast.show("Finding the failed jobs to rerun…");
        change(
          item.key,
          "Rerun",
          async () => {
            const runIds = known ?? summarizeRerun((await queryClient.fetchQuery({ ...itemDetailsQuery(item, fetchDetails), staleTime: DETAILS_STALE_MS })).failing).runIds;
            if (runIds.length === 0) throw new Error("no failed GitHub Actions jobs to rerun");
            return rerunFailed({ key: item.key, repo: item.target.repo, runIds });
          },
          `Rerunning the failed jobs of PR ${item.target.number}`,
        );
      },
      // [PRS-12]
      requestReviewers: (item, reviewers) => {
        const { target } = item;
        const names = reviewers.length === 1 ? reviewers[0] : `${reviewers.length} reviewers`;
        change(item.key, "Request review", () => requestReviewers({ key: item.key, target, reviewers, on: true }), `Asked ${names} to review PR ${target.number}`, () =>
          requestReviewers({ key: item.key, target, reviewers, on: false }),
        );
      },
      // [MEN-07]
      acknowledge: (item, ids) =>
        change(item.key, "Acknowledge", () => react({ key: item.key, subjectIds: ids, on: true }), `Acknowledged ${ids.length === 1 ? "a comment" : `${ids.length} comments`} on #${item.number}`, () =>
          react({ key: item.key, subjectIds: ids, on: false }),
        ),
      confirm: (item, action, comment) =>
        action === "merge"
          ? change(item.key, "Merge", () => merge({ key: item.key, target: item.target }), `PR ${item.target.number} merged`)
          : change(item.key, "Close", () => close({ key: item.key, target: item.target, comment }), `PR ${item.target.number} closed`),
      // Got it on every Changed by others note at once; one Undo brings them all back [HIS-07].
      gotItAll: (items) => {
        const ids = items.flatMap((item) => (item.change ? [item.change.id] : []));
        const notes = `${ids.length} note${ids.length === 1 ? "" : "s"}`;
        change(ALL_NOTES, "Mark all as read", () => gotIt({ ids, on: true }), `Cleared ${notes} on changes by others`, () => gotIt({ ids, on: false }));
      },
      dismiss: (item) => change(item.key, "Dismiss", () => dismiss({ key: item.key }), `Dismissed “${item.title}”`, () => undismiss({ key: item.key }), true),
    };
  }

  // Next up's issues: start, with options, claim or give back, close [NXT-05, NXT-07, NXT-11].
  const claimFirst = (issue: NextUpIssue, target: Target) => async () => attention.setView(await claim({ key: issue.key, target }));
  const issueActions = {
    onStart: (issue: NextUpIssue, claiming: boolean) => {
      const target = issueTarget(issue);
      void startWithDefaults(issue.key, "start", target, claiming ? claimFirst(issue, target) : undefined);
    },
    onOptions: (issue: NextUpIssue, claiming: boolean, label: string) => {
      const target = issueTarget(issue);
      setOptions({ itemKey: issue.key, title: `${label}: ${issue.title}`, kind: "start", target, before: claiming ? claimFirst(issue, target) : undefined });
    },
    // Claim without starting, or give it back; each undoes the other [NXT-07].
    onClaim: (issue: NextUpIssue, on: boolean) => {
      const target = issueTarget(issue);
      const [take, giveBack] = [() => claim({ key: issue.key, target }), () => unclaim({ key: issue.key, target })];
      change(issue.key, on ? "Claim" : "Unclaim", on ? take : giveBack, `${on ? "Claimed" : "Unclaimed"} #${issue.number}`, on ? giveBack : take);
    },
    // Undo reopens; a comment already posted stays [NXT-11].
    onCloseIssue: (issue: NextUpIssue, reason: IssueCloseReason, comment: string) => {
      const target = issueTarget(issue);
      const done = `Closed #${issue.number} as ${reason === "completed" ? "completed" : "not planned"}`;
      change(issue.key, "Close", () => closeIssue({ key: issue.key, target, reason, comment: comment || undefined }), done, () => reopenIssue({ key: issue.key, target }));
    },
  };

  const failedSaving = (error: Error) => toast.error(`Saving the filter failed: ${error.message}`);
  // Ticks apply right away, like Next up's; the server remembers them [HIS-07].
  function filterHistory(view: AttentionView, next: HistoryFilter[]) {
    attention.setView({ ...view, historyFilter: next });
    saveHistoryFilter({ filter: next })
      .then((saved) => attention.setView(saved))
      .catch(failedSaving);
  }
  // One setView for all, so clearing them together can't put any back.
  function filterNextUp(view: AttentionView, change: FilterChange) {
    attention.setView({ ...view, ...change });
    if (change.scopes) saveScopes({ scopes: change.scopes }).catch(failedSaving);
    if (change.sources) saveSources({ sources: change.sources }).catch(failedSaving);
    if (change.projectFilter) saveProjects({ projects: change.projectFilter }).catch(failedSaving);
  }

  return {
    busy,
    archivedSessions,
    undoable,
    clearUndo: () => setUndoable([]),
    undo: (row: Undoable) =>
      void run(String(row.id), "Undo", async () => {
        await row.undo();
        setUndoable((rows) => rows.filter((other) => other.id !== row.id));
      }),
    restoreDismissed: () => void run("restore", "Restore", async () => (attention.setView(await restore({})), setUndoable([]))),
    placing,
    place,
    cancelPlacing: () => setPlacing(null),
    options,
    closeOptions: () => setOptions(null),
    fetchDetails,
    openAgent,
    started,
    startedOn,
    archiveRows,
    archiveWorktree,
    dismissKept: (row: KeptRow) => void run(`kept:${row.workspaceId}`, "Dismiss", async () => attention.setView(await dismissKept({ workspaceId: row.workspaceId }))),
    itemActions,
    issueActions,
    filterHistory,
    filterNextUp,
  };
}
