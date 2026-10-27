import { describe, expect, it } from "vitest";
import { InboxConfig } from "../shared/config";
import { classify } from "./classify";
import type { Comment, IssueNode, MentionNode, PullRequestNode, SearchResult } from "./github-types";
import { searchVariables } from "./queries";

const NOW = new Date("2026-10-26T12:00:00Z");
const config = InboxConfig.parse({ orgs: ["acme"] });
const me = { __typename: "User", login: "me" };
const alice = { __typename: "User", login: "alice" };
const bot = { __typename: "Bot", login: "reviewbot" };
const REPO = "acme/app";

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function pr(number: number, overrides: Partial<PullRequestNode> = {}, ci: string | null = "SUCCESS"): PullRequestNode {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    isDraft: false,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    author: me,
    repository: { nameWithOwner: REPO, squashMergeAllowed: true, defaultBranchRef: { name: "master" } },
    baseRefName: "master",
    headRefName: `branch-${number}`,
    headRefOid: `oid${number}`,
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    assignees: { nodes: [] },
    closingIssuesReferences: { nodes: [] },
    commits: {
      nodes: [{ commit: { oid: `oid${number}`, committedDate: daysAgo(1), statusCheckRollup: ci ? { state: ci as never } : null } }],
    },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

function comment(author: typeof me, body: string, createdAt: string, extra: Partial<Comment> = {}): Comment {
  return { author, body, createdAt, url: `https://github.com/c/${body.length}`, reactionGroups: [], ...extra };
}

function mention(number: number, comments: Comment[], overrides: Partial<MentionNode> = {}): MentionNode {
  return {
    __typename: "Issue",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(1),
    author: alice,
    body: "no mention here",
    repository: { nameWithOwner: REPO },
    comments: { nodes: comments },
    ...overrides,
  };
}

function issue(number: number, comments: Comment[] = []): IssueNode {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    updatedAt: daysAgo(1),
    repository: { nameWithOwner: REPO },
    comments: { nodes: comments },
  };
}

function data(overrides: Partial<{ [K in keyof SearchResult]: SearchResult[K] extends { nodes: infer N } ? N : never }>): SearchResult {
  return {
    viewer: { login: "me" },
    mine: { nodes: overrides.mine ?? [] },
    reviews: { nodes: overrides.reviews ?? [] },
    mentions: { nodes: overrides.mentions ?? [] },
    assigned: { nodes: overrides.assigned ?? [] },
    commented: { nodes: overrides.commented ?? [] },
    merged: { nodes: overrides.merged ?? [] },
  } as SearchResult;
}

function run(input: Parameters<typeof data>[0], behind: Record<string, number> = {}) {
  return classify({ data: data(input), behind, config, now: NOW });
}

const key = (n: number) => `${REPO}#${n}`;

describe("sections", () => {
  it("ATT-02: puts each item once, under its most urgent reason, in section order", () => {
    const inbox = run({
      mine: [
        pr(1, { reviewDecision: "APPROVED" }),
        pr(2, {}, "FAILURE"),
        pr(3, { reviewDecision: "CHANGES_REQUESTED", latestReviews: { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(0.5) }] } }, "FAILURE"),
      ],
      reviews: [pr(9, { author: alice })],
    });
    expect(inbox.items.map((item) => [item.number, item.section])).toEqual([
      [9, "review"],
      [3, "ci"], // newest activity by others first
      [2, "ci"],
      [1, "ready"],
    ]);
  });

  it("REV-01: lists PRs requesting my review with a Review action", () => {
    const [item] = run({ reviews: [pr(9, { author: alice })] }).items;
    expect(item).toMatchObject({ section: "review", actions: ["review"] });
  });

  it("PRS-01: lists my PRs with failing checks with a Fix action", () => {
    const [item] = run({ mine: [pr(2, {}, "ERROR")] }).items;
    expect(item).toMatchObject({ section: "ci", actions: ["fix"] });
  });

  it("PRS-02: lists requested changes and unresolved threads waiting on me", () => {
    const thread = { isResolved: false, comments: { nodes: [comment(alice, "", daysAgo(1))] } };
    const [item] = run({ mine: [pr(3, { reviewThreads: { nodes: [thread] } })] }).items;
    expect(item).toMatchObject({ section: "changes", actions: ["address"] });
  });

  it("PRS-02: a thread I answered last waits on the reviewer instead", () => {
    const thread = { isResolved: false, comments: { nodes: [comment(me, "", daysAgo(1))] } };
    const inbox = run({ mine: [pr(3, { reviewThreads: { nodes: [thread] } })] });
    expect(inbox.items).toEqual([]);
    expect(inbox.footer.waitingOnOthers[0].detail).toMatch(/you replied/);
  });

  it("PRS-02: requested changes followed by a new push wait on the reviewer", () => {
    const reviewed = pr(3, {
      reviewDecision: "CHANGES_REQUESTED",
      latestReviews: { nodes: [{ author: alice, state: "CHANGES_REQUESTED", submittedAt: daysAgo(1.5) }] },
    });
    const inbox = run({ mine: [reviewed] });
    expect(inbox.items).toEqual([]);
    expect(inbox.footer.waitingOnOthers).toHaveLength(1);
  });
});

