import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ActionId, AgentSummary, AttentionView, DismissTab, HistoryFilter, IssueCloseReason, Item, NextUpIssue, Target, WrapItem } from "../shared/attention";
import type { AttentionConfig, SessionKind } from "../shared/config";
import { summarizeRerun } from "../shared/checks";
import { ALL_NOTES, ALL_WRAP } from "../shared/got-it";
import { type ArchiveOutcome, archiveTarget, type KeptRow } from "../shared/archive";
import type { FilterChange } from "../shared/next-up-filter";
import { ACTION_SESSION, renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import { type useAttention, VIEW_QUERY_KEY, writeView } from "./data";
import { DETAILS_STALE_MS, type DetailsQuery, detailsKey } from "./sheet";
import { type Checkout, type Created, createdResult, findCheckout, stamp, startSession, useStartRpcs, writeSessions } from "./sessions";
import { type SessionSource, useSessionSource } from "./session-source";
import type { SessionResult } from "../shared/session-cache";

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
  before?: () => Promise<AttentionView>;
}

// Session options, before it starts [SES-02].
export interface OptionsSpec {
  itemKey: string;
  title: string;
  kind: SessionKind;
  target: Target;
  // Claims an issue first [NXT-05].
  before?: () => Promise<AttentionView>;
}

// What the options sheet starts with [SES-02].
export interface OptionsChoice {
  prompt: string;
  checkout: Checkout;
  profileId?: string;
  workspaceId?: string;
}

// Something I just did, offered for undo until the tab changes [ATT-08, ATT-14].
export interface Undoable {
  id: number;
  text: string;
  dismissal?: boolean;
  undo: () => Promise<AttentionView>;
}

// What an action's work learned, written as it arrives: the view after it, and what Paseo confirmed it did [FRESH-04].
export interface Answer {
  view?: AttentionView;
  sessions?: SessionResult;
}
export type Write = (answer: Answer) => void;
// An action, run the one way [FRESH-04]: undefined when it failed, as a toast has said.
export type Settle = <T>(key: string | null, label: string, work: (write: Write) => Promise<T>) => Promise<T | undefined>;
// A start with no card for it, from a sheet of its own: true once started.
export type StartElsewhere = (make: (source: SessionSource, write: Write) => Promise<Created>) => Promise<boolean>;

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
}

function issueTarget(issue: NextUpIssue): Target {
  return { kind: "issue", repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, defaultBranch: issue.defaultBranch };
}

