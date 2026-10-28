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
   | `<layout>-doing-expanded.png` | Doing with "Retry webhook deliveries with backoff" expanded (full quote, full stack, repo#number) |
   | `<layout>-doing-options.png` | The Options modal from "Address comments ▾" (a bottom sheet on phones): workspace, profile, prompt. Uncropped, since it covers the page |
   | `<layout>-doing-merge-confirm.png` | The Merge confirmation on "Dialog focus returns to the trigger" |
   | `<layout>-doing-dismissed.png` | After dismissing the first row: the "Dismissed … · Undo" row |
   | `<layout>-history.png` | History by week, with Reviewed toggles |
   | `<layout>-history-reviewed.png` | History with the newest Reviewed list open |
   | `<layout>-waiting.png` | Waiting sections and the "moved to Doing" hint |
   | `<layout>-next-up.png` | Assigned, then all of Unclaimed |
   | `<layout>-next-up-filtered.png` | Unclaimed filtered to the Backend scope |
   | `<layout>-next-up-code-repo.png` | Start on "Price list import skips quoted rows" (in `acme/issues`, no checkout): the picker asking where its code lives. Uncropped |
   | `<layout>-next-up-code-repo-after.png` | After picking `acme/shop`: the shooter has checked config.json gained the mapping; the start then fails with "No agent provider is ready", as expected in the container |
   | `<layout>-next-up-code-repo-again.png` | Start pressed again: no picker this time |

   Viewports are tall (desktop 1280×3000, phone 390×4200) because the plugin screen scrolls inside its own view; each shot is clipped to where the content ends. Look for:
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
| Opens `http://127.0.0.1:6767/` inside the container, clicks the "GitHub attention" sidebar entry, then each tab by its accessibility label | `preview/shoot.mjs` |
| Plugin config inside the container (fields for Next up) | `preview/plugin-config.json` |
| The fake GitHub data, plus fake sessions (`FIXTURE_AGENTS`) and session context | `server/fixture.ts` |
| A local repo with the `acme/shop` remote registered as a project, with a worktree workspace on `branch-102`, so Options has a project and a workspace to offer. `acme/issues` has no project on purpose | `preview/entrypoint.sh` |

- **Mounts:** Paseo from the host install, read-only (`readlink -f $(command -v paseo)`, three levels up). The repo, read-only. `preview/out`, writable.
- **Not available inside:** `~/.paseo`, `gh`, the host loopback. Relay is off. The only outside traffic is GitHub avatar images.
- **Fixture mode:** `PASEO_GITHUB_ATTENTION_FIXTURE=1` makes the server use `fixture()` instead of GitHub. `runGh` refuses to run, so Merge/Claim/Fix context fail on purpose. The shooter never presses them.

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
