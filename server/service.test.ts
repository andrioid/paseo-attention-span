import { describe, expect, it, vi } from "vitest";
import { type AttentionView, newerView } from "../shared/attention";
import { AttentionConfig } from "../shared/config";
import { historyWeeks } from "../shared/history-report";
import { type Gh, type GitHub, gitHub, type ProbeResult } from "./fetch";
import type { HistoryResult } from "./github-types";
import { PARENT_AGENT_LABEL } from "../shared/linked-sessions";
import { paseoAgent, paseoWorkspace, startedAgent } from "../shared/test-builders";
import { checksDone, fixture, REPO } from "./fixture";
import type { Port } from "./port";
import { AttentionService } from "./service";
import { SETTLE_MS } from "./view";
import { State, type Store } from "./store";

const START = Date.parse("2026-11-14T12:00:00Z");
const MINUTE = 60_000;
const KEY = `${REPO}#101`; // a PR of mine in Doing

// Lets a test hold a request open, and say when it answers.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

// Lets every promise that can settle, settle.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

// The service on a made-up GitHub (server/fixture.ts), with a clock that moves only when told and saves kept in order.
function harness(config: Record<string, unknown> = {}, history?: GitHub["history"]) {
  let now = START;
  let timers: { at: number; run: () => void }[] = [];
  const saved: State[] = [];
  const probe = (): ProbeResult => ({ data: { viewer: { projectsV2: { nodes: [] } } }, errors: [], failures: [] });
  const github = {
    login: vi.fn<GitHub["login"]>(async () => "me"),
    probeProjects: vi.fn<GitHub["probeProjects"]>(async () => probe()),
    live: vi.fn<GitHub["live"]>(async (_config, at) => fixture(at)),
    changes: vi.fn<GitHub["changes"]>(async (ledger) => ledger),
    history: vi.fn<GitHub["history"]>(history ?? (async (_config, at) => fixture(at).data)),
    issueFields: vi.fn<GitHub["issueFields"]>(async () => []),
    issues: vi.fn<GitHub["issues"]>(async () => ({})),
  } satisfies GitHub;
  const store = {
    moveOldFiles: async () => {},
    loadConfig: async () => AttentionConfig.parse(config),
    loadState: async () => State.parse({}),
    saveState: vi.fn(async (state: State) => void saved.push(structuredClone(state))),
  } as Partial<Store> as Store;
  const port: Port = {
    github,
    paseo: {
      projectRepos: async () => [],
      archive: async () => ({ ok: true, kept: [], archivedAgents: [], archivedWorkspaces: [] }),
      sessions: vi.fn<Port["paseo"]["sessions"]>(async () => ({ agents: [], workspaces: [] })),
    },
    store,
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => void (timers = timers.filter((other) => other !== timer));
    },
  };
  const service = new AttentionService(port);
  return {
    service,
    github,
    // Paseo as the service reaches it, for a test to say what archiving answers.
    paseo: port.paseo,
    // The server started again on the same port, as after a restart.
    restarted: () => new AttentionService(port),
    store,
    saved,
    // Moves the clock on, running the timers due on the way.
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.run();
        await settle();
      }
      now = until;
    },
    // Moves the clock on without running any timer, as if the app asked between them.
    jump(ms: number) {
      now += ms;
    },
    async start() {
      await service.start();
      await settle();
    },
  };
}

const chipsOf = (view: AttentionView, key: string) =>
  view.doing
    .flatMap((section) => section.items)
    .find((item) => item.key === key)
    ?.chips.map((chip) => chip.text);