// Everything the screen does on GitHub and in Paseo: each card's change runs on its own, with Undo where it can be taken
// back; sessions start here, and Wrap up archives here.
export function useItemActions(attention: ReturnType<typeof useAttention>, navigation: PluginScreenProps["navigation"]) {
  const paseo = usePaseo();
  const sessionSource = useSessionSource(attention.data);
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
  const saveByRepo = useRpc(rpc.setUnclaimedByRepo);
  const closeIssue = useRpc(rpc.closeIssue);
  const reopenIssue = useRpc(rpc.reopenIssue);
  const keepOpen = useRpc(rpc.keepOpen);
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
  // Every card with a change still running: each runs on its own.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<Undoable[]>([]);
  // Bumped when the tab changes and its Undo rows go, so a change still running then adds none to the next tab [ATT-08].
  const undoTab = useRef(0);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [options, setOptions] = useState<OptionsSpec | null>(null);
  const view = attention.data;

  // Every action runs here, so that when it finishes, everything that shows what it changed already does: the screen, the
  // sidebar's count, every tab [FRESH-04]. Busy while it runs (the card's spinner), and nothing changes before its answer:
  // no guess to take back. Views asked for before it are cancelled; each answer is written as it arrives, the view keeping
  // whichever the server answered last and Paseo's entries stamped then, so nothing fetched before can undo it.
  const write: Write = ({ view, sessions }) => {
    if (view) writeView(queryClient, view);
    if (sessions) {
      writeSessions(queryClient, sessions, stamp());
      sessionSource?.learn?.(sessions);
    }
  };
  const settle: Settle = async (key, label, work) => {
    if (key) setBusy((keys) => new Set(keys).add(key));
    try {
      await queryClient.cancelQueries({ queryKey: VIEW_QUERY_KEY });
      return await work(write);
    } catch (error) {
      toast.error(`${label} failed: ${(error as Error).message}`);
      return undefined;
    } finally {
      if (key) setBusy((keys) => new Set([...keys].filter((other) => other !== key)));
    }
  };

  // A change from one tap, without confirming: Undo instead, where it can be taken back [SAFE-01, ATT-08, ATT-14].
  // The server answers each with the list after it, so nothing needs a refresh.
  function change(key: string, label: string, work: () => Promise<AttentionView>, done: string, undo?: () => Promise<AttentionView>, dismissal?: boolean) {
    const tab = undoTab.current;
    void settle(key, label, async (write) => {
      write({ view: await work() });
      if (!undo) return toast.show(done, { variant: "success" });
      if (tab !== undoTab.current) return;
      const id = Date.now() + Math.random();
      setUndoable((rows) => [...rows, { id, text: done, undo, dismissal }]);
    });
  }

  function openAgent(agentId: string) {
    if (navigation?.openAgent) navigation.openAgent({ agentId });
    else toast.show("Session started. Open it from the sidebar.", { variant: "success" });
  }

  // A session started on an item leaves me here, so I can start several in a row; the item's card offers Open session
  // [SES-10]. Paseo's own entries for the agent and its worktree are written before the spinner stops, so the card offers
  // it at once and Next up's issue is in In progress, without waiting for Paseo's stream [FRESH-04, SES-11].
  async function startOn(write: Write, itemKey: string, kind: SessionKind, target: Target, config: AttentionConfig, choice: OptionsChoice) {
    const created = await startSession(paseo, sessionSource!, { itemKey, kind, target, config, fetchProviders, ...choice });
    write({ sessions: createdResult(created) });
    toast.show(`Session started on #${target.number}`, { variant: "success" });
  }

  // One tap: start a session with defaults [SES-01]. An open one is offered first, by the card [SES-03].
  async function startWithDefaults(itemKey: string, kind: SessionKind, target: Target, before?: () => Promise<AttentionView>) {
    if (!view) return;
    await settle(itemKey, "Starting the session", (write) => startNow(write, itemKey, kind, target, view.config, before));
  }

  async function startNow(write: Write, itemKey: string, kind: SessionKind, target: Target, config: AttentionConfig, before?: () => Promise<AttentionView>) {
    const checkout = await findCheckout(paseo, config, target, defaultBranch);
    // Ask where an issue's code lives before claiming it, so a failed start doesn't leave it taken [SES-07].
    if (!checkout.project && target.kind === "issue") return setPlacing({ itemKey, kind, target, missing: checkout.repo, before });
    if (before) write({ view: await before() });
    const { context } = await fetchContext({ kind, target });
    await startOn(write, itemKey, kind, target, config, { prompt: renderPrompt(kind, target, context, config), checkout });
  }

  function place(codeRepo: string) {
    if (!placing) return;
    const { itemKey, kind, target, before } = placing;
    setPlacing(null);
    void settle(itemKey, "Starting the session", async (write) => {
      const next = await setCodeRepo({ issueRepo: target.repo, codeRepo });
      write({ view: next });
      await startNow(write, itemKey, kind, target, next.config, before);
    });
  }

  // A start with no card for it (a new issue, feedback), written like any other, then opened, or it'd be hard to find
  // [FRESH-04, ISS-01, FB-01].
  const startElsewhere: StartElsewhere = async (make) => {
    const created = await settle(null, "Starting the session", async (write) => {
      const created = await make(sessionSource!, write);
      write({ sessions: createdResult(created) });
      return created;
    });
    if (created) openAgent(created.agent.id);
    return !!created;
  };

  // The options sheet's Start, which stays open with its spinner until the session is written, or the start failed
  // [SES-02, FRESH-04]. True once started.
  async function startWithChoice(spec: OptionsSpec, choice: OptionsChoice): Promise<boolean> {
    if (!view) return false;
    const { itemKey, kind, target, before } = spec;
    const started = await settle(itemKey, "Starting the session", async (write) => {
      if (before) write({ view: await before() });
      await startOn(write, itemKey, kind, target, view.config, choice);
      return true;
    });
    return !!started;
  }

  // What an archive archived, written as gone with the view after it, so its Wrap up row is gone when the spinner stops
  // [ATT-22, FRESH-04].
  const archived = (outcome: ArchiveOutcome): Answer => ({
    view: outcome.view,
    ...(outcome.ok ? { sessions: { archivedAgents: outcome.archivedAgents, archivedWorkspaces: outcome.archivedWorkspaces } } : {}),
  });

  // Archive sessions, with the busy key that makes it wait for Archive all clean and the other way round [ATT-22].
  // No Undo: Paseo's SDK can't restore a workspace and its agents, so the sheet is the safeguard instead.
  // `terminals` are the ones the confirm sheet named; archiving closes no other.

  async function archiveRows(items: WrapItem[], confirm: boolean, key = ALL_WRAP, terminals: string[] = []): Promise<ArchiveOutcome | null> {
    if (items.length === 0) return null;
    const outcome = await settle(key, "Archive", async (write) => {
      const outcome = await archiveSessions({ targets: items.map(archiveTarget), confirm, terminals });
      write(archived(outcome));
      if (outcome.ok) {
        const sessions = new Set(items.flatMap((item) => item.wrap.sessions.map((session) => session.id))).size;
        // A worktree that stayed lingers as a row saying why; the toast only confirms [ATT-22].
        const kept = outcome.kept.length ? ` · ${outcome.kept.length === 1 ? "worktree" : "worktrees"} kept` : "";
        toast.show(`${sessions === 1 ? `Archived the session on #${items[0].number}` : `Archived ${sessions} sessions`}${kept}`, { variant: "success" });
      } else if (outcome.reason === "working") {
        toast.error(`Couldn't archive: ${outcome.message}`);
      }
      return outcome;
    });
    return outcome ?? null;
  }

  // A kept worktree tried again on its own: Archive worktree, or Try again [ATT-22].
  async function archiveWorktree(row: KeptRow, confirm: boolean, terminals: string[] = []): Promise<ArchiveOutcome | null> {
    const outcome = await settle(`kept:${row.workspaceId}`, "Archive", async (write) => {
      const outcome = await archiveWorktreeRpc({ workspaceId: row.workspaceId, confirm, terminals });
      write(archived(outcome));
      if (outcome.ok && !outcome.kept.length) toast.show(`Archived ${row.name}`, { variant: "success" });
      else if (!outcome.ok && outcome.reason === "working") toast.error(`Couldn't archive: ${outcome.message}`);
      return outcome;
    });
    return outcome ?? null;
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
  const claimFirst = (issue: NextUpIssue, target: Target) => () => claim({ key: issue.key, target });
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

  // Wrap up's "Close #12?": closes as completed, or keeps it open until another PR merges under it; each with Undo [ATT-24].
  const askActions = {
    onStartSession: (item: WrapItem) => {
      const target: Target = { kind: "issue", repo: item.repo, number: item.number, title: item.title, url: item.url };
      setOptions({ itemKey: item.wrap.itemKey, title: `Start session: ${item.title}`, kind: "start", target });
    },
    onCloseIssue: (item: WrapItem) => {
      const key = item.wrap.itemKey;
      const target: Target = { kind: "issue", repo: item.repo, number: item.number, title: item.title, url: item.url };
      change(item.key, "Close", () => closeIssue({ key, target, reason: "completed" }), `Closed #${item.number} as completed`, () => reopenIssue({ key, target }));
    },
    onKeepOpen: (item: WrapItem) => {
      const key = item.wrap.itemKey;
      change(item.key, "Keep open", () => keepOpen({ key, on: true }), `Kept #${item.number} open`, () => keepOpen({ key, on: false }));
    },
  };

  // Filter ticks and Next up's grouping are my own choice of what to see, not a change anywhere else: each shows at once,
  // with nothing to take back, so quick ticks build on each other. Saving runs as an action [FRESH-04]: views asked for
  // before it are cancelled, and only the last save's answer is written, so an earlier one can't drop a later tick.
  const choosing = useRef(0);
  function choose(view: AttentionView, choice: Partial<AttentionView>, label: string, save: () => Promise<AttentionView[]>) {
    const mine = ++choosing.current;
    // On whatever view is held, which may be newer than the one ticked on.
    queryClient.setQueryData<AttentionView>(VIEW_QUERY_KEY, (held) => ({ ...(held ?? view), ...choice }));
    void settle(null, label, async (write) => {
      const saved = await save();
      if (mine === choosing.current) for (const answer of saved) write({ view: answer });
    });
  }
  // [HIS-07]
  function filterHistory(view: AttentionView, next: HistoryFilter[]) {
    choose(view, { historyFilter: next }, "Saving the filter", async () => [await saveHistoryFilter({ filter: next })]);
  }
  // All of it at once, so clearing them together can't put any back [NXT-03, NXT-09].
  function filterNextUp(view: AttentionView, change: FilterChange) {
    choose(view, change, "Saving the filter", () =>
      Promise.all([
        ...(change.scopes ? [saveScopes({ scopes: change.scopes })] : []),
        ...(change.sources ? [saveSources({ sources: change.sources })] : []),
        ...(change.projectFilter ? [saveProjects({ projects: change.projectFilter })] : []),
      ]),
    );
  }
  // [NXT-14]
  function groupNextUp(view: AttentionView, on: boolean) {
    choose(view, { unclaimedByRepo: on }, "Saving the grouping", async () => [await saveByRepo({ on })]);
  }

  return {
    busy,
    undoable,
    clearUndo: () => ((undoTab.current += 1), setUndoable([])),
    // [ATT-08, ATT-14]
    undo: (row: Undoable) =>
      void settle(String(row.id), "Undo", async (write) => {
        write({ view: await row.undo() });
        setUndoable((rows) => rows.filter((other) => other.id !== row.id));
      }),
    restoreDismissed: (tab: DismissTab) =>
      void settle("restore", "Restore", async (write) => {
        write({ view: await restore({ tab }) });
        setUndoable([]);
      }),
    placing,
    place,
    cancelPlacing: () => setPlacing(null),
    options,
    closeOptions: () => setOptions(null),
    startWithChoice,
    settle,
    startElsewhere,
    fetchDetails,
    openAgent,
    archiveRows,
    archiveWorktree,
    dismissKept: (row: KeptRow) => void settle(`kept:${row.workspaceId}`, "Dismiss", async (write) => write({ view: await dismissKept({ workspaceId: row.workspaceId }) })),
    itemActions,
    issueActions,
    askActions,
    filterHistory,
    filterNextUp,
    groupNextUp,
  };
}
