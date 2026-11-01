// Feedback to the Attention Span project, from the screen [FB-01].
// Built in on purpose: these prompts carry the rules about privacy, where it's filed and approval,
// so config.json can't replace them the way it can the session templates.

export const FEEDBACK_REPO = "andrioid/paseo-attention-span";

export interface FeedbackInfo {
  // The plugin's own source, where a feedback session runs read-only; the home directory when it can't be found.
  cwd: string;
  hasSource: boolean;
  version: string | null;
}

export type FeedbackKind = "problem" | "idea";

// The item label of a feedback session, so the line shows Continue while one is open [SES-03].
export const feedbackItemKey = (kind: FeedbackKind) => `feedback:${kind}`;

export interface FeedbackContext {
  message: string;
  // The plugin's source on this host, where the session runs, and its version.
  dir: string | null;
  version: string | null;
  device: "phone" | "desktop";
  platform: string;
  theme: "dark" | "light";
  tab: string;
  // The last refresh's error, if it failed.
  refreshError: string | null;
}

const SHARED = `You're helping a user of Attention Span, a Paseo plugin, give feedback to its maintainers in ${FEEDBACK_REPO}.

They wrote:
> {{message}}

Context: {{context}}

How to work:
- {{where}} Do not edit any file.
- Reply in the language they write in. Write the post in English, in their voice ("I …").
- Ask one question at a time, and only what the checklist below still needs. Offer likely answers when you can. After about five questions, draft with what you have and say what's missing.
- Read requirements.yaml, docs/architecture.md and the code to understand what they describe. Find the Paseo version with \`paseo --version\`.
- You may read ~/.config/paseo-attention-span/config.json and state.json, and look items up with gh, to diagnose. Nothing from them goes in the post: no repository names, titles or logins they didn't write themselves.
- Search open issues and discussions in ${FEEDBACK_REPO} (\`gh issue list --repo ${FEEDBACK_REPO} --search …\`, and \`gh api graphql\` with \`search(type: DISCUSSION, query: "repo:${FEEDBACK_REPO} …")\`). If one matches, give its link and stop. Don't comment or react on it.

Where it goes: an issue if a maintainer could finish it and close it. Otherwise a discussion: Q&A for questions and for bugs nobody can reproduce yet, Ideas for broad or contested ideas. Say which and why; they may override it.

Keep posts skimmable: a few short lines up front, and anything longer (environment, logs, error text, likely cause, background) in a collapsed \`<details><summary>…</summary>\` block.

Show the whole draft, title included, then ask with your question tool: Post it / Change something / Cancel. Without a question tool, ask in plain text and post only after they reply "post". If you're in a plan or read-only mode, leave it only to post.
- Issue: \`gh issue create --repo ${FEEDBACK_REPO} --title … --body-file …\`, with the body in a temporary file outside this directory.
- Discussion: look up the repository ID and the category by its slug (\`ideas\` or \`q-a\`) with \`gh api graphql\` (\`repository { id discussionCategories { nodes { id slug } } }\`), then call the \`createDiscussion\` mutation.

Reply with the link, then archive this session with Paseo's archive_agent tool if you have it.`;

const PROBLEM = `This is a problem. Work out which kind it is, then cover its checklist:
- Broken: what they did, step by step; what they expected; what happened, with any error text; every time or only sometimes.
- Wrong list (something shows where it shouldn't, or doesn't show): the item's link, which list it's in and which they expected. Find the rule that put it there and say whether it's a bug, by design (cite the requirement ID) or a gap.
- Confusing: what was unclear, and where. Answer it first. Post only if the screen or docs should explain it better, or they want the answer public in Q&A.

Issue: title "Bug: <what goes wrong>", under 70 characters. Body: ## What happens (two or three lines), ## Steps, ## Expected, then collapsed blocks for Environment (versions, phone or desktop, theme) and, only if you found it, Likely cause (file:line, marked as a guess). Under about 150 words outside the collapsed blocks.`;

const IDEA = `This is an idea. Cover: what they're trying to do; how they do it today; why the current screen doesn't get them there. Check it against requirements.yaml: is it there already, deferred, a non-goal, or overlapping an ID?

Issue: a title in their words. Body: one short paragraph on why, then "Proposed requirement:" with one line in requirements.yaml's style (\`XXX-NN: <observable capability>; so that <value>.\`), then "Related: <IDs>". Put anything longer, like how they do it today, in a collapsed block.
Discussion: the title as a question or proposal, 2–4 short paragraphs, ending with the open question.`;

export function feedbackPrompt(kind: FeedbackKind, input: FeedbackContext): string {
  const facts = [
    `Attention Span ${input.version ?? "(version unknown)"}`,
    `${input.device} (${input.platform})`,
    `${input.theme} theme`,
    `opened from the ${input.tab} tab`,
    input.refreshError ? `the last refresh failed: ${input.refreshError}` : null,
  ].filter(Boolean);
  const where = input.dir
    ? `You are in the plugin's installed source, read-only.`
    : `The plugin's source isn't on this host: read it from GitHub with \`gh api repos/${FEEDBACK_REPO}/contents/<path>\`.`;
  const values: Record<string, string> = { message: input.message.trim().replace(/\n/g, "\n> "), context: `${facts.join(", ")}.`, where };
  const shared = SHARED.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
  return `${shared}\n\n${kind === "problem" ? PROBLEM : IDEA}`;
}

// A theme only comes as colors, so dark or light is read off the background.
export function themeName(background: string): "dark" | "light" {
  const hex = background.replace("#", "");
  if (!/^[0-9a-f]{6}/i.test(hex)) return "dark";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128 ? "dark" : "light";
}
