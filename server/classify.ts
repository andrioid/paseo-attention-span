import type { InboxConfig, MergeMethod } from "../shared/config";
import { ago, daysSince } from "../shared/format";
import { type ActionId, type Chip, type Inbox, type Item, type NextUpIssue, type Person, SECTION_ORDER, type SectionId, type SubRow, type Target } from "../shared/inbox";
import type { Actor, Comment, Details, HistoryResult, LiveResult, MentionNode, PickableNode, PullRequestNode } from "./github-types";
import { prKey } from "./queries";

// Turns one refresh worth of GitHub data into the inbox. Pure, so every rule is testable.

export interface ClassifyInput {
  data: LiveResult;
  details: Details;
  config: InboxConfig;
  now: Date;
}

const EPOCH = "1970-01-01T00:00:00Z";
const rank = (section: SectionId) => SECTION_ORDER.indexOf(section);
// Section order, then newest first.
const order = (a: Item, b: Item) => rank(a.section) - rank(b.section) || (b.closedAt ?? b.othersActivityAt).localeCompare(a.closedAt ?? a.othersActivityAt);
const latest = (...dates: (string | null | undefined)[]) => dates.reduce<string>((max, date) => (date && date > max ? date : max), EPOCH);
const chip = (text: string, tone: Chip["tone"] = "neutral"): Chip => ({ text, tone });
// Behind is shown on rows that appear anyway, neutral and never a reason by itself; conflicts are what's flagged [UPS-07].
const behindChip = (count: number, base: string) => chip(`${count} behind ${base}`);
const person = (actor: Actor | null | undefined, since: string): Person | undefined =>
  actor ? { login: actor.login, avatarUrl: actor.avatarUrl, bot: actor.__typename === "Bot", since } : undefined;

// Search returns empty objects for result types a fragment doesn't cover.
const compact = <T>(nodes: (T | null | undefined)[]) => nodes.filter((node): node is T => !!node && Object.keys(node).length > 0);

