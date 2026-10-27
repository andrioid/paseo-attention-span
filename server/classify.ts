import type { InboxConfig, MergeMethod } from "../shared/config";
import { ago, daysSince } from "../shared/format";
import type { ActionId, FooterEntry, Inbox, Item, SectionId, SubRow, Target } from "../shared/inbox";
import { SectionId as Sections } from "../shared/inbox";
import type {
  Actor,
  BehindCounts,
  Comment,
  MentionNode,
  PullRequestNode,
  SearchResult,
} from "./github-types";
import { prKey } from "./queries";

// Turns one refresh worth of GitHub data into the inbox. Pure, so every rule is testable.

export interface ClassifyInput {
  data: SearchResult;
  behind: BehindCounts;
  config: InboxConfig;
  now: Date;
}

const EPOCH = "1970-01-01T00:00:00Z";
const URGENCY: readonly SectionId[] = Sections.options;

function mostUrgent(sections: SectionId[]): SectionId | null {
  let best: SectionId | null = null;
  for (const section of sections) {
    if (best === null || URGENCY.indexOf(section) < URGENCY.indexOf(best)) best = section;
  }
  return best;
}

function latest(...dates: (string | null | undefined)[]): string {
  let best = EPOCH;
  for (const date of dates) if (date && date > best) best = date;
  return best;
}