describe("ready to merge and behind base", () => {
  it("PRS-03, PRS-04: offers Merge only when CI passed against the current base", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, { [key(1)]: 0 }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["merge"], detail: "approved · ✓ CI" });
    expect(item.target.mergeMethod).toBe("squash");
  });

  it("UPS-03, PRS-04: a ready PR behind its base offers Update instead of Merge", () => {
    const [item] = run({ mine: [pr(1, { reviewDecision: "APPROVED" })] }, { [key(1)]: 1 }).items;
    expect(item.actions).toEqual(["update"]);
    expect(item.detail).toBe("approved · ✓ CI on old master · 1 behind master");
  });

  it("UPS-07: being behind alone never puts a PR on the list", () => {
    const inbox = run({ mine: [pr(1)] }, { [key(1)]: 400 });
    expect(inbox.items).toEqual([]);
    expect(inbox.footer.waitingOnOthers).toHaveLength(1);
  });

  it("UPS-01: a PR that conflicts with its base needs upstream, with Rebase", () => {
    const [item] = run({ mine: [pr(1, { mergeable: "CONFLICTING" })] }, { [key(1)]: 139 }).items;
    expect(item).toMatchObject({ section: "upstream", actions: ["rebase"] });
    expect(item.detail).toContain("✗ conflicts · 139 behind master");
  });

  it("PRS-04: uses the merge method from config, else the first the repo allows", () => {
    const merge = pr(1, { reviewDecision: "APPROVED", repository: { nameWithOwner: REPO, squashMergeAllowed: false, mergeCommitAllowed: true } });
    expect(run({ mine: [merge] }).items[0].target.mergeMethod).toBe("merge");
    const configured = classify({
      data: data({ mine: [pr(1, { reviewDecision: "APPROVED" })] }),
      behind: {},
      config: InboxConfig.parse({ mergeMethods: { [REPO]: "rebase" } }),
      now: NOW,
    });
    expect(configured.items[0].target.mergeMethod).toBe("rebase");
  });
});

describe("stacks", () => {
  const bottom = pr(10, { headRefName: "a" });
  const middle = pr(11, { baseRefName: "a", headRefName: "b", isDraft: true, reviewDecision: "APPROVED" });
  const top = pr(12, { baseRefName: "b", headRefName: "c", isDraft: true });

  it("ATT-04: shows a stack as one item led by its bottom PR", () => {
    const inbox = run({ mine: [top, bottom, middle] }, { [key(11)]: 279 });
    expect(inbox.items).toHaveLength(1);
    const [item] = inbox.items;
    expect(item.number).toBe(10);
    expect(item.children.map((child) => [child.number, child.detail])).toEqual([
      [11, "draft · 2/3 · approved · 279 behind 10"],
      [12, "draft · 3/3"],
    ]);
    expect(item.target.stack).toEqual([key(10), key(11), key(12)]);
  });

  it("UPS-02, UPS-04: a stacked PR behind its parent puts the stack under Needs upstream with Rebase", () => {
    const [item] = run({ mine: [bottom, middle, top] }, { [key(11)]: 3 }).items;
    expect(item).toMatchObject({ section: "upstream", actions: ["rebase"] });
    expect(item.detail).toContain("stack of 3");
  });

  it("UPS-03: a stacked ready PR behind its base gets Rebase, not Update", () => {
    const ready = pr(10, { headRefName: "a", reviewDecision: "APPROVED" });
    const [item] = run({ mine: [ready, middle] }, { [key(10)]: 2 }).items;
    expect(item).toMatchObject({ section: "ready", actions: ["rebase"] });
  });
});

