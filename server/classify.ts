import { type Attention, type Chip, type Item, type NextUpIssue, type Person, type Reviewer, SECTION_ORDER, SECTIONS, type SectionId, type SubRow, type Target } from "../shared/attention";
import type { AttentionConfig, MergeMethod } from "../shared/config";
import { ago, daysSince } from "../shared/format";
import type { Actor, Comment, Details, HistoryResult, IssueNode, LinkedIssue, LiveResult, MentionNode, PickableNode, PullRequestNode, RequestedReviewer } from "./github-types";
import { excerpt, plainText } from "./markdown";
import { prKey } from "./queries";
import { issueFor } from "./references";
import { ISSUE_RULES, type IssueState, pick, PR_RULES, type PrState, replyActions, rulesBlock } from "./rules";

// Turns one refresh worth of GitHub data into what needs me. Pure, so every rule is testable.

export interface ClassifyInput {
  data: LiveResult;
  details: Details;
  config: AttentionConfig;
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

export function classify({ data, details, config, now }: ClassifyInput): Attention {
  const me = data.viewer.login.toLowerCase();
  const isMe = (actor: { login: string } | null | undefined) => actor?.login.toLowerCase() === me;
  const isOther = (actor: { login: string } | null | undefined) => !!actor && !isMe(actor);

  const mentions = new Map<string, Person>();
  for (const node of compact(data.mentions.nodes)) {
    const waiting = waitingMention(node, me);
    if (waiting) mentions.set(prKey(node), waiting);
  }

  // What each thread I'm in is waiting for: an answer, or me [ATT-16]. Both searches can find one; it's the same thread.
  const threads = new Map<string, IssueNode>();
  for (const node of [...compact(data.involved.nodes), ...compact(data.asked.nodes)]) threads.set(prKey(node), node);
  const answers = new Map<string, { flags: IssueState; person?: Person; mine: string }>();
  for (const [key, node] of threads) {
    const found = threadState(node, me, now, config);
    if (found) answers.set(key, found);
  }
  // Who answered, when the rule says that's on me [ATT-16, ATT-17].
  const answerOn = (key: string) => {
    const found = answers.get(key);
    return found && ISSUE_RULES.answered?.when(found.flags) ? found.person : undefined;
  };

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
    const anyFailing = ci === "FAILURE" || ci === "ERROR";
    const anyPending = ci === "PENDING" || ci === "EXPECTED";
    const mergeBlocked = pr.mergeStateStatus === "BLOCKED";
    // Where the repo requires checks, only those count; one that hasn't reported yet shows as GitHub blocking while CI runs.
    // Where it requires none, every check counts [PRS-14].
    const required = details.checks[prKey(pr)];
    const ciFailing = required?.required ? required.failing > 0 : anyFailing;
    const ciPending = !ciFailing && (required?.required ? required.pending > 0 || (anyPending && mergeBlocked) : anyPending);
    const unresolved = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved);
    const last = (thread: (typeof unresolved)[number]) => thread.comments.nodes.at(-1);
    const onMe = unresolved.filter((thread) => !isMe(last(thread)?.author));
    const lastCommitAt = commit?.committedDate ?? pr.createdAt;
    const changesRequestedAt = latest(...pr.latestReviews.nodes.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.submittedAt));
    const behindBy = details.behind[prKey(pr)] ?? 0;
    return {
      ciFailing,
      ciPending,
      optionalFailing: !ciFailing && anyFailing,
      optionalPending: !ciFailing && !ciPending && anyPending,
      conflicts: pr.mergeable === "CONFLICTING",
      mergeBlocked,
      approved: pr.reviewDecision === "APPROVED",
      // A request counts even when its reviewer can't be seen, like a team I can't read; so does any review [PRS-12].
      asked:
        pr.reviewRequests.nodes.length > 0 ||
        pr.latestReviews.nodes.some((review) => isOther(review.author)) ||
        pr.reviewDecision === "APPROVED" ||
        pr.reviewDecision === "CHANGES_REQUESTED",
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
    // A conversation comment after mine on any PR in the stack [ATT-16].
    const answer = stack.map((pr) => answerOn(prKey(pr))).find(Boolean);
    const base = bottom.baseRefName;
    const waitingSince = latest(s.lastCommitAt, s.repliedAt);
    const replied = s.repliedAt > EPOCH || bottom.reviewDecision === "CHANGES_REQUESTED";
    const flags: PrState = {
      draft: bottom.isDraft,
      waiting,
      answer,
      ciFailing: s.ciFailing,
      ciPending: s.ciPending,
      changes: s.changes,
      approved: s.approved,
      conflicts: s.conflicts,
      mergeBlocked: s.mergeBlocked,
      blocked: s.conflicts || outOfSync,
      autoMerge: s.autoMerge,
      autoMergeAllowed: !!bottom.repository.autoMergeAllowed,
      behindBy: s.behindBy,
      stacked: stack.length > 1,
      stale: s.stale,
      asked: s.asked,
      replied,
      tooLong: daysSince(waitingSince, now) >= config.waitingTooLongDays,
    };
    // Every PR of mine has a section; the tests check that a rule always holds.
    const section = pick(PR_RULES, flags) ?? "wait_review";
    const rule = PR_RULES[section];
    const actions = rule?.actions?.(flags) ?? [];
    const rulesBlocked = rulesBlock(flags);
    // Who it waits on: the reviewer who asked for changes, else who's requested, else who reviewed.
    const reviewer = replied
      ? bottom.latestReviews.nodes.find((review) => review.state === "CHANGES_REQUESTED")?.author
      : (bottom.reviewRequests.nodes.map((request) => requested(request.requestedReviewer)).find(Boolean) ??
        bottom.latestReviews.nodes.find((review) => isOther(review.author))?.author);

    const chips: Chip[] = [];
    if (section === "too_long") chips.push(chip(`${rule?.label?.(flags)} · ${ago(waitingSince, now)}`, "warn"));
    if (bottom.isDraft && s.stale) chips.push(chip(`untouched ${ago(bottom.updatedAt, now)}`, "warn"));
    if (s.approved && !bottom.isDraft) chips.push(chip("approved", "good"));
    if (rulesBlocked) chips.push(chip("blocked by repo rules", "warn"));
    if (s.autoMerge) chips.push(chip("auto-merge on", "good"));
    if (bottom.reviewDecision === "CHANGES_REQUESTED") chips.push(chip("changes requested", "warn"));
    if (s.threadsOnMe > 0) chips.push(chip(`${s.threadsOnMe} unresolved`, "warn"));
    if (s.ciFailing) chips.push(chip("CI failing", "bad"));
    else if (s.ciPending) chips.push(chip("CI running", "warn"));
    else if (s.optionalFailing) chips.push(chip("optional checks failing", "warn"));
    else if (section === "ready" && s.behindBy === 0) chips.push(chip(s.optionalPending ? "required checks passed" : "CI passed", "good"));
    if (s.conflicts) chips.push(chip("conflicts", "bad"));
    if (s.behindBy > 0) chips.push(behindChip(s.behindBy, base));
    if (stack.length > 1) chips.push(chip(`stack of ${stack.length}`));

    return {
      stack,
      section,
      actions,
      chips,
      // How long it has waited, shown only while it sits in a Waiting section.
      waited: SECTIONS[section].tab === "waiting" ? chip(ago(waitingSince, now)) : undefined,
      person:
        waiting ??
        (section === "answered" ? answer : undefined) ??
        (section === "changes" && s.botThreadsOnly ? { login: "review bot", bot: true, since: s.lastCommitAt } : undefined) ??
        // A rule, not a person, holds it up [PRS-13].
        (!rulesBlocked && (section === "too_long" || SECTIONS[section].tab === "waiting") ? person(reviewer, waitingSince) : undefined),
      othersActivityAt: latest(...stack.map((pr) => state(pr).othersActivityAt), waiting?.since, answer?.since),
    };
  });
  type Unit = (typeof units)[number];

  const subRow = (pr: PullRequestNode, index: number, stack: PullRequestNode[]): SubRow => {
    const s = state(pr);
    const parent = parentOf(pr);
    const chips: Chip[] = [];
    if (stack.length > 1) chips.push(chip(`${index + 1}/${stack.length}`));
    if (s.approved) chips.push(chip("approved", "good"));
    if (!pr.isDraft && !s.asked) chips.push(chip("no reviewer", "warn"));
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

  // One item per issue: PRs grouped under the issue they work on [ATT-03]. Otherwise one per unit.
  const issues = new Map(Object.entries(details.issues));
  for (const pr of mine) for (const issue of pr.closingIssuesReferences.nodes) issues.set(prKey(issue), issue);
  const groups = new Map<string, { lead?: LinkedIssue; units: Unit[] }>();
  for (const unit of units) {
    const prs = unit.stack.map((pr) => ({ repo: pr.repository.nameWithOwner, body: pr.body, linked: pr.closingIssuesReferences.nodes.map(prKey) }));
    const issue = issueFor(prs, (key) => issues.has(key));
    const key = issue ?? prKey(unit.stack[0]);
    groups.set(key, { lead: issue ? issues.get(issue) : undefined, units: [...(groups.get(key)?.units ?? []), unit] });
  }
  for (const [key, { lead, units: grouped }] of groups) {
    for (const unit of grouped) for (const pr of unit.stack) listed.add(prKey(pr));
    listed.add(key);
    // From the issue itself only what's on me counts: a mention, or an answer to my question. Its PRs say how the work goes [ATT-16].
    const issueWaiting = lead ? (mentions.get(key) ?? answerOn(key)) : undefined;
    const sections = grouped.map((unit) => unit.section);
    if (issueWaiting) sections.push(mentions.has(key) ? "reply" : "answered");
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

  // Issues and others' PRs I'm in: answered, or waiting on others and then mine to nudge [WAI-01, ATT-11, ATT-16].
  // My own PRs are listed above, or handed over and left out [PRS-08].
  for (const [key, issue] of threads) {
    const found = answers.get(key);
    const kind = issue.__typename === "PullRequest" ? "pr" : "issue";
    if (listed.has(key) || !found || (kind === "pr" && found.flags.authored)) continue;
    const { flags, person, mine } = found;
    const section = pick(ISSUE_RULES, flags);
    if (!section) continue;
    listed.add(key);
    const label = ISSUE_RULES[section]?.label?.(flags);
    const since = person?.since ?? mine;
    items.push({
      ...plain(issue, kind, section),
      chips: section === "answered" ? [] : [label ? chip(`${label} · ${ago(since, now)}`, "warn") : chip(ago(since, now))],
      person,
      actions: section === "answered" ? replyActions(person) : [],
      // A new answer brings back a dismissed one [ATT-08].
      othersActivityAt: person ? latest(...(person.comments ?? []).map((c) => c.createdAt)) : EPOCH,
    });
  }

  items.sort(order);
  return {
    login: data.viewer.login,
    items,
    reviewers: recentReviewers(mine, isOther),
    // Assigned issues not already in progress come before unclaimed ones [NXT-06].
    assigned: rankIssues(compact(data.assigned.nodes).filter((issue) => !listed.has(prKey(issue))), details, config),
    unclaimed: rankIssues(compact(data.unclaimed.nodes), details, config),
  };
}

// My merged PRs under the closed issues they worked on, closed issues, and reviews [HIS-01, HIS-02, ATT-03].
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
    // Each merged PR on its own: its branches are gone, so it can't be put back in its stack [ATT-03].
    const linked = { repo: pr.repository.nameWithOwner, body: pr.body, linked: pr.closingIssuesReferences.nodes.map(prKey) };
    const issue = closed.get(issueFor([linked], (key) => closed.has(key)) ?? "");
    if (issue) issue.children.push({ key: prKey(pr), number: pr.number, title: pr.title, url: pr.url, draft: false, chips: [], attention: false });
    else items.push({ ...plain(pr, "pr", "done"), closedAt: pr.mergedAt });
  }
  for (const pr of compact(data.reviewed.nodes)) items.push({ ...plain(pr, "pr", "reviewed"), closedAt: pr.mergedAt, person: person(pr.author, pr.mergedAt) });
  return items.sort(order);
}

