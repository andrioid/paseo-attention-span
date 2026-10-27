import type { InboxConfig, SessionKind } from "./config";
import type { ActionId, Target } from "./inbox";

// Built-in prompt templates [SES-04]. A template in config.json replaces one.
// Placeholders: {{repo}} {{number}} {{title}} {{url}} {{head}} {{base}} {{stack}} {{context}}
export const PROMPT_TEMPLATES: Record<SessionKind, string> = {
  review: `Review pull request {{repo}}#{{number}}: "{{title}}" ({{url}}).

You are in a checkout of the PR branch. Read the description and the diff against {{base}}, then report correctness bugs, risky changes and missing tests, most important first. Do not post anything to GitHub.

{{context}}`,

  fix: `The checks on pull request {{repo}}#{{number}} "{{title}}" ({{url}}) are failing.

Find the cause and fix it on branch {{head}}. Run the relevant checks locally. Commit, but do not push: tell me what you changed and wait for me.

{{context}}`,

  address: `Pull request {{repo}}#{{number}} "{{title}}" ({{url}}) has requested changes or unresolved review comments.

Address each one on branch {{head}}. Commit, but do not push and do not reply on GitHub: summarise what you did for each comment and wait for me.

{{context}}`,

  rebase: `Bring pull request {{repo}}#{{number}} "{{title}}" ({{url}}) up to date with its base, {{base}}.

Stack, bottom first: {{stack}}

1. Fetch, then rebase. For a stack, check out the top branch and run \`git rebase --update-refs origin/{{base}}\` so every branch in the stack moves together.
2. If the rebase had no conflicts, push every rebased branch with \`git push --force-with-lease\` and tell me it's done.
3. If you resolved conflicts, do NOT push. Explain each resolution and wait. Push with \`--force-with-lease\` only after I reply "push".

{{context}}`,

  refresh: `Draft pull request {{repo}}#{{number}} "{{title}}" ({{url}}) has gone stale.

Stack, bottom first: {{stack}}

Rebase it onto the latest {{base}} the same way as any update: \`git rebase --update-refs\` for a stack. If there were no conflicts, push with \`git push --force-with-lease\`. If you resolved conflicts, do NOT push: explain each resolution and wait until I reply "push". Then tell me briefly what the draft still needs.

{{context}}`,

  start: `Start work on issue {{repo}}#{{number}} "{{title}}" ({{url}}).

Read the issue and the code it touches, then propose a plan before changing anything.

{{context}}`,
};

export const ACTION_SESSION: Partial<Record<ActionId, SessionKind>> = {
  review: "review",
  fix: "fix",
  address: "address",
  rebase: "rebase",
  refresh: "refresh",
  start: "start",
};

export function renderPrompt(
  kind: SessionKind,
  target: Target,
  context: string,
  config: Pick<InboxConfig, "prompts">,
): string {
  const template = config.prompts[kind] ?? PROMPT_TEMPLATES[kind];
  const values: Record<string, string> = {
    repo: target.repo,
    number: String(target.number),
    title: target.title,
    url: target.url,
    head: target.headRefName ?? "",
    base: target.baseRefName ?? target.defaultBranch ?? "",
    stack: (target.stack ?? [{ number: target.number }]).map((pr) => `#${pr.number}`).join(" → "),
    context: context.trim(),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match).trim();
}