export function classify({ data, behind, config, now }: ClassifyInput): Inbox {
  const me = data.viewer.login.toLowerCase();
  const isMe = (actor: Actor | { login: string } | null | undefined) => actor?.login.toLowerCase() === me;
  const isBot = (actor: Actor | null | undefined) => actor?.__typename === "Bot";
  const isOther = (actor: Actor | null | undefined) => !!actor && !isMe(actor);

  // ---- Mentions still waiting on me [MEN-01..06] ----
  const mentions = new Map<string, Mention>();
  for (const node of compact(data.mentions.nodes)) {
    const mention = waitingMention(node, me);
    if (mention) mentions.set(prKey(node), mention);
  }

  // ---- My pull requests, minus handed-over ones [PRS-08] ----
  const mine = compact(data.mine.nodes).filter(
    (pr) => pr.assignees.nodes.length === 0 || pr.assignees.nodes.some(isMe),
  );

  // ---- Stacks: followed through base/head branch names [ATT-04] ----
  const byHead = new Map(mine.map((pr) => [`${pr.repository.nameWithOwner}\0${pr.headRefName}`, pr]));
  const parentOf = (pr: PullRequestNode) => byHead.get(`${pr.repository.nameWithOwner}\0${pr.baseRefName}`);
  const childrenOf = new Map<PullRequestNode, PullRequestNode[]>();
  for (const pr of mine) {
    const parent = parentOf(pr);
    if (parent && parent !== pr) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), pr]);
  }
  const stacks: PullRequestNode[][] = [];
  const seen = new Set<PullRequestNode>();
  const walk = (pr: PullRequestNode, into: PullRequestNode[]) => {
    if (seen.has(pr)) return;
    seen.add(pr);
    into.push(pr);
    for (const child of (childrenOf.get(pr) ?? []).sort((a, b) => a.number - b.number)) walk(child, into);
  };
  for (const pr of [...mine].sort((a, b) => a.number - b.number)) {
    if (!parentOf(pr) || parentOf(pr) === pr) {
      const stack: PullRequestNode[] = [];
      walk(pr, stack);
      stacks.push(stack);
    }
  }
  for (const pr of mine) if (!seen.has(pr)) stacks.push([pr]); // cycles, in theory

  // ---- PR state ----
  const state = (pr: PullRequestNode): PrState => {
    const commit = pr.commits.nodes[0]?.commit;
    const ci = commit?.statusCheckRollup?.state ?? null;
    const unresolved = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved);
    const lastIn = (thread: (typeof unresolved)[number]) => thread.comments.nodes[thread.comments.nodes.length - 1];
    const threadsOnMe = unresolved.filter((thread) => !isMe(lastIn(thread)?.author));
    const myReplies = unresolved.filter((thread) => isMe(lastIn(thread)?.author));
    const changesRequestedAt = latest(
      ...pr.latestReviews.nodes.filter((review) => review.state === "CHANGES_REQUESTED").map((review) => review.submittedAt),
    );
    const lastCommitAt = commit?.committedDate ?? pr.createdAt;
    const changesPending = pr.reviewDecision === "CHANGES_REQUESTED" && !(lastCommitAt > changesRequestedAt);
    const behindBy = behind[prKey(pr)];
    const parent = parentOf(pr);
    return {
      ci,
      ciFailing: ci === "FAILURE" || ci === "ERROR",
      ciPending: ci === "PENDING" || ci === "EXPECTED",
      conflicts: pr.mergeable === "CONFLICTING",
      approved: pr.reviewDecision === "APPROVED",
      threadsOnMe: threadsOnMe.length,
      botThreadsOnly:
        threadsOnMe.length > 0 && threadsOnMe.every((thread) => isBot((thread.opener?.nodes[0] ?? lastIn(thread))?.author)),
      changes: threadsOnMe.length > 0 || changesPending,
      repliedAt: latest(...myReplies.map((thread) => lastIn(thread)?.createdAt)),
      lastCommitAt,
      behindBy,
      // A stacked PR no longer builds on its parent's latest version [UPS-02].
      outOfSync: !!parent && (behindBy ?? 0) > 0,
      stale: daysSince(pr.updatedAt, now) >= config.staleDraftDays,
      othersActivityAt: latest(
        ...pr.comments.nodes.filter((c) => isOther(c.author)).map((c) => c.createdAt),
        ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes).filter((c) => isOther(c.author)).map((c) => c.createdAt),
        ...pr.latestReviews.nodes.filter((r) => isOther(r.author)).map((r) => r.submittedAt),
      ),
    };
  };

  const items: Item[] = [];
  const footer: Inbox["footer"] = { waitingOnOthers: [], toDo: [], doneThisWeek: [] };
  const listed = new Set<string>();

  // ---- One unit per stack (or single PR) of mine ----
  interface Unit {
    stack: PullRequestNode[];
    section: SectionId | null; // null: waiting on others, inside the threshold
    actions: ActionId[];
    detail: string;
    mention?: Mention;
    bot: boolean;
    waitingDetail: string;
    othersActivityAt: string;
  }
  const units: Unit[] = stacks.map((stack) => {
    const bottom = stack[0];
    const s = state(bottom);
    const states = stack.map(state);
    const stacked = stack.length > 1;
    const stackOutOfSync = states.slice(1).some((child) => child.outOfSync || child.conflicts);
    const mention = stack.map((pr) => mentions.get(prKey(pr))).find(Boolean);
    const base = bottom.baseRefName;

    const reasons: SectionId[] = [];
    if (mention) reasons.push("reply");
    if (bottom.isDraft) {
      reasons.push("drafts");
    } else {
      if (s.ciFailing) reasons.push("ci");
      if (s.changes) reasons.push("changes");
      if (s.approved && !s.conflicts && !s.ciFailing && !s.changes) reasons.push("ready");
      if (s.conflicts || stackOutOfSync) reasons.push("upstream");
    }

    // Waiting on others [ATT-10, ATT-11]: review, my replies, or CI.
    let waitingDetail = "";
    let waitingSince = latest(s.lastCommitAt, s.repliedAt);
    if (!bottom.isDraft && reasons.length === 0) {
      if (s.ciPending) waitingDetail = "CI running";
      else if (s.repliedAt > EPOCH || (bottom.reviewDecision === "CHANGES_REQUESTED" && !s.changes))
        waitingDetail = "you replied, waiting for the reviewer";
      else waitingDetail = "waiting for review";
      if (daysSince(waitingSince, now) >= config.waitingTooLongDays) reasons.push("too_long");
    }
    const section = mostUrgent(reasons);

    const actions: ActionId[] = [];
    const canUpdate = !stacked && !s.conflicts;
    switch (section) {
      case "reply":
        actions.push("reply");
        break;
      case "ci":
        actions.push("fix");
        break;
      case "changes":
        actions.push("address");
        break;
      case "ready":
        // Merge only once CI passed against the current base [PRS-04, UPS-07].
        if ((s.behindBy ?? 0) > 0) actions.push(canUpdate ? "update" : "rebase");
        else if (!s.ciPending) actions.push("merge");
        break;
      case "upstream":
        actions.push("rebase");
        break;
      case "drafts":
        // A stale draft offers Refresh and Close instead of Rebase [PRS-07].
        if (s.stale) actions.push("refresh", "close");
        else if (s.conflicts || stackOutOfSync) actions.push("rebase");
        else if (s.ciFailing) actions.push("fix");
        break;
    }

    const parts: string[] = [];
    if (mention) parts.push(mention.who, ago(mention.since, now));
    else {
      if (bottom.isDraft) parts.push("draft");
      if (s.stale && bottom.isDraft) parts.push(`untouched for ${ago(bottom.updatedAt, now)}`);
      if (section === "too_long") parts.push(`${waitingDetail} for ${ago(waitingSince, now)}`);
      if (s.approved && !bottom.isDraft) parts.push("approved");
      if (bottom.reviewDecision === "CHANGES_REQUESTED") parts.push("changes requested");
      if (s.threadsOnMe > 0) parts.push(`${s.threadsOnMe} unresolved`);
      if (s.ciFailing) parts.push("✗ CI failing");
      else if (s.ciPending) parts.push("CI running");
      else if (section === "ready") parts.push((s.behindBy ?? 0) > 0 ? `✓ CI on old ${base}` : "✓ CI");
      if (s.conflicts) parts.push("✗ conflicts");
      // Behind is shown on rows that appear anyway, never a reason by itself [UPS-07].
      if ((s.behindBy ?? 0) > 0) parts.push(`${s.behindBy} behind ${base}`);
      if (stacked) parts.push(`stack of ${stack.length}`);
    }

    return {
      stack,
      section,
      actions,
      detail: parts.join(" · "),
      mention,
      bot: mention ? mention.bot : section === "changes" && s.botThreadsOnly,
      waitingDetail: `${waitingDetail} · ${ago(waitingSince, now)}`,
      othersActivityAt: latest(...states.map((st) => st.othersActivityAt), mention?.since),
    };
  });

  const subRow = (pr: PullRequestNode, index: number, stack: PullRequestNode[]): SubRow => {
    const s = state(pr);
    const parent = parentOf(pr);
    const parts: string[] = [];
    if (pr.isDraft) parts.push("draft");
    if (stack.length > 1) parts.push(`${index + 1}/${stack.length}`);
    if (s.approved) parts.push("approved");
    if (s.ciFailing) parts.push("✗ CI failing");
    if (s.conflicts) parts.push("✗ conflicts");
    if ((s.behindBy ?? 0) > 0) parts.push(`${s.behindBy} behind ${parent ? parent.number : pr.baseRefName}`);
    return { key: prKey(pr), number: pr.number, title: pr.title, url: pr.url, detail: parts.join(" · ") };
  };

  // ---- One item per issue: PRs grouped under the issue they close [ATT-03] ----
  const byIssue = new Map<string, { issue: PullRequestNode["closingIssuesReferences"]["nodes"][number]; units: Unit[] }>();
  const loose: Unit[] = [];
  for (const unit of units) {
    const issue = unit.stack[0].closingIssuesReferences.nodes[0];
    if (!issue) {
      loose.push(unit);
      continue;
    }
    const key = `${issue.repository.nameWithOwner}#${issue.number}`;
    byIssue.set(key, { issue, units: [...(byIssue.get(key)?.units ?? []), unit] });
  }

  const pushUnitItem = (unit: Unit, lead?: { key: string; number: number; title: string; url: string; repo: string }, others: Unit[] = []) => {
    const bottom = unit.stack[0];
    const all = [unit, ...others];
    for (const u of all) for (const pr of u.stack) listed.add(prKey(pr));
    if (lead) listed.add(lead.key);
    const section = mostUrgent(all.map((u) => u.section).filter((s): s is SectionId => s !== null));
    if (section === null) {
      // Waiting on others, inside the threshold: footer only [ATT-10].
      for (const u of all) {
        const pr = u.stack[0];
        footer.waitingOnOthers.push({
          key: prKey(pr),
          repo: pr.repository.nameWithOwner,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          detail: u.waitingDetail,
        });
      }
      return;
    }
    const children = lead
      ? all.flatMap((u) => u.stack.map((pr, i) => subRow(pr, i, u.stack)))
      : unit.stack.slice(1).map((pr, i) => subRow(pr, i + 1, unit.stack));
    const leadUnit = all.find((u) => u.section === section) ?? unit;
    const leadPr = leadUnit.stack[0];
    items.push({
      key: lead?.key ?? prKey(bottom),
      section,
      kind: lead ? "issue" : "pr",
      repo: lead?.repo ?? bottom.repository.nameWithOwner,
      number: lead?.number ?? bottom.number,
      title: lead?.title ?? bottom.title,
      url: lead?.url ?? bottom.url,
      detail: lead ? `PR ${leadPr.number} · ${leadUnit.detail}` : leadUnit.detail,
      snippet: leadUnit.mention?.snippet,
      replyUrl: leadUnit.mention?.url,
      bot: leadUnit.bot,
      actions: leadUnit.actions,
      children,
      target: prTarget(leadPr, leadUnit.stack, config),
      othersActivityAt: latest(...all.map((u) => u.othersActivityAt)),
    });
  };

  for (const unit of loose) pushUnitItem(unit);
  for (const [key, { issue, units: grouped }] of byIssue) {
    const [first, ...rest] = grouped;
    pushUnitItem(first, { key, number: issue.number, title: issue.title, url: issue.url, repo: issue.repository.nameWithOwner }, rest);
    // A mention on the issue itself makes the whole item a reply.
    const mention = mentions.get(key);
    const item = items.find((candidate) => candidate.key === key);
    if (mention && item) {
      Object.assign(item, mentionFields(mention, now), { section: "reply", actions: ["reply"] });
      item.othersActivityAt = latest(item.othersActivityAt, mention.since);
    }
  }

  // ---- Review requests [REV-01] ----
  for (const pr of compact(data.reviews.nodes)) {
    const key = prKey(pr);
    if (listed.has(key)) continue;
    listed.add(key);
    const mention = mentions.get(key);
    const s = state(pr);
    const parts = [pr.author?.login ?? "ghost", ago(pr.updatedAt, now)];
    if (pr.isDraft) parts.push("draft");
    if (s.ciFailing) parts.push("✗ CI failing");
    items.push({
      key,
      section: mention ? "reply" : "review",
      kind: "pr",
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      detail: parts.join(" · "),
      bot: false,
      actions: mention ? ["reply", "review"] : ["review"],
      children: [],
      target: prTarget(pr, [pr], config),
      othersActivityAt: latest(s.othersActivityAt, s.lastCommitAt, mention?.since),
      ...(mention ? mentionFields(mention, now) : {}),
    });
  }

  // ---- Remaining mentions, including other people's drafts [MEN-03] ----
  for (const node of compact(data.mentions.nodes)) {
    const key = prKey(node);
    const mention = mentions.get(key);
    if (!mention || listed.has(key)) continue;
    listed.add(key);
    const kind = node.__typename === "PullRequest" ? "pr" : "issue";
    items.push({
      key,
      section: "reply",
      kind,
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      actions: ["reply"],
      children: [],
      target: { kind, repo: node.repository.nameWithOwner, number: node.number, title: node.title, url: node.url },
      othersActivityAt: mention.since,
      ...mentionFields(mention, now),
    });
  }

  // ---- Issues where I commented last and nobody answered [ATT-10, ATT-11] ----
  for (const issue of compact(data.commented.nodes)) {
    const key = prKey(issue);
    const last = issue.comments.nodes[issue.comments.nodes.length - 1];
    if (listed.has(key) || !last || !isMe(last.author)) continue;
    listed.add(key);
    const entry = issueEntry(issue, `waiting for an answer · ${ago(last.createdAt, now)}`);
    if (daysSince(last.createdAt, now) >= config.waitingTooLongDays) {
      items.push({
        ...entry,
        section: "too_long",
        kind: "issue",
        detail: `waiting for an answer for ${ago(last.createdAt, now)}`,
        bot: false,
        actions: [],
        children: [],
        target: { kind: "issue", repo: entry.repo, number: entry.number, title: entry.title, url: entry.url },
        othersActivityAt: EPOCH,
      });
    } else footer.waitingOnOthers.push(entry);
  }

  // ---- Assigned issues and merged PRs: footer counts [ATT-10] ----
  for (const issue of compact(data.assigned.nodes)) {
    if (listed.has(prKey(issue))) continue;
    footer.toDo.push(issueEntry(issue, `updated ${ago(issue.updatedAt, now)} ago`));
  }
  for (const pr of compact(data.merged.nodes)) {
    footer.doneThisWeek.push(issueEntry(pr, `merged ${ago(pr.mergedAt, now)} ago`));
  }

  items.sort(
    (a, b) => URGENCY.indexOf(a.section) - URGENCY.indexOf(b.section) || b.othersActivityAt.localeCompare(a.othersActivityAt),
  );
  return { login: data.viewer.login, items, footer };
}