export function classify({ data, details, config, now }: ClassifyInput): Inbox {
  const me = data.viewer.login.toLowerCase();
  const isMe = (actor: { login: string } | null | undefined) => actor?.login.toLowerCase() === me;
  const isOther = (actor: { login: string } | null | undefined) => !!actor && !isMe(actor);

  const mentions = new Map<string, Person>();
  for (const node of compact(data.mentions.nodes)) {
    const waiting = waitingMention(node, me);
    if (waiting) mentions.set(prKey(node), waiting);
  }

  // My PRs, minus those handed over to someone else [PRS-08].
  const mine = compact(data.mine.nodes).filter((pr) => pr.assignees.nodes.length === 0 || pr.assignees.nodes.some(isMe));

  // Stacks, followed through base/head branch names [ATT-04].
  const byHead = new Map(mine.map((pr) => [`${pr.repository.nameWithOwner}\0${pr.headRefName}`, pr]));
  const parentOf = (pr: PullRequestNode) => {
    const parent = byHead.get(`${pr.repository.nameWithOwner}\0${pr.baseRefName}`);
    return parent === pr ? undefined : parent;
  };
  const stacks: PullRequestNode[][] = [];
  const seen = new Set<PullRequestNode>();
  const walk = (pr: PullRequestNode, stack: PullRequestNode[]) => {
    if (seen.has(pr)) return;
    seen.add(pr);
    stack.push(pr);
    for (const child of mine.filter((candidate) => parentOf(candidate) === pr)) walk(child, stack);
  };
  const byNumber = [...mine].sort((a, b) => a.number - b.number);
  for (const pr of byNumber) if (!parentOf(pr)) stacks.push([]), walk(pr, stacks[stacks.length - 1]);
  for (const pr of byNumber) if (!seen.has(pr)) stacks.push([pr]); // cycles, in theory

  const state = (pr: PullRequestNode) => {
    const commit = pr.commits.nodes[0]?.commit;
    const ci = commit?.statusCheckRollup?.state;
    const unresolved = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved);
    const last = (thread: (typeof unresolved)[number]) => thread.comments.nodes.at(-1);
    const onMe = unresolved.filter((thread) => !isMe(last(thread)?.author));
    const lastCommitAt = commit?.committedDate ?? pr.createdAt;
    const changesRequestedAt = latest(...pr.latestReviews.nodes.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.submittedAt));
    const behindBy = details.behind[prKey(pr)] ?? 0;
    return {
      ciFailing: ci === "FAILURE" || ci === "ERROR",
      ciPending: ci === "PENDING" || ci === "EXPECTED",
      conflicts: pr.mergeable === "CONFLICTING",
      approved: pr.reviewDecision === "APPROVED",
      autoMerge: !!pr.autoMergeRequest,
      threadsOnMe: onMe.length,
      botThreadsOnly: onMe.length > 0 && onMe.every((thread) => (thread.opener?.nodes[0] ?? last(thread))?.author?.__typename === "Bot"),
      // Requested changes stay mine until I push after them.
      changes: onMe.length > 0 || (pr.reviewDecision === "CHANGES_REQUESTED" && !(lastCommitAt > changesRequestedAt)),
      repliedAt: latest(...unresolved.filter((thread) => isMe(last(thread)?.author)).map((thread) => last(thread)?.createdAt)),
      lastCommitAt,
      behindBy,
      // A stacked PR no longer builds on its parent's latest version [UPS-02].
      outOfSync: !!parentOf(pr) && behindBy > 0,
      stale: daysSince(pr.updatedAt, now) >= config.staleDraftDays,
      othersActivityAt: latest(
        ...pr.comments.nodes.filter((c) => isOther(c.author)).map((c) => c.createdAt),
        ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes).filter((c) => isOther(c.author)).map((c) => c.createdAt),
        ...pr.latestReviews.nodes.filter((r) => isOther(r.author)).map((r) => r.submittedAt),
      ),
    };
  };

  const items: Item[] = [];
  const listed = new Set<string>();

  // One unit per stack (or single PR) of mine.
  const units = stacks.map((stack) => {
    const bottom = stack[0];
    const s = state(bottom);
    const outOfSync = stack.slice(1).some((pr) => state(pr).outOfSync || state(pr).conflicts);
    const waiting = stack.map((pr) => mentions.get(prKey(pr))).find(Boolean);
    const base = bottom.baseRefName;

    const reasons: SectionId[] = [];
    if (waiting) reasons.push("reply");
    if (bottom.isDraft) reasons.push("drafts");
    else {
      if (s.ciFailing) reasons.push("ci");
      if (s.changes) reasons.push("changes");
      // Auto-merge waiting on CI leaves nothing for me to do.
      if (s.approved && !s.conflicts && !s.ciFailing && !s.changes && !(s.autoMerge && s.ciPending)) reasons.push("ready");
      if (s.conflicts || outOfSync) reasons.push("upstream");
    }
    // Otherwise it waits on others: CI, the reviewer after my reply, or a review [WAI-01].
    const waitingSince = latest(s.lastCommitAt, s.repliedAt);
    const replied = s.repliedAt > EPOCH || bottom.reviewDecision === "CHANGES_REQUESTED";
    const waitingFor: SectionId = s.ciPending ? "wait_ci" : replied ? "wait_reviewer" : "wait_review";
    const waitingLabel = { wait_ci: "CI running", wait_reviewer: "waiting for the reviewer", wait_review: "waiting for review" }[waitingFor as "wait_ci"];
    // After too long it's mine to nudge [ATT-11].
    if (!bottom.isDraft && reasons.length === 0) reasons.push(daysSince(waitingSince, now) >= config.waitingTooLongDays ? "too_long" : waitingFor);
    const section = reasons.sort((a, b) => rank(a) - rank(b))[0];
    const reviewer = replied
      ? bottom.latestReviews.nodes.find((review) => review.state === "CHANGES_REQUESTED")?.author
      : bottom.reviewRequests.nodes.find((request) => request.requestedReviewer?.login)?.requestedReviewer;

    const actions: ActionId[] = [];
    if (section === "reply") actions.push(...replyActions(waiting));
    // Rerun is for flaky checks, without an agent [PRS-09].
    if (section === "ci") actions.push("fix", "rerun");
    if (section === "changes") actions.push("address");
    // Merge only once CI passed against the current base [PRS-04, UPS-07]. Until then, auto-merge if the repo allows it [PRS-10].
    if (section === "ready")
      actions.push(...(s.behindBy > 0 ? [stack.length === 1 ? "update" : "rebase"] : s.ciPending ? (bottom.repository.autoMergeAllowed ? ["automerge"] : []) : ["merge"]) as ActionId[]);
    if (section === "upstream") actions.push("rebase");
    // A stale draft offers Refresh and Close instead of Rebase [PRS-07]; a healthy one, Ready for review [PRS-11].
    if (section === "drafts")
      actions.push(...(s.stale ? ["refresh", "close"] : s.conflicts || outOfSync ? ["rebase"] : s.ciFailing ? ["fix", "rerun"] : ["ready"]) as ActionId[]);

    const chips: Chip[] = [];
    if (section === "too_long") chips.push(chip(`${waitingLabel} · ${ago(waitingSince, now)}`, "warn"));
    if (bottom.isDraft && s.stale) chips.push(chip(`untouched ${ago(bottom.updatedAt, now)}`, "warn"));
    if (s.approved && !bottom.isDraft) chips.push(chip("approved", "good"));
    if (s.autoMerge) chips.push(chip("auto-merge on", "good"));
    if (bottom.reviewDecision === "CHANGES_REQUESTED") chips.push(chip("changes requested", "warn"));
    if (s.threadsOnMe > 0) chips.push(chip(`${s.threadsOnMe} unresolved`, "warn"));
    if (s.ciFailing) chips.push(chip("CI failing", "bad"));
    else if (s.ciPending) chips.push(chip("CI running", "warn"));
    else if (section === "ready" && s.behindBy === 0) chips.push(chip("CI passed", "good"));
    if (s.conflicts) chips.push(chip("conflicts", "bad"));
    if (s.behindBy > 0) chips.push(behindChip(s.behindBy, base));
    if (stack.length > 1) chips.push(chip(`stack of ${stack.length}`));

    return {
      stack,
      section,
      actions,
      chips,
      // How long it has waited, shown only while it sits in a Waiting section.
      waited: section.startsWith("wait_") ? chip(ago(waitingSince, now)) : undefined,
      person:
        waiting ??
        (section === "changes" && s.botThreadsOnly ? { login: "review bot", bot: true, since: s.lastCommitAt } : undefined) ??
        (section === "too_long" || section.startsWith("wait_") ? person(reviewer, waitingSince) : undefined),
      othersActivityAt: latest(...stack.map((pr) => state(pr).othersActivityAt), waiting?.since),
    };
  });
  type Unit = (typeof units)[number];

  const subRow = (pr: PullRequestNode, index: number, stack: PullRequestNode[]): SubRow => {
    const s = state(pr);
    const parent = parentOf(pr);
    const chips: Chip[] = [];
    if (stack.length > 1) chips.push(chip(`${index + 1}/${stack.length}`));
    if (s.approved) chips.push(chip("approved", "good"));
    if (s.ciFailing) chips.push(chip("CI failing", "bad"));
    if (s.conflicts) chips.push(chip("conflicts", "bad"));
    if (s.behindBy > 0) chips.push(behindChip(s.behindBy, parent ? `#${parent.number}` : pr.baseRefName));
    return { key: prKey(pr), number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft, chips, attention: s.outOfSync || s.conflicts || s.ciFailing };
  };

  const target = (pr: PullRequestNode, stack: PullRequestNode[]): Target => ({
    kind: "pr",
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    id: pr.id,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    defaultBranch: pr.repository.defaultBranchRef?.name,
    mergeMethod: mergeMethodFor(pr, config),
    stack: stack.map((p) => ({ number: p.number, head: p.headRefName, base: p.baseRefName })),
  });

  // One item per issue: PRs grouped under the issue they close [ATT-03]. Otherwise one per unit.
  const groups = new Map<string, { lead?: PullRequestNode["closingIssuesReferences"]["nodes"][number]; units: Unit[] }>();
  for (const unit of units) {
    const issue = unit.stack[0].closingIssuesReferences.nodes[0];
    const key = issue ? `${issue.repository.nameWithOwner}#${issue.number}` : prKey(unit.stack[0]);
    groups.set(key, { lead: issue, units: [...(groups.get(key)?.units ?? []), unit] });
  }
  for (const [key, { lead, units: grouped }] of groups) {
    for (const unit of grouped) for (const pr of unit.stack) listed.add(prKey(pr));
    listed.add(key);
    const issueWaiting = lead ? mentions.get(key) : undefined;
    const sections = grouped.map((unit) => unit.section);
    if (issueWaiting) sections.push("reply");
    const section = sections.sort((a, b) => rank(a) - rank(b))[0];
    const unit = grouped.find((candidate) => candidate.section === section) ?? grouped[0];
    const bottom = unit.stack[0];
    items.push({
      key,
      section,
      kind: lead ? "issue" : "pr",
      draft: !lead && bottom.isDraft,
      repo: lead?.repository.nameWithOwner ?? bottom.repository.nameWithOwner,
      number: lead?.number ?? bottom.number,
      title: lead?.title ?? bottom.title,
      url: lead?.url ?? bottom.url,
      chips: [...(lead ? [chip(`PR #${bottom.number}`)] : []), ...unit.chips, ...(unit.section === section && unit.waited ? [unit.waited] : [])],
      person: issueWaiting ?? unit.person,
      actions: issueWaiting ? replyActions(issueWaiting) : unit.actions,
      children: lead ? grouped.flatMap((u) => u.stack.map((pr, i) => subRow(pr, i, u.stack))) : unit.stack.slice(1).map((pr, i) => subRow(pr, i + 1, unit.stack)),
      target: target(bottom, unit.stack),
      othersActivityAt: latest(...grouped.map((u) => u.othersActivityAt), issueWaiting?.since),
    });
  }

  // Review requests [REV-01].
  for (const pr of compact(data.reviews.nodes)) {
    const key = prKey(pr);
    if (listed.has(key)) continue;
    listed.add(key);
    const s = state(pr);
    const waiting = mentions.get(key);
    items.push({
      key,
      section: waiting ? "reply" : "review",
      kind: "pr",
      draft: pr.isDraft,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      chips: s.ciFailing ? [chip("CI failing", "bad")] : [],
      person: waiting ?? person(pr.author, s.lastCommitAt),
      actions: waiting ? [...replyActions(waiting), "review"] : ["review"],
      children: [],
      target: target(pr, [pr]),
      othersActivityAt: latest(s.othersActivityAt, s.lastCommitAt, waiting?.since),
    });
  }

  // Remaining mentions, including other people's drafts [MEN-03].
  for (const node of compact(data.mentions.nodes)) {
    const key = prKey(node);
    const waiting = mentions.get(key);
    if (!waiting || listed.has(key)) continue;
    listed.add(key);
    const kind = node.__typename === "PullRequest" ? "pr" : "issue";
    const repo = node.repository.nameWithOwner;
    items.push({
      key,
      section: "reply",
      kind,
      draft: false,
      repo,
      number: node.number,
      title: node.title,
      url: node.url,
      chips: [],
      person: waiting,
      actions: replyActions(waiting),
      children: [],
      target: { kind, repo, number: node.number, title: node.title, url: node.url },
      othersActivityAt: waiting.since,
    });
  }

  // Issues where I commented last and nobody answered: waiting, then mine to nudge [WAI-01, ATT-11].
  for (const issue of compact(data.commented.nodes)) {
    const key = prKey(issue);
    const last = issue.comments.nodes.at(-1);
    if (listed.has(key) || !last || !isMe(last.author)) continue;
    listed.add(key);
    const tooLong = daysSince(last.createdAt, now) >= config.waitingTooLongDays;
    items.push({
      ...plain(issue, "issue", tooLong ? "too_long" : "wait_answer"),
      chips: [chip(tooLong ? `waiting for an answer · ${ago(last.createdAt, now)}` : ago(last.createdAt, now), tooLong ? "warn" : "neutral")],
    });
  }

  items.sort(order);
  return {
    login: data.viewer.login,
    items,
    // Assigned issues not already in progress come before unclaimed ones [NXT-06].
    assigned: rankIssues(compact(data.assigned.nodes).filter((issue) => !listed.has(prKey(issue))), details, config),
    unclaimed: rankIssues(compact(data.unclaimed.nodes), details, config),
  };
}

