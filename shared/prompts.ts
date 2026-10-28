import type { ActionId, Target } from "./attention";
import type { AttentionConfig, SessionKind } from "./config";

// Built-in prompt templates [SES-04]. A template in config.json replaces one.
// Placeholders: {{repo}} {{number}} {{title}} {{url}} {{head}} {{base}} {{stack}} {{context}}
export const PROMPT_TEMPLATES: Record<SessionKind, string> = {
  review: `Review pull request {{repo}}#{{number}}: "{{title}}" ({{url}}). You are in a checkout of the PR branch.

1. Review: read the description and the diff against {{base}}.
2. Investigate: dig into anything risky or unclear in the code it touches.
3. Browser sweep, only if you're equipped to (you can run this repo's app and have browser tools): work out which pages and screens the change affects and check each one. If you can't, skip this and say so. Don't spend the session getting the app to run.
4. Report back:
   - Findings, most important first.
   - Verdict: approve, request changes or comment, with a one-line reason.
   - Draft review comments, ready to paste, each with file:line.

Do not post anything to GitHub.

{{context}}`,

  fix: `The checks on pull request {{repo}}#{{number}} "{{title}}" ({{url}}) are failing.

Find the cause and fix it on branch {{head}}. Run the relevant checks locally. Commit, but do not push: tell me what you changed and wait for me.

{{context}}`,

  address: `Pull request {{repo}}#{{number}} "{{title}}" ({{url}}) has review comments. You are on branch {{head}}.

Evaluate each comment: is it right, and what would fixing it take?
- If the fix is trivial, apply it. Trivial means no behavior change: typos, naming, comments, formatting, or a small refactor the reviewer spelled out. Commit, but don't push.
- Anything that changes behavior or needs a judgment call: don't apply it.

Then report back on every comment: what you changed, and for the rest, your evaluation and what you propose. Do not reply on GitHub.

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
  config: Pick<AttentionConfig, "prompts">,
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
