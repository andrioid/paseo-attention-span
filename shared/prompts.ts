import { type ActionId, checkoutPr, ownStack, reviewAgain, type Target } from "./attention";
import type { AttentionConfig, SessionKind } from "./config";

// Built-in prompt templates [SES-04]. A template in config.json replaces one.
// Placeholders: {{repo}} {{number}} {{title}} {{url}} {{head}} {{base}} {{stack}} {{review}} {{context}}
// For Review of a stack, {{head}} is its top branch and {{review}} the PRs asking for my review.
const SWEEP = `Browser sweep, only if you're equipped to (you can run this repo's app and have browser tools): work out which pages and screens the change affects and check each one. If you can't, skip this and say so. Don't spend the session getting the app to run.`;

const STACK_INTRO = "Review the pull requests {{review}} in {{repo}}, part of the stack {{stack}} (bottom first). You are in a checkout of the top branch, {{head}}, which has every PR's changes.";
const STACK_DIFF = "for each of {{review}}, read its description (linked below) and its diff against its own base (`git diff origin/<base>...origin/<head>`, branches below).";
const AGAIN_STEP = "what changed since your last review, that is the commits after the one you reviewed, found as the context below says. Check whether each of your earlier comments was addressed.";
const AGAIN_REPORT = "Your earlier comments, each: addressed, partly, or not, with where.";

// The built-in Review prompt: what to review, the sweep, and what to report.
function reviewTemplate(intro: string, read: string, touched: string, each: string, again?: string): string {
  return `${intro}

1. Review: ${read}
2. Investigate: dig into anything risky or unclear in ${touched}.
3. ${SWEEP}
4. Report back${each}:
${again ? `   - ${again}\n` : ""}   - Findings, most important first.
   - Verdict: approve, request changes or comment, with a one-line reason.
   - Draft review comments, ready to paste, each with file:line.

Do not post anything to GitHub.

{{context}}`;
}

export const PROMPT_TEMPLATES: Record<SessionKind, string> = {
  review: reviewTemplate("Review pull request {{repo}}#{{number}}: \"{{title}}\" ({{url}}). You are in a checkout of the PR branch.", "read the description and the diff against {{base}}.", "the code it touches", ""),

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

// Review of a stack, while config.json doesn't replace the review template: one session for every PR asking for my review [ATT-04].
export const REVIEW_STACK_TEMPLATE = reviewTemplate(STACK_INTRO, `${STACK_DIFF} Review only those; the rest of the stack is context.`, "the code they touch", ", for each PR");

// Review asked for again after I reviewed, while config.json doesn't replace the review template: what changed since, and
// whether my earlier comments were taken up; the context says how to find it [REV-02].
export const REVIEW_AGAIN_TEMPLATE = reviewTemplate(
  "Review pull request {{repo}}#{{number}}: \"{{title}}\" ({{url}}) again. You reviewed it before, and review was asked for again. You are in a checkout of the PR branch.",
  `${AGAIN_STEP} For context, the PR's whole diff is against {{base}}.`,
  "the code the new commits touch",
  "",
  AGAIN_REPORT,
);
export const REVIEW_STACK_AGAIN_TEMPLATE = reviewTemplate(
  `${STACK_INTRO} You reviewed some of them before, and review was asked for again.`,
  `${AGAIN_STEP} For a PR you haven't reviewed before, ${STACK_DIFF.replace(/^for each of \{\{review\}\}, r/, "r")}`,
  "the code the new commits touch",
  ", for each PR",
  AGAIN_REPORT,
);

// What a Review session already open hears when review is asked for again: bring the checkout up to date, then the same
// look at what changed. Fixed text, not a config.json template [REV-02].
export const REVIEW_FOLLOW_UP = `Review was asked for again on {{review}} in {{repo}} since you last looked.

1. Update this checkout first. Run \`git status\`: if there are local changes, stop and ask me what to do with them. Otherwise run \`gh pr checkout {{checkout}} --force\`, which follows a force-push too.
2. Review: ${AGAIN_STEP}
3. Investigate: dig into anything risky or unclear in the code the new commits touch.
4. Report back{{each}}:
   - ${AGAIN_REPORT}
   - Findings, most important first.
   - Verdict: approve, request changes or comment, with a one-line reason.
   - Draft review comments, ready to paste, each with file:line.

Do not post anything to GitHub.

{{context}}`;

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
  const stack = target.stack ?? [];
  const reviewStack = kind === "review" && stack.length > 1;
  const again = kind === "review" && reviewAgain(target).length > 0;
  const builtIn = reviewStack ? (again ? REVIEW_STACK_AGAIN_TEMPLATE : REVIEW_STACK_TEMPLATE) : again ? REVIEW_AGAIN_TEMPLATE : PROMPT_TEMPLATES[kind];
  const template = config.prompts[kind] ?? builtIn;
  // Review reads the whole stack; the rest act on my PRs in it [ATT-04].
  const shown = kind === "review" ? stack : ownStack(target);
  const asking = stack.filter((pr) => pr.review);
  const numbers = (prs: { number: number }[], join: string) => (prs.length ? prs : [{ number: target.number }]).map((pr) => `#${pr.number}`).join(join);
  const values: Record<string, string> = {
    repo: target.repo,
    number: String(target.number),
    title: target.title,
    url: target.url,
    head: (reviewStack ? stack.at(-1)?.head : target.headRefName) ?? "",
    base: target.baseRefName ?? target.defaultBranch ?? "",
    stack: numbers(shown, " → "),
    review: numbers(asking.length ? asking : shown, ", "),
    context: context.trim(),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match).trim();
}

// The follow-up for a Review session already open, when review is asked for again [REV-02].
export function renderFollowUp(target: Target, context: string): string {
  const again = reviewAgain(target);
  const values: Record<string, string> = {
    repo: target.repo,
    review: (again.length ? again : [{ number: target.number }]).map((pr) => `#${pr.number}`).join(", "),
    checkout: String(checkoutPr("review", target).number),
    each: again.length > 1 ? ", for each PR" : "",
    context: context.trim(),
  };
  return REVIEW_FOLLOW_UP.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match).trim();
}
