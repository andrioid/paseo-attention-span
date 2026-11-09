---
name: verify-plugin
description: Verify this Paseo plugin end to end in an isolated Docker preview. Typecheck and test, run the plugin in a throwaway Paseo daemon on fixture data, and read screenshots of every tab at desktop and phone width in dark and light themes. Use after changing UI, the classifier, fixture data or anything the screen shows, and before asking the user to look. Never use the user's own Paseo daemon for this.
---

# Verify the plugin

## Ground rule

Never connect a browser, SDK client or script to the Paseo daemon that runs you (`~/.paseo`, `127.0.0.1:6767` on the host). The user forbids it: "I don't want the agent accessing what controls the agent." The preview below runs its own daemon in a container. Installing or reloading the plugin on the user's daemon happens only when they ask, and only through `paseo plugin install`/`reload`.

## Steps

1. **Check:**
   ```bash
   npm run check   # typecheck, tests, requirements check
   ```
   Fix failures first. The preview compiles the same source, and type errors show up there as load failures.

2. **Preview:**
   ```bash
   npm run preview              # all four layouts, about 1–2 minutes
   npm run preview -- phone     # only names containing "phone" (or "desktop", "dark", "light", "desktop-dark", …)
   ```
   - `preview/run.sh` builds the image (cached after the first time), clears `preview/out/`, and runs the container.
   - It prints `ok <layout>` or `failed <layout>: <reason>` for each layout.
   - On failure it saves `<layout>-failure.png` and prints the container daemon's log tail.