describe("drafts", () => {
  it("PRS-05: lists my drafts after everything that isn't a draft", () => {
    const inbox = run({ mine: [pr(1, { isDraft: true }), pr(2, {}, "FAILURE")] });
    expect(inbox.items.map((item) => item.section)).toEqual(["ci", "drafts"]);
  });

  it("PRS-06: other people's drafts are not work items", () => {
    const theirs = mention(90, [comment(alice, "wip", daysAgo(1))], { __typename: "PullRequest", isDraft: true });
    expect(run({ mentions: [theirs] }).items).toEqual([]);
  });

  it("PRS-07: a draft untouched for 30 days offers Refresh and Close", () => {
    const [item] = run({ mine: [pr(1, { isDraft: true, updatedAt: daysAgo(60), mergeable: "CONFLICTING" })] }).items;
    expect(item.actions).toEqual(["refresh", "close"]);
    expect(item.detail).toContain("untouched for 2 months");
  });

  it("PRS-08: leaves out my PRs assigned to someone else", () => {
    const handedOver = pr(1, { isDraft: true, assignees: { nodes: [{ login: "alice" }] } });
    const shared = pr(2, { isDraft: true, assignees: { nodes: [{ login: "alice" }, { login: "me" }] } });
    expect(run({ mine: [handedOver, shared] }).items.map((item) => item.number)).toEqual([2]);
  });
});

describe("issues", () => {
  it("ATT-03: groups PRs under the issue they close, led by the issue", () => {
    const closes = { nodes: [{ number: 50, title: "Issue 50", url: "https://x/50", repository: { nameWithOwner: REPO } }] };
    const inbox = run({
      mine: [pr(1, { closingIssuesReferences: closes }, "FAILURE"), pr(2, { closingIssuesReferences: closes, reviewDecision: "APPROVED" })],
      assigned: [issue(50)],
    });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ kind: "issue", number: 50, section: "ci", actions: ["fix"] });
    expect(inbox.items[0].target.number).toBe(1);
    expect(inbox.items[0].children.map((child) => child.number)).toEqual([1, 2]);
    expect(inbox.footer.toDo).toEqual([]);
  });

  it("ATT-10: assigned issues and merged PRs are footer counts", () => {
    const inbox = run({
      assigned: [issue(60)],
      merged: [{ number: 7, title: "x", url: "u", mergedAt: daysAgo(1), repository: { nameWithOwner: REPO } }],
    });
    expect(inbox.items).toEqual([]);
    expect(inbox.footer.toDo.map((entry) => entry.number)).toEqual([60]);
    expect(inbox.footer.doneThisWeek.map((entry) => entry.number)).toEqual([7]);
  });
});

