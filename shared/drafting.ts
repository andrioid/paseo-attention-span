// What every post an agent drafts for me has in common, for feedback and new issues alike [FB-01, ISS-01]:
// ask until it's clear, keep it skimmable, and post nothing until I approve the whole draft [SAFE-01].

// One question at a time, only what `needs` still lacks, and a draft after about five either way.
export const askUntilClear = (needs: string) =>
  `Ask one question at a time, and only what ${needs} still needs. Offer likely answers when you can. After about five questions, draft with what you have and say what's missing.`;

export const SKIMMABLE =
  "Keep posts skimmable: a few short lines up front, and anything longer (environment, logs, error text, likely cause, background) in a collapsed `<details><summary>…</summary>` block.";

export const APPROVE =
  'Show the whole draft, title included, then ask with your question tool: Post it / Change something / Cancel. Without a question tool, ask in plain text and post only after they reply "post".';

// Their own words, quoted, so the agent's first message is already a follow-up.
export const quote = (message: string) => message.trim().replace(/\n/g, "\n> ");

export const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