3. **Read the screenshots** in `preview/out/` with the Read tool. Each layout is `{desktop,phone}-{dark,light}`, and each gives you:

   | File | Shows |
   |---|---|
   | `<layout>-doing.png` | Doing tab, every section |
   | `<layout>-doing-sheet.png` | The sheet of "Show delivery dates on the order page" (a bottom sheet on phones): what the card knows, then Fix CI as its running session with a "working" badge, Rerun failed jobs with the made-up failing checks, a muted "Start another session…", then the fetched size |
   | `<layout>-doing-issue-sheet.png` | The sheet of the issue "Supplier prices are a week out of date": its stack of PRs, each with a GitHub icon and opening that PR, then "Continue session" (no kind, needs you) first, Rebase stack as its working session, Open issue on GitHub |
   | `<layout>-doing-stack-issue-sheet.png` | The sheet of the issue "The calendar can't be used with a keyboard": the a11y stack (#105–#107) that GitHub links to no issue, grouped under it because its bottom PR says "for #132" and its top PR "Closes #132" |
   | `<layout>-doing-review.png` | Review requested: the "Price rules" stack as one item with "stack of 2" and "agent idle", and "Add a status page" with an "agent working" chip and Open session, from a session started outside Attention Span [SES-08]. Each shows its author as "✏️ bob", without a time [ATT-19] |
   | `<layout>-doing-review-sheet.png` | The sheet of "Add a status page": "Continue session" (no kind, working) first, then Review… still offered, Open PR on GitHub, a muted "Start another session…" |
   | `<layout>-doing-review-stack-sheet.png` | The sheet of "Price rules: data model", bob's stack of two (#196, #197) asking for my review, one item [ATT-04]: #197 beneath it, "Continue session" (idle) for the session started on #197, then Review stack… for #196 and #197 |
   | `<layout>-doing-acknowledge.png` | The 👍 picker from "Publish security.txt": two waiting comments in full, rendered as Markdown, both ticked |
   | `<layout>-doing-needs-reviewer.png` | The Needs a reviewer section: "Export invoices as CSV" with Request review and Merge in its sheet, "Log slow database queries" with a CI running chip |
   | `<layout>-doing-ready.png` | The Ready to merge section: "Lazy-load product images" with an "optional checks failing" chip and "Compress API responses" with "required checks passed", both offering Merge [PRS-14]. "Sign the release artifacts" isn't here: it waits in Waiting for review with "blocked by repo rules" and no person [PRS-13] |
   | `<layout>-doing-reviewers.png` | The reviewer picker from "Export invoices as CSV" (Needs a reviewer): Suggested by GitHub (carol, ticked), Recent on your PRs here, Teams, the login field, Request 1 reviewer |
   | `<layout>-doing-options.png` | The Options modal from "Address comments…" in the sheet of "Harden the upload endpoint": workspace, profile, prompt |
   | `<layout>-doing-merge-confirm.png` | The Merge confirmation on the first Ready card, the a11y stack's |
   | `<layout>-doing-dismissed.png` | After dismissing the first row: the "Dismissed … · Undo" row |
   | `<layout>-history.png` | History by week, with Reviewed toggles |
   | `<layout>-history-reviewed.png` | History with the newest Reviewed list open |
   | `<layout>-waiting.png` | Waiting by who it waits on, whoever blocks the most first: alice and bob (three each), acme/frontend (its too-long PR, flagged "waited too long"), then "Not on a person" last. In each group "Upgrade the payment SDK" (agent working) leads. Each heading has Copy list (icon-only on phones). Cards say why and how long ("re-review · 1d"); work on several people is under each with "also waiting on …". Each card shows the GitHub button instead of ›, its sheet's only action besides the muted start line, except "Upgrade the payment SDK" (its agent is working, so Open session and ›) and the too-long ones (their sheet also has Dismiss) |
   | `<layout>-waiting-copied.png` | After Copy list on alice: the "Copied 3 links for alice" toast. `<layout>-waiting-clipboard.txt` holds what was copied |
   | `<layout>-waiting-sheet.png` | The sheet of "Invoice totals round wrong": alice and bob by name |
   | `<layout>-next-up.png` | Assigned, then all of Unclaimed. Cards: a tinted type badge, "acme/shop #160 · 40d old" (my own `me/tool` shows as "tool #165"), tags (P0 Urgent warm, P1 High accent), "PR by alice" on #161 |
   | `<layout>-next-up-sheet.png` | The sheet of "Orders export times out for big shops": "Continue session" with an "idle" badge, Unclaim, Open issue on GitHub, a muted "Start another session…", Close issue |
   | `<layout>-next-up-close.png` | Close issue on "Merge the two import commands": the confirm bar with a comment field, Completed, Not planned, Cancel |
   | `<layout>-next-up-filter.png` | The Filter sheet: Source (My repos, acme) and Scope checkboxes, Backend ticked |
   | `<layout>-next-up-filtered.png` | Unclaimed filtered to the Backend scope; the button reads "Filter · 1" |
   | `<layout>-next-up-source.png` | Unclaimed filtered to the My repos source: only "Devcontainers for pull requests" |
   | `<layout>-next-up-code-repo.png` | Start on "Price list import skips quoted rows" (in `acme/issues`, no checkout): the picker asking where its code lives |
   | `<layout>-next-up-code-repo-after.png` | After picking `acme/shop`: the shooter has checked config.json gained the mapping; the start then fails with "No agent provider is ready", as expected in the container |
   | `<layout>-next-up-code-repo-again.png` | Start pressed again: no picker this time |
   | `<layout>-settings-typo.png` | The settings screen from the gear, after adding `acme/shpo`: "wasn't found on GitHub" |
   | `<layout>-settings.png` | After adding `acme/web`: the shooter has checked config.json kept `orgs` and `nextUp` |
   | `<layout>-settings-next-up.png` | The Next up section after adding `me/tool`: My repos on, `acme`, `me/tool` |
   | `<layout>-settings-org-picker.png` | The org picker open, offering only `globex` (`acme` is already added) |
   | `<layout>-settings-fields.png` | Next up fields: Priority and Scope "Picked by its name" (the preview config names only Effort), Effort as config.json has it |
   | `<layout>-settings-fields-picked.png` | After setting Scope to Team: the shooter has checked config.json saved only that, leaving Priority out (still found by its name) and Effort's `order` kept |
   | `<layout>-setup.png` | The setup checklist, from a `config.json` that doesn't parse. The shooter restores it and presses Check again |

   Viewports are tall (desktop 1280×3000, phone 390×4200) because the plugin screen scrolls inside its own view; each shot is clipped to where the content ends. Sheets and modals are clipped to a band around the dialog, so their thumbnails stay readable. Faces on cards and in sheets carry an icon tight against the picture saying what they are: ⌛ someone I wait on, ✏️ who opened it, the Changes requested icon for a review bot's comments. Quotes have none [ATT-19]. Look for:
   - text that's unreadable in either theme
   - chips or buttons that overflow on the phone
   - missing icons (an unknown icon renders nothing)
   - wrong sections or counts
   - anything that differs from what the change intended

4. **Refresh the docs screenshots** after visible UI changes: `npm run screenshots` copies a curated set into `docs/screenshots/`. Commit them with the change.
5. **Report** what you looked at and what you saw. Say plainly that native iOS/Android wasn't covered.

## How it works

| Piece | Where |
|---|---|
| Image: Node 24, Chromium, `playwright-core` | `preview/Dockerfile` |
| Starts a daemon with `--home /tmp/paseo-home`, sets `pluginsEnabled`, `features.webUi.enabled` (the daemon serves the web app itself), dictation and voice off, then installs `/plugin` and runs the shooter | `preview/entrypoint.sh` |
| Opens `http://127.0.0.1:6767/` inside the container, clicks the "Attention" sidebar entry, then each tab by its accessibility label | `preview/shoot.mjs` |
| Plugin config inside the container (Next up sources, and Effort with its own order) | `preview/plugin-config.json` |
| The fake GitHub data, plus fake sessions (`FIXTURE_AGENTS`), session context and sheet details (`fixtureDetails`) | `server/fixture.ts` |
| A local repo with the `acme/shop` remote registered as a project, with a worktree workspace on `branch-102`, so Options has a project and a workspace to offer. `acme/issues` has no project on purpose | `preview/entrypoint.sh` |

- **Mounts:** Paseo from the host install, read-only (`readlink -f $(command -v paseo)`, three levels up). The repo, read-only. `preview/out`, writable.
- **Not available inside:** `~/.paseo`, `gh`, the host loopback. Relay is off. The only outside traffic is GitHub avatar images.
- **Fixture mode:** `PASEO_ATTENTION_SPAN_FIXTURE=1` makes the server use `fixture()` instead of GitHub. `runGh` refuses to run, so Merge/Claim/Fix context fail on purpose. The shooter never presses them.

## Keeping it useful

- **New screen states:** when you add a section, chip, action or row state, add a case to `fixture()` in `server/fixture.ts` so the preview shows it. Session states come from `FIXTURE_AGENTS`. The test "covers every section with the preview fixture" in `server/classify.test.ts` counts the sections; update its number.
- **New interactions:** to screenshot one (a modal, Options, a confirm bar), add a step to `shoot.mjs` after the tab loop. Find elements by visible text or accessibility label, and only press things that don't call GitHub.
- **Tabs on phones are icon-only,** so the shooter finds them by `accessibilityLabel` ("Doing, 11"). Keep that label on the `Tab` component.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `failed …: locator.click: Timeout` on the sidebar entry | The plugin didn't load. The log tail shows `[paseo]` errors: compile errors, imports across `client/`/`server/`. The image rebuilds automatically; plugin source is mounted, not copied. |
| The connect screen ("Welcome to Paseo") instead of the app | `features.webUi.enabled` didn't apply. Check `entrypoint.sh`. Don't fall back to `app.paseo.sh`. |
| "Rejected connection from origin" in the log | Something loaded the app from another origin. Use the daemon-served UI. |
| Daemon never reports `running` | Paseo's version changed and its Electron binary needs a library missing from the image. Add it to the `apt-get install` line. |
| Screens show old code | Nothing is cached between runs except the image; check that you saved the files. |