// Whether my last comment on an issue is the last one from a person, and if not, the answers since that I haven't 👍'd.
// Bots don't count [MEN-05]. Only the last comments are fetched: once mine is out of them the conversation has moved on.
// Whether my last comment on a thread is the last one from a person, and if not, the recent comments since that I haven't 👍'd.
// On a thread I opened, my opening counts as my last word until I comment. Bots don't count [MEN-05]. Only the last comments
// are fetched: on someone else's thread, once mine is out of them the conversation has moved on.
export function threadState(
  thread: IssueNode,
  me: string,
  now: Date,
  config: Pick<AttentionConfig, "mentionDays" | "waitingTooLongDays" | "followThreads">,
): { flags: IssueState; person?: Person; mine: string } | null {
  const authored = thread.author?.login.toLowerCase() === me;
  const people = thread.comments.nodes.filter((c) => c.author && c.author.__typename !== "Bot");
  const index = people.findLastIndex((c) => c.author?.login.toLowerCase() === me);
  if (index < 0 && !authored) return null;
  const mine = index < 0 ? thread.createdAt : people[index].createdAt;
  const after = people.slice(index + 1);
  const recent = (at: string) => daysSince(at, now) < config.mentionDays;
  const unread = after.filter((c) => recent(c.createdAt) && !c.reactionGroups?.some((group) => group.viewerHasReacted));
  const flags: IssueState = {
    authored,
    follow: config.followThreads,
    // Opening a thread isn't asking a question; a comment is.
    mineLast: index >= 0 && after.length === 0,
    answered: unread.length > 0,
    fresh: recent(mine),
    tooLong: daysSince(mine, now) >= config.waitingTooLongDays,
  };
  const last = unread.at(-1);
  if (!last?.author) return { flags, mine };
  return {
    flags,
    mine,
    person: {
      login: last.author.login,
      avatarUrl: last.author.avatarUrl,
      bot: false,
      since: last.createdAt,
      snippet: snippetAround(plainText(last.body ?? ""), 0),
      url: last.url ?? thread.url,
      comments: unread.filter((c) => c.id).map((c) => ({ id: c.id!, author: c.author!.login, body: excerpt(c.body, 4000) ?? "", createdAt: c.createdAt, url: c.url })),
    },
  };
}

