# Architecture

How the inbox meets [requirements.yaml](../requirements.yaml). Requirement IDs in brackets.

## Pieces

```mermaid
flowchart LR
  subgraph Paseo app
    Screen[Inbox screen]
    Badge[Sidebar count]
  end
  subgraph Daemon host
    Server[Plugin server handlers]
    Files[(config.json<br/>state.json)]
    Paseo[Paseo SDK]
  end
  GitHub[(GitHub GraphQL)]
  Screen -- RPC --> Server
  Badge -- RPC --> Server
  Server -- host gh login --> GitHub
  Server --> Files
  Screen -- workspaces, agents --> Paseo
```

- **Paseo plugin**, installed per daemon.
  - Client: one screen and a sidebar header item. React Native primitives only, so it works on phone and desktop [REACH-01].
  - Server: RPC handlers for fetching and for GitHub actions.
- **GitHub access** goes through the host's existing `gh` login. The plugin stores no token [SEC-01].
- **Local files** live in `~/.config/paseo-github-inbox/`:
  - `config.json`: orgs and repos [SRC-01], profile per reason, thresholds. Edited by hand.
  - `state.json`: dismissals [ATT-08] and the last fetched result, so the inbox shows instantly after a restart [PRIV-01].

## Sections

Top to bottom. Each item appears once, under its most urgent reason [ATT-02].

| Section | Shows |
|---|---|
| Waiting for your reply | Open threads with a mention waiting on me [MEN-01] |
| Review requested | PRs requesting my review [REV-01] |
| CI failing | My PRs with failing checks [PRS-01] |
| Changes requested | My PRs with requested changes or unresolved threads [PRS-02] |
| Ready to merge | My approved, mergeable PRs [PRS-03] |
| Needs upstream | My PRs with conflicts or an out-of-sync stack [UPS-01, UPS-02] |
| My drafts | My drafts, with their own state tags [PRS-05, PRS-06] |
| Footer | Expandable counts: waiting on others, to do (assigned issues), done this week [ATT-10] |

Waiting on others stays in the footer until it exceeds a threshold, then appears as "Waiting too long" [ATT-11].

## Rules

- **One item per issue** [ATT-03]: PRs are grouped under the issues they close (`closingIssuesReferences`, works across repos). A PR without a linked issue is its own item.
- **One item per stack** [ATT-04]: a stack is followed through base/head branch names. Its section is decided by the bottom PR; the PRs above it are listed beneath.
- **Mentions** [MEN-01..06]: a thread counts when a person @-mentioned me after my last comment or reaction there. Team mentions are ignored. A bot counts only when it opened a thread I need to resolve, and is marked with 🤖.
- **Dismiss** [ATT-08] hides an item until its `updatedAt` changes.
- **Behind base** [UPS-07] only matters when:
  1. the PR conflicts with its base,
  2. a stacked PR no longer builds on its parent's head,
  3. it is ready to merge (CI ran against an old base).
  Otherwise the behind count is shown on rows that appear anyway, but never puts an item on the list by itself.
- **Stale draft** [PRS-07]: a draft untouched for 30 days offers Refresh and Close instead of Rebase.

## Actions

| Action | Shown when | Does |
|---|---|---|
| Reply ↗ | Mention waiting | Opens the comment on GitHub [ATT-12] |
| Review ▸ | Review requested | Session in a PR checkout using the review profile [SES-01] |
| Fix ▸ / Address ▸ | CI failing / changes requested | Session with the failing log or unresolved threads in the prompt [SES-04] |
| Update ▸ | Behind with no conflicts, not stacked | `updatePullRequestBranch` (rebase) [UPS-03] |
| Rebase ▸ / Refresh ▸ | Conflicts, any stacked PR, stale draft | Agent rebases the PR or whole stack with `gh-stack` [UPS-04]. A clean rebase is pushed with `--force-with-lease` [UPS-06]; after resolving conflicts it stops for my approval [UPS-05]. |
| Merge ▸ | Approved, CI green on current base | `mergePullRequest` [PRS-04] |
| Close ▸ | Stale draft | `closePullRequest`, with a comment only if I write one [SAFE-01] |

A tap starts with defaults. Expanding the row offers workspace, profile, and prompt [SES-02]. An existing workspace for the branch or PR is resumed instead of creating a new one [SES-03, ATT-07].

## Sessions

- **Repo to checkout** [SES-05]: match the PR's or issue's repository against the git remotes of registered Paseo projects. Repos without a project can only open GitHub.
- **Workspace**: a worktree with `checkout-pr` for PRs, or `branch-off` from the default branch for issues.
- **Profile**: looked up per reason in `config.json`, then materialised into `create_agent` from `list_profiles`.

## GitHub requests

Fewest requests practical [GH-01]. A refresh is two GraphQL requests.

1. **One query with search aliases**:
   - `is:pr is:open author:@me`
   - `is:pr is:open review-requested:@me`
   - `is:open mentions:@me updated:>=<30 days ago>` (fetching the description, recent comments, review-thread comments, and `viewerHasReacted`)
   - `is:issue is:open assignee:@me`
   - `is:pr is:merged author:@me merged:>=<monday>`

   Each is scoped to the configured orgs. A probe of this shape cost 16 of 5,000 points per hour.
2. **One batched `Ref.compare` query** for behind counts, only for stacked and ready-to-merge PRs.

Refresh happens when the screen opens, on ⟳, and every 5 minutes for the count [FRESH-01]: about 24 requests and 400 points an hour. Actions use GraphQL mutations. The only other call is fetching a failing CI log, and only when a Fix session starts.

## Open questions

- The "waiting too long" threshold [ATT-11]: one value, or one per reason?
- Default profile per reason. Needs at least a review profile and a default.
- Prompt template per session type [SES-04].