describe("refreshes", () => {
  it("FRESH-01, GH-01: callers asking at once share one refresh per feed", async () => {
    const { service, github, start } = harness();
    await start();
    expect([github.live.mock.calls.length, github.history.mock.calls.length]).toEqual([1, 1]);
    const held = deferred<Awaited<ReturnType<GitHub["live"]>>>();
    github.live.mockImplementationOnce(() => held.promise);
    const views = Promise.all([service.get("live"), service.get("live"), service.refresh("live")]);
    await settle();
    held.resolve(fixture(new Date(START)));
    await views;
    expect(github.live).toHaveBeenCalledTimes(2);
  });

  it("FRESH-02: a fresh refresh waits for the one under way and starts after it, once for every caller", async () => {
    const { service, github, start, jump } = harness();
    await start();
    const held = deferred<Awaited<ReturnType<GitHub["live"]>>>();
    github.live.mockImplementationOnce(() => held.promise);
    const running = service.refresh("live");
    await settle();
    jump(MINUTE);
    const fresh = Promise.all([service.refresh("live", true), service.refresh("live", true)]);
    await settle();
    expect(github.live).toHaveBeenCalledTimes(2);
    held.resolve(fixture(new Date(START)));
    await Promise.all([running, fresh]);
    expect(github.live).toHaveBeenCalledTimes(3);
    expect(github.live.mock.calls[2]![1].getTime()).toBe(START + MINUTE);
  });

  it("FRESH-01: the live feed refreshes every refreshMinutes, and asking in between answers from the cache", async () => {
    const { service, github, start, advance } = harness({ refreshMinutes: 10 });
    github.live.mockImplementation(async (_config, at) => checksDone(fixture(at)));
    await start();
    await advance(9 * MINUTE);
    await service.get();
    expect(github.live).toHaveBeenCalledTimes(1);
    await advance(MINUTE);
    expect(github.live).toHaveBeenCalledTimes(2);
    await service.get();
    expect(github.live).toHaveBeenCalledTimes(2);
    await advance(10 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(3);
    // History is fetched daily, not with every live refresh.
    expect(github.history).toHaveBeenCalledTimes(1);
  });

  it("FRESH-01, GH-01: a failed refresh is retried at most every 5 minutes, except on ⟳", async () => {
    const { service, github, start, jump } = harness();
    github.live.mockRejectedValueOnce(new Error("GitHub is down"));
    await start();
    expect((await service.get()).feeds.live.error).toBe("GitHub is down");
    jump(4 * MINUTE);
    await service.get();
    expect(github.live).toHaveBeenCalledTimes(1);
    jump(MINUTE);
    const view = await service.get();
    expect(github.live).toHaveBeenCalledTimes(2);
    expect(view.feeds.live).toMatchObject({ error: null, fetchedAt: new Date(START + 5 * MINUTE).toISOString() });
    github.live.mockRejectedValueOnce(new Error("again"));
    jump(15 * MINUTE);
    await service.get();
    await service.get("live");
    expect(github.live).toHaveBeenCalledTimes(4);
  });
});

describe("extra live refreshes", () => {
  const paseo = {} as Parameters<AttentionService["turnEnded"]>[0];
  const turn = (id: string, parentAgentId: string | null = null) => ({ id, parentAgentId });
  // The service with no checks running, on an hourly schedule, so only what a test does refreshes it.
  async function quiet(agents = [startedAgent("a1", KEY), paseoAgent("other")], workspaces: ReturnType<typeof paseoWorkspace>[] = []) {
    const h = harness({ refreshMinutes: 60 });
    h.github.live.mockImplementation(async (_config, at) => checksDone(fixture(at)));
    vi.mocked(h.paseo.sessions).mockResolvedValue({ agents, workspaces });
    await h.start();
    return h;
  }

  it("FRESH-04: a turn in a session started on an item refreshes live once GitHub's search caught up; others' turns don't", async () => {
    const { service, github, advance } = await quiet();
    await service.turnEnded(paseo, turn("other"));
    await advance(MINUTE);
    expect(github.live).toHaveBeenCalledTimes(1);
    await service.turnEnded(paseo, turn("a1"));
    await advance(SETTLE_MS - 1);
    expect(github.live).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(github.live).toHaveBeenCalledTimes(2);
  });

  it("FRESH-04, SES-08: a sub-agent's turn counts for its session, and so does a session Paseo links to the item's PR", async () => {
    const pr = paseoWorkspace("W1", "fix-vat", { githubRuntime: { pullRequest: { url: `https://github.com/${REPO}/pull/101` } } });
    const agents = [startedAgent("a1", KEY), paseoAgent("sub", { labels: { [PARENT_AGENT_LABEL]: "a1" } }), paseoAgent("subsub", { labels: { [PARENT_AGENT_LABEL]: "sub" } }), paseoAgent("linked", { workspaceId: "W1" })];
    for (const ended of [turn("subsub", "sub"), turn("linked")]) {
      const { service, github, advance } = await quiet(agents, [pr]);
      await service.turnEnded(paseo, ended);
      await advance(SETTLE_MS);
      expect(github.live).toHaveBeenCalledTimes(2);
    }
  });

  it("FRESH-04: a turn whose session can't be looked up refreshes nothing", async () => {
    const { service, github, paseo: port, advance } = await quiet();
    vi.mocked(port.sessions).mockRejectedValue(new Error("Paseo is restarting"));
    await service.turnEnded(paseo, turn("a1"));
    await advance(10 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(1);
  });

  it("FRESH-01, GH-01: extra refreshes come at most once in 5 minutes; one due sooner waits, and the ones waiting go as one", async () => {
    const { service, github, advance } = await quiet();
    await service.turnEnded(paseo, turn("a1"));
    await advance(SETTLE_MS);
    expect(github.live).toHaveBeenCalledTimes(2);
    await service.turnEnded(paseo, turn("a1"));
    await advance(MINUTE);
    await service.turnEnded(paseo, turn("a1"));
    // The last began at 0:30; it's 1:30.
    await advance(5 * MINUTE - MINUTE - 1);
    expect(github.live).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(github.live).toHaveBeenCalledTimes(3);
    await advance(30 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(3);
  });

  it("FRESH-04: a turn that an extra refresh already planned meets doesn't ask Paseo whose it was", async () => {
    const { service, github, paseo: port, advance } = await quiet();
    await service.turnEnded(paseo, turn("a1"));
    await advance(SETTLE_MS);
    await service.turnEnded(paseo, turn("a1"));
    await advance(MINUTE);
    // The next can't begin before 5:30, after this turn's 2:00.
    await service.turnEnded(paseo, turn("a1"));
    expect(port.sessions).toHaveBeenCalledTimes(2);
    await advance(10 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(3);
  });

  it("FRESH-01, GH-01: ⟳ begun after a turn's refresh was due meets it, and doesn't count against the budget", async () => {
    const { service, github, advance, jump } = await quiet();
    await service.turnEnded(paseo, turn("a1"));
    jump(SETTLE_MS);
    await service.get("live");
    await advance(10 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(2);
    await service.turnEnded(paseo, turn("a1"));
    await advance(SETTLE_MS);
    expect(github.live).toHaveBeenCalledTimes(3);
  });

  it("FRESH-01: while checks run on a PR of mine, the live feed refreshes every 5 minutes, until none do", async () => {
    const { github, start, advance } = harness({ refreshMinutes: 60 });
    await start();
    await advance(5 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(2);
    github.live.mockImplementation(async (_config, at) => checksDone(fixture(at)));
    await advance(5 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(3);
    await advance(30 * MINUTE);
    expect(github.live).toHaveBeenCalledTimes(3);
  });

  it("FRESH-01: the screen opening answers from the cache at once, refreshing a live feed 5 minutes old behind it", async () => {
    const { service, github, jump } = await quiet();
    jump(5 * MINUTE - 1);
    expect((await service.get(undefined, false, undefined, true)).feeds.live.refreshing).toBe(false);
    jump(1);
    const opened = await service.get(undefined, false, undefined, true);
    expect(opened.feeds.live).toMatchObject({ refreshing: true, fetchedAt: new Date(START).toISOString() });
    await settle();
    expect(github.live).toHaveBeenCalledTimes(2);
  });

  it("FRESH-01, FRESH-04: the view says when the live feed next refreshes by itself, on its schedule or an extra refresh", async () => {
    const { service } = await quiet();
    expect((await service.get(undefined, true)).feeds.live.nextAt).toBe(new Date(START + 60 * MINUTE).toISOString());
    await service.turnEnded(paseo, turn("a1"));
    expect((await service.get(undefined, true)).feeds.live.nextAt).toBe(new Date(START + SETTLE_MS).toISOString());
  });
});

describe("History's weeks", () => {
  const repository = { nameWithOwner: REPO };
  // Closed late on Sunday 8 November in UTC, already Monday in Tokyo; the PR that closed it merged on Monday 9 November.
  const issue = { number: 60, title: "Refunds", url: "u60", closedAt: "2026-11-08T20:00:00Z", stateReason: "COMPLETED", repository };
  const pr = { number: 61, title: "Refund button", url: "u61", mergedAt: "2026-11-09T10:00:00Z", repository, closingIssuesReferences: { nodes: [{ number: 60, repository }] } };
  // gh answering History's request as GitHub's search would: only what ended on or after each search's start.
  const searching: Gh = {
    graphql: (async (_query: string, variables: Record<string, string> = {}) => {
      const since = (name: string) => Date.parse(variables[name].match(/:>=(\S+)/)![1]);
      return {
        viewer: { login: "me", id: "U_me" },
        merged: { nodes: [pr].filter((node) => Date.parse(node.mergedAt) >= since("merged")) },
        reviewed: { nodes: [] },
        closed: { nodes: [issue].filter((node) => Date.parse(node.closedAt) >= since("closed")) },
      } satisfies HistoryResult;
    }) as Gh["graphql"],
    graphqlResult: (async () => ({ data: {}, errors: [], failures: [] })) as never,
  };
  const shown = (view: AttentionView) => historyWeeks(view.history, []).weeks.map((week) => week.done.map((item) => [item.number, item.children.map((child) => child.number)]));

  it("HIS-01: a PR merged this week shows even when the issue it closed was closed the week before", async () => {
    // Saturday 14 November, UTC, one week: from Monday 9 November.
    const { service, start } = harness({ historyWeeks: 1 }, gitHub(searching).history);
    await start();
    expect(shown(await service.get(undefined, true))).toEqual([[[61, []]]]);
  });

  it("HIS-01: weeks follow the time zone the screen sends, fetching History again once when it changes", async () => {
    const { service, github, start } = harness({ historyWeeks: 1 }, gitHub(searching).history);
    await start();
    const view = await service.get(undefined, false, "Asia/Tokyo");
    expect(shown(view)).toEqual([[[60, [61]]]]);
    await service.get(undefined, false, "Asia/Tokyo");
    expect(github.history).toHaveBeenCalledTimes(2);
  });
});

describe("what I just did", () => {
  const updating = { kind: "chip", chip: { text: "updating", tone: "neutral" } } as const;

  it("FRESH-03, ATT-22: a merge seen live counts for Wrap up at once and fetches History once, after GitHub caught up", async () => {
    const { service, github, start, advance } = harness({ refreshMinutes: 10 });
    const merged = {
      id: "PR_77", number: 77, title: "Merged on GitHub", url: "u", headRefName: "fix-77", merged: true, mergedAt: new Date(START).toISOString(),
      closedAt: new Date(START).toISOString(), repository: { nameWithOwner: REPO }, mergedBy: { login: "me" }, assignees: { nodes: [] }, timelineItems: { nodes: [] },
    };
    github.live.mockImplementation(async (_config, at) => {
      const { data, details } = fixture(at);
      return { data: { ...data, ended: { nodes: [merged] } }, details };
    });
    await start();
    expect((await service.get()).ownClosed).toMatchObject([{ key: `${REPO}#77`, target: { headRefName: "fix-77" } }]);
    expect(github.history).toHaveBeenCalledTimes(1);
    await advance(SETTLE_MS);
    expect(github.history).toHaveBeenCalledTimes(2);
    // History's search still lacks it: no fetch on every refresh after that.
    await advance(30 * MINUTE);
    expect(github.history).toHaveBeenCalledTimes(2);
  });

  it("FRESH-03: a merge History already lists, under its issue and in other case, fetches nothing more", async () => {
    const { github, start, advance } = harness({ refreshMinutes: 10 });
    const at = new Date(START).toISOString();
    const repository = { nameWithOwner: REPO };
    github.history.mockImplementation(async () => ({
      ...fixture(new Date(START)).data,
      closed: { nodes: [{ number: 40, title: "Backups", url: "u", closedAt: at, stateReason: "COMPLETED", repository }] },
      merged: { nodes: [{ number: 41, title: "Verify", url: "u", mergedAt: at, repository, closingIssuesReferences: { nodes: [{ number: 40, repository }] } }] },
    }));
    github.live.mockImplementation(async (_config, now) => {
      const { data, details } = fixture(now);
      const merged = { id: "PR_41", number: 41, title: "Verify", url: "u", merged: true, mergedAt: at, closedAt: at, repository: { nameWithOwner: REPO.toUpperCase() }, mergedBy: null, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
      return { data: { ...data, ended: { nodes: [merged] } }, details };
    });
    await start();
    await advance(30 * MINUTE);
    expect(github.history).toHaveBeenCalledTimes(1);
  });

  it("FRESH-02: an action's effect shows until a fetch begun after GitHub caught up, which follows by itself", async () => {
    const { service, github, start, advance, jump } = harness();
    await start();
    jump(1000);
    const work = vi.fn(async () => {});
    const after = await service.act(KEY, work, updating);
    expect(work).toHaveBeenCalled();
    expect([after.pending, chipsOf(after, KEY)]).toEqual([1, expect.arrayContaining(["updating"])]);
    // A refresh begun within the 30 s GitHub's search takes can't show it yet.
    jump(10_000);
    expect((await service.get("live")).pending).toBe(1);
    expect(github.live).toHaveBeenCalledTimes(2);
    await advance(20_000);
    expect(github.live).toHaveBeenCalledTimes(3);
    const view = await service.get(undefined, true);
    expect([view.pending, chipsOf(view, KEY)]).toEqual([0, expect.not.arrayContaining(["updating"])]);
  });

  it("FRESH-02: while fetches keep failing, an effect stops showing after ten minutes", async () => {
    const { service, github, start, jump } = harness();
    await start();
    github.live.mockRejectedValue(new Error("down"));
    await service.act(KEY, async () => {}, updating);
    jump(10 * MINUTE - 1);
    expect((await service.get(undefined, true)).pending).toBe(1);
    jump(1);
    expect((await service.get(undefined, true)).pending).toBe(0);
  });

  it("FRESH-02, GH-01: actions in a row get one follow-up, after the last; a merge also brings History", async () => {
    const { service, github, start, advance } = harness();
    await start();
    await service.act(KEY, async () => {}, updating);
    await advance(20_000);
    await service.act(KEY, async () => {}, { kind: "finished" });
    await advance(29_000);
    expect([github.live.mock.calls.length, github.history.mock.calls.length]).toEqual([1, 1]);
    await advance(1000);
    expect([github.live.mock.calls.length, github.history.mock.calls.length]).toEqual([2, 2]);
    // Merged into History as it will be fetched, until it is.
    expect((await service.get(undefined, true)).pending).toBe(0);
  });

  it("FRESH-02: a failed action changes nothing and follows up with nothing", async () => {
    const { service, github, start, advance } = harness();
    await start();
    await expect(service.act(KEY, () => Promise.reject(new Error("no")), updating)).rejects.toThrow("no");
    await advance(MINUTE);
    expect([github.live.mock.calls.length, (await service.get(undefined, true)).pending]).toEqual([1, 0]);
  });
});

describe("which view is newer", () => {
  const dismissed = (view: AttentionView) => !view.doing.some((section) => section.items.some((item) => item.key === KEY));

  it("FRESH-04: a view answered before a change can't undo the change's answer, however late it arrives", async () => {
    const { service, start } = harness();
    await start();
    const before = await service.get(undefined, true);
    const answer = await service.dismiss(KEY);
    const after = await service.get(undefined, true);
    expect(dismissed(newerView(answer, before))).toBe(true);
    expect(newerView(answer, after)).toBe(after);
  });

  it("FRESH-04: a refresh under way when a change is made answers with the change", async () => {
    const { service, github, start, jump } = harness();
    await start();
    const held = deferred<Awaited<ReturnType<GitHub["live"]>>>();
    github.live.mockImplementationOnce(() => held.promise);
    const refreshing = service.get("live");
    await settle();
    const answer = await service.dismiss(KEY);
    jump(MINUTE);
    held.resolve(fixture(new Date(START)));
    const refreshed = await refreshing;
    expect([dismissed(refreshed), newerView(answer, refreshed)]).toEqual([true, refreshed]);
  });

  it("FRESH-04: a view that said a refresh runs is older than one answered once it's done, failed or not", async () => {
    const { service, github, start } = harness();
    await start();
    for (const failing of [false, true]) {
      const held = deferred<Awaited<ReturnType<GitHub["live"]>>>();
      github.live.mockImplementationOnce(() => held.promise);
      const refresh = service.refresh("live").catch(() => {});
      const during = await service.get(undefined, true);
      if (failing) held.reject(new Error("down"));
      else held.resolve(fixture(new Date(START)));
      await refresh;
      const done = await service.get(undefined, true);
      expect([during.feeds.live.refreshing, done.feeds.live.refreshing, newerView(done, during)]).toEqual([true, false, done]);
    }
  });

  it("FRESH-04: Next up's filter answers with the view after it", async () => {
    const { service, start } = harness();
    await start();
    const before = await service.get(undefined, true);
    const scoped = await service.setScopes(["backend"]);
    const sourced = await service.setSources(["org:acme"]);
    expect(newerView(scoped, before).scopes).toEqual(["backend"]);
    expect(newerView(sourced, scoped)).toBe(sourced);
  });

  it("FRESH-04: a restarted server's views are newer than the last one's", async () => {
    const { service, start, restarted, jump } = harness();
    await start();
    await service.dismiss(KEY);
    const last = await service.get(undefined, true);
    jump(1000);
    const again = restarted();
    await again.start();
    const first = await again.get(undefined, true);
    expect(newerView(last, first)).toBe(first);
  });
});

describe("saving", () => {
  it("ATT-08: saves go one at a time, so an older snapshot never lands last, even after Undo", async () => {
    const { service, store, saved, start } = harness();
    await start();
    const before = saved.length;
    const held = deferred();
    vi.mocked(store.saveState).mockImplementationOnce(async (state) => {
      saved.push(structuredClone(state));
      await held.promise;
    });
    const dismissing = service.dismiss(KEY);
    await settle();
    const undoing = service.undismiss(KEY);
    await settle();
    expect(saved.length).toBe(before + 1);
    expect(saved.at(-1)!.dismissed[KEY]).toBeDefined();
    held.resolve();
    await Promise.all([dismissing, undoing]);
    expect(saved.length).toBe(before + 2);
    expect(saved.at(-1)!.dismissed).toEqual({});
  });

  it("ATT-08: a failed save doesn't stop the next one", async () => {
    const { service, store, saved, start } = harness();
    await start();
    vi.mocked(store.saveState).mockRejectedValueOnce(new Error("disk full"));
    await expect(service.dismiss(KEY)).rejects.toThrow("disk full");
    await service.setScopes(["Backend"]);
    expect(saved.at(-1)!).toMatchObject({ scopes: ["Backend"], dismissed: { [KEY]: expect.anything() } });
  });
});

describe("projects", () => {
  it("NXT-12, GH-01: whether projects can be read is asked at most hourly, or when Settings asks, and shared", async () => {
    const { service, github, start, jump } = harness();
    await start();
    expect(github.probeProjects).toHaveBeenCalledTimes(1);
    expect(github.live.mock.calls[0]![3].on).toBe(true);
    expect(await service.projectsAccess()).toMatchObject({ state: "on" });
    jump(59 * MINUTE);
    await service.get("live");
    expect(github.probeProjects).toHaveBeenCalledTimes(1);
    jump(MINUTE);
    await service.get("live");
    expect(github.probeProjects).toHaveBeenCalledTimes(2);
    await Promise.all([service.projectsAccess(true), service.projectsAccess(true)]);
    expect(github.probeProjects).toHaveBeenCalledTimes(3);
  });

  it("NXT-12: a probe that fails counts toward the hour, so an outage doesn't add one to every refresh", async () => {
    const { service, github, start, jump } = harness();
    github.probeProjects.mockResolvedValueOnce(new Error("timeout"));
    await start();
    expect(github.live.mock.calls[0]![3].on).toBe(false);
    jump(30 * MINUTE);
    await service.get("live");
    expect(github.probeProjects).toHaveBeenCalledTimes(1);
    expect((await service.projectsAccess()).state).toBe("failed");
  });

  it("NXT-12: a search that had to go without projects turns them off until the next probe, and Settings says why", async () => {
    const { service, github, start } = harness();
    github.live.mockImplementationOnce(async (_config, at, _unclaimed, projects) => {
      projects.problems.push("missing read:project");
      projects.failed("missing read:project");
      return fixture(at);
    });
    await start();
    expect(await service.projectsAccess()).toMatchObject({ state: "missing", warning: "missing read:project" });
    await service.get("live");
    expect(github.live.mock.calls[1]![3].on).toBe(false);
  });
});

describe("kept worktrees", () => {
  const target = { itemKey: KEY, agentIds: ["a1"], keys: [KEY], title: "Fix VAT", repo: REPO, number: 101, kind: "pr" as const };
  const paseo = {} as Parameters<AttentionService["archive"]>[0];
  const kept = { workspaceId: "w1", name: "Fix VAT", reason: "session" as const, detail: "Fix flaky test", agentId: "a2", sessionIds: ["a1"] };

  it("ATT-22: a worktree that stays keeps its row, saying why, until it's archived anywhere", async () => {
    const h = harness();
    h.paseo.archive = async () => ({ ok: true, kept: [kept], archivedAgents: [], archivedWorkspaces: [] });
    await h.start();
    const { view } = await h.service.archive(paseo, [target], false);
    expect(view.kept).toEqual([{ workspaceId: "w1", name: "Fix VAT", reason: "session", detail: "Fix flaky test", agentId: "a2", itemKey: KEY, title: "Fix VAT", repo: REPO, number: 101, kind: "pr", at: expect.any(String) }]);
    expect(h.saved.at(-1)?.kept).toHaveLength(1);
    await h.service.forgetKept("w1");
    expect(h.saved.at(-1)?.kept).toEqual([]);
  });

  it("ATT-22: tried again, a kept row goes once its worktree does, or stays with the new reason; Dismiss leaves the worktree", async () => {
    const h = harness();
    const archive = vi.fn<Port["paseo"]["archive"]>(async () => ({ ok: true, kept: [kept], archivedAgents: [], archivedWorkspaces: [] }));
    h.paseo.archive = archive;
    await h.start();
    await h.service.archive(paseo, [target], false);
    archive.mockResolvedValueOnce({ ok: true, kept: [{ ...kept, reason: "refused", detail: "busy", agentId: undefined, sessionIds: [] }], archivedAgents: [], archivedWorkspaces: [] });
    const again = await h.service.archiveWorktree(paseo, "w1", true, ["t1"]);
    expect(archive).toHaveBeenLastCalledWith(paseo, [], true, ["t1"], ["w1"]);
    expect(again.view.kept).toMatchObject([{ workspaceId: "w1", reason: "refused", detail: "busy", itemKey: KEY }]);
    archive.mockResolvedValueOnce({ ok: true, kept: [], archivedAgents: [], archivedWorkspaces: [] });
    expect((await h.service.archiveWorktree(paseo, "w1", false)).view.kept).toEqual([]);
    await h.service.archive(paseo, [target], false);
    expect((await h.service.dismissKept("w1")).kept).toEqual([]);
  });

  it("ATT-22: a worktree Paseo archived while an archive still ran gets no kept row afterwards", async () => {
    const h = harness();
    let finish!: () => void;
    h.paseo.archive = () => new Promise((resolve) => (finish = () => resolve({ ok: true, kept: [kept], archivedAgents: [], archivedWorkspaces: [] })));
    await h.start();
    const archiving = h.service.archive(paseo, [target], false);
    await settle();
    await h.service.forgetKept("w1");
    finish();
    expect((await archiving).view.kept).toEqual([]);
  });
});

describe("asking to close an issue", () => {
  const repository = { nameWithOwner: REPO };
  const ISSUE = `${REPO}#900`;
  const merged = (number: number, mergedAt: string) => ({ number, title: `Step ${number}`, url: `u${number}`, body: `Closes #900`, mergedAt, repository, closingIssuesReferences: { nodes: [] } });
  const open = { number: 900, title: "Export to CSV", url: "u900", state: "OPEN", repository, closedByPullRequestsReferences: { nodes: [] as { state: string }[] } };
  // gh answering History's search with my merged PRs, and the lookup of the issue they refer to as `issue` says.
  const gh = (prs: ReturnType<typeof merged>[], issue = open): Gh => ({
    graphql: (async () => ({ viewer: { login: "me", id: "U_me" }, merged: { nodes: prs }, reviewed: { nodes: [] }, closed: { nodes: [] } }) satisfies HistoryResult) as Gh["graphql"],
    graphqlResult: (async (query: string) => ({ data: query.includes(`number: ${issue.number}`) ? { i0: { issueOrPullRequest: issue } } : {}, errors: [], failures: [] })) as never,
  });
  const asked = (view: AttentionView) => (view.closeAsks ?? []).map((ask) => [ask.key, ask.prs.map((pr) => pr.number)]);

  it("ATT-24: asks once my PRs under an open issue have merged; Keep open lasts until another merges", async () => {
    const prs = [merged(901, "2026-11-12T10:00:00Z")];
    const { service, start } = harness({}, (config, now, timeZone) => gitHub(gh(prs)).history(config, now, timeZone));
    await start();
    expect(asked(await service.get(undefined, true))).toEqual([[ISSUE, [901]]]);
    expect(asked(await service.keepOpen(ISSUE, true))).toEqual([]);
    // Nothing new: still kept open after History is fetched again.
    expect(asked(await service.get("history"))).toEqual([]);
    prs.push(merged(902, "2026-11-13T10:00:00Z"));
    expect(asked(await service.get("history"))).toEqual([[ISSUE, [901, 902]]]);
  });

  it("ATT-24, ATT-14: Close takes the issue, with its PRs, to History until it's fetched; Undo asks again", async () => {
    const { service, start } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")])).history(config, now, timeZone));
    await start();
    const closed = await service.act(ISSUE, async () => {}, { kind: "finished" });
    expect(asked(closed)).toEqual([]);
    expect(closed.history.find((item) => item.key === ISSUE)?.children.map((child) => child.number)).toEqual([901]);
    expect(asked(await service.act(ISSUE, async () => {}, null))).toEqual([[ISSUE, [901]]]);
  });

  it("ATT-24: Keep open outlasts a fetch that doesn't ask, as while someone's PR is open for it", async () => {
    const issue = structuredClone(open);
    const { service, start } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")], issue)).history(config, now, timeZone));
    await start();
    await service.keepOpen(ISSUE, true);
    issue.closedByPullRequestsReferences.nodes = [{ state: "OPEN" }];
    expect(asked(await service.get("history"))).toEqual([]);
    // Their PR closed unmerged: nothing of mine merged since, so it's still kept open.
    issue.closedByPullRequestsReferences.nodes = [];
    expect(asked(await service.get("history"))).toEqual([]);
  });

  it("ATT-24, HIS-01: an issue closed when asked stays in History with its PRs under it, though History's search can't find it", async () => {
    const issue = structuredClone(open);
    const { service, start, advance } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")], issue)).history(config, now, timeZone));
    await start();
    await service.act(ISSUE, async () => {}, { kind: "finished" });
    issue.state = "CLOSED";
    // GitHub caught up: History is fetched again, and the close is no longer pending.
    await advance(SETTLE_MS + 1);
    const view = await service.get(undefined, true);
    expect([view.pending, asked(view)]).toEqual([0, []]);
    expect(view.history.filter((item) => [ISSUE, `${REPO}#901`].includes(item.key)).map((item) => [item.key, item.children.map((child) => child.number)])).toEqual([[ISSUE, [901]]]);
  });

  it("ATT-24: an issue closed when asked and reopened on GitHub leaves History and asks again", async () => {
    const issue = structuredClone(open);
    const { service, start, advance } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")], issue)).history(config, now, timeZone));
    await start();
    await service.act(ISSUE, async () => {}, { kind: "finished" });
    issue.state = "CLOSED";
    await advance(SETTLE_MS + 1);
    issue.state = "OPEN";
    const view = await service.get("history");
    expect([view.history.some((item) => item.key === ISSUE), asked(view)]).toEqual([false, [[ISSUE, [901]]]]);
  });

  it("ATT-24: Undo after the close settled fetches History, which asks again", async () => {
    const issue = structuredClone(open);
    const { service, github, start, advance } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")], issue)).history(config, now, timeZone));
    await start();
    await service.act(ISSUE, async () => {}, { kind: "finished" });
    issue.state = "CLOSED";
    await advance(SETTLE_MS + 1);
    const fetched = github.history.mock.calls.length;
    issue.state = "OPEN";
    await service.act(ISSUE, async () => {}, null);
    await advance(SETTLE_MS + 1);
    expect(github.history.mock.calls.length).toBeGreaterThan(fetched);
    expect(asked(await service.get(undefined, true))).toEqual([[ISSUE, [901]]]);
  });

  it("ATT-24, GH-01: the live refresh looks the asked issue up again: a PR opened for it since stops the question", async () => {
    const { service, github, start } = harness({}, (config, now, timeZone) => gitHub(gh([merged(901, "2026-11-12T10:00:00Z")])).history(config, now, timeZone));
    await start();
    expect(asked(await service.get(undefined, true))).toEqual([[ISSUE, [901]]]);
    github.issues.mockResolvedValue({ [ISSUE]: { ...open, closedByPullRequestsReferences: { nodes: [{ state: "OPEN" }] } } });
    expect(asked(await service.get("live"))).toEqual([]);
    expect(github.issues).toHaveBeenLastCalledWith([{ repo: REPO, number: 900 }]);
  });

  it("ATT-24: closing an issue assigned to me keeps my merged PRs under it", async () => {
    // #152 is assigned to me in the fixture's live feed.
    const assigned = { ...structuredClone(open), number: 152, title: "Customer statements as PDF" };
    const pr = { ...merged(901, "2026-11-12T10:00:00Z"), body: "Closes #152" };
    const { service, start } = harness({}, (config, now, timeZone) => gitHub(gh([pr], assigned)).history(config, now, timeZone));
    await start();
    const closed = await service.act(`${REPO}#152`, async () => {}, { kind: "finished" });
    expect(closed.history.find((item) => item.key === `${REPO}#152`)?.children.map((child) => child.number)).toEqual([901]);
  });
});
