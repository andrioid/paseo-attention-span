// Made-up domain objects for tests: the shapes the server hands the screen, with defaults that don't matter to a test.
// GitHub's own shapes, as searches return them, are built by `builders` in server/fixture.ts.
import type { AgentSummary, FeedStatus, Item, NextUpIssue } from "./attention";
import type { OthersChange } from "./changes";
import { AttentionConfig } from "./config";

// Times relative to a test's fixed `now`.
export function clock(now: Date) {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return { now, hoursAgo, daysAgo: (days: number) => hoursAgo(days * 24) };
}

// An item keyed like GitHub's "owner/repo#number"; a bare key like "a" is a PR #1 in o/r.
export function item(key: string, section: Item["section"], fields: Partial<Item> = {}): Item {
  const [repo, number] = key.includes("#") ? [key.split("#")[0], Number(key.split("#")[1])] : ["o/r", 1];
  const url = `https://github.com/${repo}/pull/${number}`;
  return {
    key,
    section,
    kind: "pr",
    draft: false,
    repo,
    number,
    title: key,
    url,
    chips: [],
    actions: [],
    children: [],
    target: { kind: "pr", repo, number, title: key, url },
    othersActivityAt: "2026-10-01T00:00:00Z",
    ...fields,
  };
}

// A Next up issue keyed "owner/repo#number", found by no source of its own, on no known project, unless `fields` says otherwise.
export function issue(key: string, fields: Partial<NextUpIssue> = {}): NextUpIssue {
  const [repo, number] = [key.split("#")[0], Number(key.split("#")[1])];
  return { key, repo, number, title: key, url: `https://github.com/${repo}/issues/${number}`, createdAt: "2026-10-01T00:00:00Z", sources: [], openPrs: [], ...fields };
}

// A Paseo session on an item, idle and seen, unless `fields` says otherwise.
export function agent(id: string, itemKey: string, fields: Partial<AgentSummary> = {}): AgentSummary {
  return { id, itemKey, status: "idle", requiresAttention: false, title: null, workspaceId: null, lastActivityAt: null, ...fields };
}

// Something someone else did to my work [HIS-07].
export function change(kind: OthersChange["kind"], key: string, fields: Partial<OthersChange> = {}): OthersChange {
  return { id: `${kind}:${key}`, kind, subjectId: key, subject: "pr", key, repo: "acme/shop", number: 9, title: key, url: "u", actor: "dave", to: "carol", at: "2026-11-13T10:00:00Z", ...fields };
}

// A feed that refreshed fine, unless `fields` says otherwise.
export function feed(fields: Partial<FeedStatus> = {}): FeedStatus {
  return { fetchedAt: "2026-11-09T10:00:00Z", refreshing: false, error: null, ...fields };
}

// What buildView needs besides the lists.
export function viewMeta(fields: { config?: AttentionConfig; feed?: FeedStatus } = {}) {
  const status = fields.feed ?? feed();
  return { feeds: { live: status, history: status }, scopes: [], sources: [], projectFilter: [], historyFilter: [], config: fields.config ?? AttentionConfig.parse({}), pending: 0, newIssue: { repos: [] as string[], repo: null, profileId: null } };
}
