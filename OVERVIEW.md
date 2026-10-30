Attention Span lists the GitHub issues and pull requests that are waiting on you, grouped by why they need you, and starts Paseo agent sessions to act on them. It is for when your attention is spread thin: a short list of what needs you now instead of a stream of notifications.

## What it shows

The screen has four tabs. A sidebar entry, Attention, shows how many items need you.

- **Doing:** what needs you, in sections: waiting for your reply, review requested, CI failing, changes requested, ready to merge, needs upstream, waiting too long, and your drafts. Each item appears once, under its most urgent reason. An issue and the pull requests that close it are one item, and so is a stack of pull requests.
- **Waiting:** your work where someone else has the next move.
- **Next up:** issues assigned to you, then open issues nobody has claimed, ranked by priority and effort when your org uses issue fields for them. Unclaimed issues come from the sources you choose (your own repositories, your organizations or single repositories), and can be filtered by source, or else from your Paseo projects' repositories.
- **History:** what you finished and reviewed in recent weeks.

A mention only counts while the person is still waiting for you; replying or reacting clears it. Mentions of your teams are left out. You can dismiss an item until something new happens on it.

## Setup

- The GitHub CLI, `gh`, must be installed and signed in on the machine that runs the Paseo daemon. The plugin uses that sign-in and stores no token of its own.
- To start sessions, the repositories need to be registered as Paseo projects, with their GitHub remote. Items in other repositories can still be opened on GitHub.
- Requires Paseo 0.13.0 or later. Tested on Linux.

When `gh` is missing or signed out, or `config.json` can't be read, the screen shows a setup checklist instead of the lists: what's missing, how to fix it, and a button to check again. It also says what the plugin covers, how many of your projects it can start sessions in, and which agent sessions will use.

It works without configuration: the lists about you cover everything on GitHub that involves you, and Next up looks for unclaimed issues in your Paseo projects' repositories.

To narrow it down, choose organizations and repositories under Settings, Plugins, Attention Span, or with the gear on the screen. Each one is checked on GitHub as you add it. Next up's unclaimed issues use them too, instead of your projects, unless you choose Next up's own sources there.

Everything else is set in `~/.config/paseo-attention-span/config.json` on the daemon host, which the settings screen also writes to:
- `profiles`: the Paseo agent profile per session type. Reviews use `review`, everything else `default`, and a missing profile falls back to Paseo's defaults.
- `prompts`: your own prompt template per session type, replacing the built-in one.
- `mergeMethods`: squash, merge or rebase per repository.
- `codeRepos`: where an issue repository's code lives, for issues kept apart from the code. The screen asks and fills this in when needed.
- `nextUp`: where to pick from (also in Settings), and the org issue fields for priority, effort and scope.
- `refreshMinutes` (15), `waitingTooLongDays` (3), `staleDraftDays` (30), `mentionDays` (30) and `historyWeeks` (4).

## Actions

Each item has a main action, and opening it shows every action with a line saying what it will do. An agent icon marks the actions that start an agent session; the rest change GitHub right away.

Agent sessions run in a worktree of the registered project, or resume the existing workspace for that branch:

- **Review** reviews a pull request and reports back. Nothing is posted.
- **Fix CI** and **Address comments** commit fixes without pushing.
- **Rebase** rebases a pull request or a whole stack. It pushes only when there were no conflicts.
- **Refresh draft** rebases a stale draft and says what it still needs.
- **Start** reads an issue and proposes a plan.

GitHub actions, which happen only when you tap them:

- Rerun failed jobs, update a branch, mark a draft ready for review, turn on auto-merge, merge, and close a draft. Merge and close ask first.
- React 👍 to the comments waiting on you, after reading them in full.
- Claim or unclaim an issue.

Where GitHub allows it, an Undo appears after an action.

## Data

- **GitHub:** the plugin reads your pull requests, review requests, mentions and issues through `gh`, scoped to the configured organizations and repositories. It refreshes every 15 minutes by default, using under 6% of GitHub's hourly API allowance.
- **Local files:** a cache of what it shows, your dismissals and your Next up filter are kept in `~/.config/paseo-attention-span/state.json` on the daemon host.
- **Agent providers:** when a session starts, the item's context goes into the agent's prompt. That includes descriptions, comments, review threads and failing CI logs. The prompt is sent to whichever provider the agent profile uses.

## Limits

- github.com only. Other forges and GitHub Enterprise are not supported yet.
- Apart from organizations and repositories, settings are edited by hand.