// ---------------------------------------------------------------------------

interface PrState {
  ci: string | null;
  ciFailing: boolean;
  ciPending: boolean;
  conflicts: boolean;
  approved: boolean;
  threadsOnMe: number;
  botThreadsOnly: boolean;
  changes: boolean;
  repliedAt: string;
  lastCommitAt: string;
  behindBy: number | undefined;
  outOfSync: boolean;
  stale: boolean;
  othersActivityAt: string;
}

interface Mention {
  who: string;
  since: string;
  snippet: string;
  url: string;
  bot: boolean;
}

function mentionFields(mention: Mention, now: Date) {
  return {
    detail: `${mention.bot ? "🤖 " : ""}${mention.who} · ${ago(mention.since, now)}`,
    snippet: mention.snippet,
    replyUrl: mention.url,
    bot: mention.bot,
  };
}

function compact<T>(nodes: (T | null | undefined)[]): T[] {
  // Search returns empty objects for result types a fragment doesn't cover.
  return nodes.filter((node): node is T => !!node && Object.keys(node as object).length > 0);
}

function issueEntry(
  node: { repository: { nameWithOwner: string }; number: number; title: string; url: string },
  detail: string,
): FooterEntry {
  return { key: prKey(node), repo: node.repository.nameWithOwner, number: node.number, title: node.title, url: node.url, detail };
}