// My merged PRs under the issues they closed, closed issues, and reviews [HIS-01, HIS-02].
export function classifyHistory(data: HistoryResult): Item[] {
  const items: Item[] = [];
  const closed = new Map<string, Item>();
  for (const issue of compact(data.closed.nodes)) {
    const notPlanned = issue.stateReason === "NOT_PLANNED";
    const item = { ...plain(issue, "issue", "done"), closedAt: issue.closedAt, chips: notPlanned ? [chip("not planned")] : [] };
    closed.set(prKey(issue), item);
    items.push(item);
  }
  for (const pr of compact(data.merged.nodes)) {
    const issue = closed.get(pr.closingIssuesReferences.nodes.map(prKey).find((key) => closed.has(key)) ?? "");
    if (issue) issue.children.push({ key: prKey(pr), number: pr.number, title: pr.title, url: pr.url, draft: false, chips: [], attention: false });
    else items.push({ ...plain(pr, "pr", "done"), closedAt: pr.mergedAt });
  }
  for (const pr of compact(data.reviewed.nodes)) items.push({ ...plain(pr, "pr", "reviewed"), closedAt: pr.mergedAt, person: person(pr.author, pr.mergedAt) });
  return items.sort(order);
}

// An item with nothing to act on: waiting, history.
function plain(node: { repository: { nameWithOwner: string }; number: number; title: string; url: string }, kind: "pr" | "issue", section: SectionId): Item {
  const repo = node.repository.nameWithOwner;
  return {
    key: prKey(node),
    section,
    kind,
    draft: false,
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    chips: [],
    actions: [],
    children: [],
    target: { kind, repo, number: node.number, title: node.title, url: node.url },
    othersActivityAt: EPOCH,
  };
}