// A requested person, or a team by its "org/slug".
function requested(reviewer: RequestedReviewer | null | undefined): Actor | undefined {
  const login = reviewer?.login ?? reviewer?.combinedSlug;
  return login ? { __typename: reviewer!.__typename, login, avatarUrl: reviewer!.avatarUrl } : undefined;
}

// Who reviewed or was asked on my PRs, per repo, latest review first, for the reviewer picker [PRS-12]. Bots aren't offered.
function recentReviewers(mine: PullRequestNode[], isOther: (actor: Actor | null | undefined) => boolean): Record<string, Reviewer[]> {
  const byRepo: Record<string, (Reviewer & { at: string })[]> = {};
  for (const pr of mine) {
    const list = (byRepo[pr.repository.nameWithOwner] ??= []);
    const add = (actor: Actor | undefined, at: string) => {
      if (!actor || !isOther(actor) || actor.__typename === "Bot") return;
      const seen = list.find((reviewer) => reviewer.login === actor.login);
      if (seen) seen.at = seen.at > at ? seen.at : at;
      else list.push({ login: actor.login, avatarUrl: actor.avatarUrl, team: actor.__typename === "Team", at });
    };
    for (const review of pr.latestReviews.nodes) add(review.author ?? undefined, review.submittedAt ?? EPOCH);
    for (const request of pr.reviewRequests.nodes) add(requested(request.requestedReviewer), EPOCH);
  }
  return Object.fromEntries(
    Object.entries(byRepo)
      .filter(([, list]) => list.length > 0)
      .map(([repo, list]) => [repo, list.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _, ...reviewer }) => reviewer)]),
  );
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