describe("waiting on others", () => {
  it("ATT-10: my PRs waiting for review or CI stay in the footer", () => {
    const inbox = run({ mine: [pr(1), pr(2, {}, "PENDING")] });
    expect(inbox.items).toEqual([]);
    expect(inbox.footer.waitingOnOthers.map((entry) => entry.detail.split(" · ")[0])).toEqual([
      "waiting for review",
      "CI running",
    ]);
  });

  it("ATT-11: moves work waiting more than 3 days into Waiting too long", () => {
    const old = pr(1, { commits: { nodes: [{ commit: { oid: "x", committedDate: daysAgo(4), statusCheckRollup: { state: "SUCCESS" } } }] } });
    const [item] = run({ mine: [old] }).items;
    expect(item).toMatchObject({ section: "too_long", detail: "waiting for review for 4d" });
  });

  it("ATT-10, ATT-11: issues where I commented last wait on others, then too long", () => {
    const inbox = run({ commented: [issue(70, [comment(me, "", daysAgo(1))]), issue(71, [comment(me, "", daysAgo(5))]), issue(72, [comment(alice, "", daysAgo(5))])] });
    expect(inbox.footer.waitingOnOthers.map((entry) => entry.number)).toEqual([70]);
    expect(inbox.items.map((item) => [item.number, item.section])).toEqual([[71, "too_long"]]);
  });
});

describe("mentions", () => {
  it("MEN-01: lists a thread where a person mentioned me and is waiting", () => {
    const [item] = run({ mentions: [mention(80, [comment(alice, "hey @me can you check the login flow?", daysAgo(3))])] }).items;
    expect(item).toMatchObject({ section: "reply", actions: ["reply"], detail: "alice · 3d", bot: false });
    expect(item.snippet).toContain("@me can you check");
  });

  it("MEN-02: replying or reacting clears a mention", () => {
    const replied = mention(80, [comment(alice, "@me ?", daysAgo(3)), comment(me, "done", daysAgo(2))]);
    const reacted = mention(81, [comment(alice, "@me ?", daysAgo(3), { reactionGroups: [{ viewerHasReacted: true }] })]);
    expect(run({ mentions: [replied, reacted] }).items).toEqual([]);
  });

  it("MEN-03: counts mentions in other people's drafts", () => {
    const draft = mention(82, [comment(alice, "early look please @me", daysAgo(1))], { __typename: "PullRequest", isDraft: true });
    expect(run({ mentions: [draft] }).items.map((item) => item.number)).toEqual([82]);
  });

  it("MEN-04: ignores team mentions and quoted mentions", () => {
    const team = mention(83, [comment(alice, "@acme/me please look", daysAgo(1)), comment(alice, "> @me said\nok", daysAgo(1))]);
    expect(run({ mentions: [team] }).items).toEqual([]);
  });

  it("MEN-05, MEN-06: a bot counts only when it opened an unresolved thread, marked as a bot", () => {
    const botComment = comment(bot, "@me this leaks a token", daysAgo(1));
    const opened = mention(84, [comment(bot, "@me deploy finished", daysAgo(1))], {
      __typename: "PullRequest",
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [botComment] } }] },
    });
    const [item] = run({ mentions: [opened] }).items;
    expect(item).toMatchObject({ number: 84, bot: true });
    expect(item.detail.startsWith("🤖")).toBe(true);
    expect(item.snippet).toContain("leaks a token");
  });

  it("MEN-01: a mention on my own PR makes it a reply", () => {
    const thread = mention(1, [comment(alice, "@me why?", daysAgo(1))], { __typename: "PullRequest" });
    const inbox = run({ mine: [pr(1, {}, "FAILURE")], mentions: [thread] });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ section: "reply", actions: ["reply"] });
  });
});

describe("GitHub requests", () => {
  it("SRC-01, GH-01: scopes every search to the configured orgs and repos", () => {
    const variables = searchVariables(InboxConfig.parse({ orgs: ["acme"], repos: ["acme/web"] }), NOW);
    for (const query of Object.values(variables)) expect(query).toContain("org:acme repo:acme/web");
    expect(variables.reviews).toContain("user-review-requested:@me");
    expect(variables.merged).toContain("merged:>=2026-10-26");
  });

  it("ATT-08: records the latest activity by others for dismissals", () => {
    const thread = { isResolved: false, comments: { nodes: [comment(alice, "", daysAgo(0.25))] } };
    const [item] = run({ mine: [pr(1, { reviewThreads: { nodes: [thread] }, comments: { nodes: [comment(me, "", daysAgo(0.1))] } })] }).items;
    expect(item.othersActivityAt).toBe(daysAgo(0.25));
  });
});
