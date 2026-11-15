// A new issue in a repository I cover, drafted by an agent in my checkout from a line or two in a sheet [ISS-01, ISS-02].
// Built in, like feedback's prompts, because it carries the approval rules [SAFE-01].

import type { AttentionConfig } from "./config";
import { APPROVE, askUntilClear, fill, quote, SKIMMABLE } from "./drafting";

// The item label of a new issue session, by repository.
export const newIssueItemKey = (repo: string) => `new-issue:${repo.toLowerCase()}`;
// Tagged, so a session can tell itself apart from another draft for the same repository when it archives itself.
export const newIssueTitle = (repo: string, tag: string) => `New issue: ${repo} (${tag})`;
export const newIssueTag = () => Math.random().toString(36).slice(2, 7);

// What the sheet starts from: the choices remembered from last time, and the repositories it offers [ISS-01].
export interface NewIssueInfo {
  repos: string[];
  repo: string | null;
  profileId: string | null;
}

const owner = (repo: string) => repo.split("/")[0].toLowerCase();

// The repositories Attention Span covers: the ones chosen, and those of my Paseo projects and of the items it shows that fall
// under a chosen org or my own account. With nothing chosen it covers everything involving me, so all of them [ISS-01].
export function newIssueRepos(
  config: Pick<AttentionConfig, "orgs" | "repos" | "nextUp">,
  projectRepos: string[],
  shownRepos: string[],
  login: string | null,
): string[] {
  const { orgs, repos, nextUp } = config;
  const chosen = [...repos, ...nextUp.repos];
  const owners = new Set([...orgs, ...nextUp.orgs, ...(nextUp.mine && login ? [login] : [])].map((name) => name.toLowerCase()));
  const nothingChosen = chosen.length === 0 && owners.size === 0 && !nextUp.mine;
  const known = [...projectRepos, ...shownRepos].filter((repo) => nothingChosen || owners.has(owner(repo)));
  // The items shown are covered by definition, whichever rule found them.
  const all = [...chosen, ...known, ...shownRepos].filter((repo) => /^[^/\s]+\/[^/\s]+$/.test(repo));
  // Spelled as I chose it, where I did.
  const unique = new Map<string, string>();
  for (const repo of all) if (!unique.has(repo.toLowerCase())) unique.set(repo.toLowerCase(), repo);
  return [...unique.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const find = (repos: string[], repo: string | null | undefined) => (repo ? repos.find((other) => other.toLowerCase() === repo.toLowerCase()) : undefined);

// The repository the sheet starts on: the one of the workspace I came from, else the one Next up is narrowed to, else the
// one I filed in last, else the only one there is [ISS-01].
export function prefillRepo(repos: string[], from: { workspace?: string | null; nextUp?: string | null; last?: string | null }): string | null {
  return find(repos, from.workspace) ?? find(repos, from.nextUp) ?? find(repos, from.last) ?? (repos.length === 1 ? repos[0] : null);
}

export interface SessionMessage {
  from: "me" | "agent";
  text: string;
}

// What the session I came from was doing, when I let it come along [ISS-01].
export interface SourceSession {
  title: string | null;
  workspace: string | null;
  branch: string | null;
  messages: SessionMessage[];
}

const MESSAGES = 4;
const MESSAGE_CHARS = 800;

// The last few things said in a session, each cut short, from its timeline entries.
export function lastMessages(entries: { item: { type: string; text?: string } }[], count = MESSAGES): SessionMessage[] {
  return entries
    .flatMap(({ item }): SessionMessage[] => {
      const text = item.text?.trim();
      if (!text || (item.type !== "user_message" && item.type !== "assistant_message")) return [];
      return [{ from: item.type === "user_message" ? "me" : "agent", text: text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS).trimEnd()}…` : text }];
    })
    .slice(-count);
}

export interface NewIssueInput {
  message: string;
  repo: string;
  // My checkout the agent runs in, which may hold another repository's code [SES-07].
  dir: string;
  codeRepo: string;
  source: SourceSession | null;
  // The session's own title, which it finds itself by.
  title: string;
}

const PROMPT = `You're helping me file an issue in {{repo}} on GitHub.

I wrote:
> {{message}}
{{source}}
How to work:
- {{where}} Read the code to ground the issue, citing files as path:line, but change nothing: no edits, commits, branches or pushes. Put the body and any other scratch files in a temporary directory outside the checkout (\`mktemp -d\`).
- Reply in the language I write in. Write the issue in the language {{repo}}'s issues are written in, in my voice ("I …").
- ${askUntilClear("a maintainer acting on the issue")}
- Before drafting, search open issues for the same thing with a few phrasings (\`gh issue list --repo {{repo}} --state open --search "…"\`). If one looks like a duplicate, give its link and ask with your question tool: File anyway / Comment there instead / Cancel. A comment is a post too: draft it and get my approval the same way.
- Follow {{repo}}'s issue templates if it has any ({{templates}}): pick the one that fits and keep its headings, turning a form (.yml) into markdown with its fields as headings. Without a template: ${SKIMMABLE}
- Pick labels only from the ones {{repo}} has (\`gh label list --repo {{repo}}\`), and an issue type only if it has types (\`gh api graphql\` with \`repository(owner, name) { issueTypes(first: 25) { nodes { id name } } }\`). Leave out whatever doesn't clearly fit. Don't assign anyone or add it to a project.

${APPROVE}
- Issue: \`gh issue create --repo {{repo}} --title … --body-file … --label …\`, then set the type you chose with the \`updateIssueIssueType\` mutation (\`gh api graphql\`).
- Comment: \`gh issue comment <number> --repo {{repo}} --body-file …\`.

Reply with the link, then close this session: archive this agent with Paseo's archive_agent tool. Find its ID with list_agents: the one agent titled exactly "{{title}}". If no agent or more than one has that title, archive nothing. Archive only the agent, never the workspace: it's my checkout. Without that tool, or when you can't tell which agent you are, say it's done and stop.`;

function sourceText(source: SourceSession | null): string {
  if (!source) return "";
  const where = [source.title ? `the Paseo session "${source.title}"` : "a Paseo session", source.workspace ? `in ${source.workspace}` : null, source.branch ? `on branch ${source.branch}` : null]
    .filter(Boolean)
    .join(" ");
  const said = source.messages.map((message) => `> **${message.from === "me" ? "Me" : "Agent"}:** ${quote(message.text)}`).join("\n>\n");
  const messages = said ? ` Its last messages, which may be about more than this issue:\n\n${said}\n` : "\n";
  return `\nI started this from ${where}.${messages}Use only what the issue needs from it, and nothing private.\n`;
}

export function newIssuePrompt(input: NewIssueInput): string {
  const where =
    input.codeRepo.toLowerCase() === input.repo.toLowerCase()
      ? `You are in my checkout of ${input.repo} at ${input.dir}.`
      : `You are in my checkout of ${input.codeRepo} at ${input.dir}, where ${input.repo}'s code lives; the issue goes to ${input.repo}.`;
  // The checkout holds the code repository's templates, which aren't the issues' when the two are apart [SES-07].
  const templates =
    input.codeRepo.toLowerCase() === input.repo.toLowerCase()
      ? `\`.github/ISSUE_TEMPLATE/\` in the checkout; if it's not there, \`gh api repos/${input.repo}/contents/.github/ISSUE_TEMPLATE\``
      : `\`gh api repos/${input.repo}/contents/.github/ISSUE_TEMPLATE\`; not the checkout's, which are ${input.codeRepo}'s`;
  return fill(PROMPT, { repo: input.repo, message: quote(input.message), source: sourceText(input.source), where, templates, title: input.title });
}