export function mergeMethodFor(pr: PullRequestNode, config: AttentionConfig): MergeMethod {
  // The configured method, else the first the repository allows of squash, merge, rebase [PRS-04].
  return config.mergeMethods[pr.repository.nameWithOwner] ?? (pr.repository.squashMergeAllowed !== false ? "squash" : pr.repository.mergeCommitAllowed ? "merge" : "rebase");
}

// ---- Next up: issues by priority, effort, then age [NXT-02] ----

function rankIssues(nodes: PickableNode[], details: Details, config: AttentionConfig): NextUpIssue[] {
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
    .map((node) => {
      const rank = position(valueOf(node, priority?.field), priority);
      return {
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
        sources: node.sources ?? [],
        priorityRank: Number.isFinite(rank) ? rank : undefined,
        openPrs: (node.closedByPullRequestsReferences?.nodes ?? [])
          .filter((pr) => pr?.state === "OPEN")
          .map((pr) => ({ number: pr.number, url: pr.url, author: pr.author?.login ?? null })),
      };
    })
    .sort(
      (a, b) =>
        position(a.priority, priority) - position(b.priority, priority) ||
        position(a.effort, effort) - position(b.effort, effort) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

// ---- Mentions still waiting on me [MEN-01..06] ----

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
  // The quote is cut around the mention, so it's plain text; the 👍 picker renders whole comments as Markdown.
  const plain = plainText(last.body ?? "");
  return {
    login: last.author.login,
    avatarUrl: last.author.avatarUrl,
    bot: waiting.every((c) => c.author?.__typename === "Bot"),
    since: waiting[0].createdAt,
    snippet: snippetAround(plain, Math.max(0, mentionsMe(plain, me))),
    url: last.url ?? node.url,
    comments: waiting
      .filter((c) => c.id)
      .map((c) => ({ id: c.id!, author: c.author!.login, body: excerpt(c.body, 4000) ?? "", createdAt: c.createdAt, url: c.url })),
  };
}