export function mergeMethodFor(pr: PullRequestNode, config: InboxConfig): MergeMethod {
  // The configured method, else the first the repository allows of squash, merge, rebase [PRS-04].
  return config.mergeMethods[pr.repository.nameWithOwner] ?? (pr.repository.squashMergeAllowed !== false ? "squash" : pr.repository.mergeCommitAllowed ? "merge" : "rebase");
}

// ---- Next up: issues by priority, effort, then age [NXT-02] ----

function rankIssues(nodes: PickableNode[], details: Details, config: InboxConfig): NextUpIssue[] {
  const { priority, effort, scope } = config.nextUp;
  const valueOf = (node: PickableNode, field: string | undefined) =>
    field ? node.issueFieldValues.nodes.find((value) => value.field?.name === field)?.name : undefined;
  // Position in the configured order (matched by name), else in the field's own options; missing goes last.
  const position = (value: string | undefined, ranked: { field: string; order?: string[] } | undefined) => {
    if (!value || !ranked) return Infinity;
    const order = ranked.order ?? details.fieldOptions[ranked.field] ?? [];
    const index = order.findIndex((name) => value.toLowerCase().includes(name.toLowerCase()));
    return index < 0 ? Infinity : index;
  };
  return nodes
    .map((node) => ({
      key: prKey(node),
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      createdAt: node.createdAt,
      type: node.issueType?.name,
      priority: valueOf(node, priority?.field),
      effort: valueOf(node, effort?.field),
      scope: valueOf(node, scope?.field),
      defaultBranch: node.repository.defaultBranchRef?.name,
    }))
    .sort(
      (a, b) =>
        position(a.priority, priority) - position(b.priority, priority) ||
        position(a.effort, effort) - position(b.effort, effort) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

// ---- Mentions still waiting on me [MEN-01..06] ----

// Reply on GitHub, or 👍 the waiting comments, which clears them too [MEN-02].
function replyActions(waiting: Person | undefined): ActionId[] {
  return waiting?.comments?.length ? ["reply", "acknowledge"] : ["reply"];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

function mentionsMe(body: string | undefined, me: string): number {
  if (!body) return -1;
  // Ignore quoted replies; a team mention (@org/team) never matches a login [MEN-04].
  const text = body.replace(/^\s*>.*$/gm, "");
  const match = new RegExp(`(^|[^\\w/@-])@${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "i").exec(text);
  return match ? match.index + match[1].length : -1;
}

function snippetAround(body: string, index: number): string {
  const flat = body.replace(/\s+/g, " ");
  const at = body.slice(0, index).replace(/\s+/g, " ").length;
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + 80);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export function waitingMention(node: MentionNode, me: string): Person | null {
  const isMe = (actor: Actor | null) => actor?.login.toLowerCase() === me;
  const threads = node.reviewThreads?.nodes ?? [];
  const opened: Comment = { id: node.id, author: node.author, body: node.body, createdAt: node.createdAt, url: node.url, reactionGroups: node.reactionGroups };
  const everything = [opened, ...node.comments.nodes, ...threads.flatMap((thread) => thread.comments.nodes)];
  // Replying clears it, and so does any review I submit afterwards [MEN-02].
  const myLastAt = latest(
    ...everything.filter((c) => isMe(c.author)).map((c) => c.createdAt),
    ...(node.reviews?.nodes ?? []).filter((r) => isMe(r.author)).map((r) => r.submittedAt),
  );
  // A bot counts only when it opened a thread I need to resolve [MEN-05].
  const botOpeners = new Set(threads.filter((thread) => !thread.isResolved).map((thread) => thread.comments.nodes[0]));

  const waiting = everything
    .filter(
      (c) =>
        c.author &&
        !isMe(c.author) &&
        (c.author.__typename !== "Bot" || botOpeners.has(c)) &&
        mentionsMe(c.body, me) >= 0 &&
        !c.reactionGroups?.some((group) => group.viewerHasReacted) && // so does reacting [MEN-02]
        c.createdAt > myLastAt,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = waiting.at(-1);
  if (!last?.author) return null;
  return {
    login: last.author.login,
    avatarUrl: last.author.avatarUrl,
    bot: waiting.every((c) => c.author?.__typename === "Bot"),
    since: waiting[0].createdAt,
    snippet: snippetAround(last.body ?? "", mentionsMe(last.body, me)),
    url: last.url ?? node.url,
    comments: waiting
      .filter((c) => c.id)
      .map((c) => ({ id: c.id!, author: c.author!.login, body: clip((c.body ?? "").trim(), 4000), createdAt: c.createdAt, url: c.url })),
  };
}