export function mergeMethodFor(pr: PullRequestNode, config: InboxConfig): MergeMethod {
  const configured = config.mergeMethods[pr.repository.nameWithOwner];
  if (configured) return configured;
  // The first the repository allows of squash, merge, rebase [PRS-04].
  if (pr.repository.squashMergeAllowed !== false) return "squash";
  if (pr.repository.mergeCommitAllowed) return "merge";
  return "rebase";
}

function prTarget(pr: PullRequestNode, stack: PullRequestNode[], config: InboxConfig): Target {
  return {
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
    stack: stack.map(prKey),
  };
}

// ---- Mentions [MEN-01..06] ----

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsMe(body: string | undefined, me: string): number {
  if (!body) return -1;
  // Ignore quoted replies; a team mention (@org/team) never matches a login [MEN-04].
  const text = body
    .split("\n")
    .map((line) => (line.trimStart().startsWith(">") ? "" : line))
    .join("\n");
  const match = new RegExp(`(^|[^\\w/@-])@${escapeRegExp(me)}(?![\\w/-])`, "i").exec(text);
  return match ? match.index + match[1].length : -1;
}

function snippetAround(body: string, index: number): string {
  const flat = body.replace(/\s+/g, " ");
  const at = body.slice(0, index).replace(/\s+/g, " ").length;
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + 60);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export function waitingMention(node: MentionNode, me: string): Mention | null {
  const isMe = (actor: Actor | null) => actor?.login.toLowerCase() === me;
  const opened: Comment = { author: node.author, body: node.body, createdAt: node.createdAt, url: node.url };
  const threads = node.reviewThreads?.nodes ?? [];
  const everything: Comment[] = [opened, ...node.comments.nodes, ...threads.flatMap((t) => t.comments.nodes)];
  const myLastAt = everything.filter((c) => isMe(c.author)).reduce((max, c) => (c.createdAt > max ? c.createdAt : max), EPOCH);

  // A bot counts only when it opened a thread I need to resolve [MEN-05].
  const botOpeners = new Set(threads.filter((t) => !t.isResolved).map((t) => t.comments.nodes[0]).filter(Boolean));

  const waiting = everything.filter((comment) => {
    if (!comment.author || isMe(comment.author)) return false;
    if (comment.author.__typename === "Bot" && !botOpeners.has(comment)) return false;
    if (mentionsMe(comment.body, me) < 0) return false;
    // Replying or reacting clears it [MEN-02].
    if (comment.reactionGroups?.some((group) => group.viewerHasReacted)) return false;
    return comment.createdAt > myLastAt;
  });
  if (waiting.length === 0) return null;
  waiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = waiting[waiting.length - 1];
  return {
    who: last.author!.login,
    since: waiting[0].createdAt,
    snippet: snippetAround(last.body ?? "", mentionsMe(last.body, me)),
    url: last.url ?? node.url,
    bot: waiting.every((comment) => comment.author!.__typename === "Bot"),
  };
}
