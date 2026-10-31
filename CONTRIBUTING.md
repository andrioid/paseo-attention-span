# Contributing

## Check

```bash
npm install
npm run check   # typecheck, tests, requirements check
```

Tests cite requirement IDs from [requirements.yaml](requirements.yaml) in their names. Cite the ID in code comments and commits too.

## Preview the screens

Agents: follow the `verify-plugin` skill in `.claude/skills/verify-plugin/`.

```bash
npm run preview            # every layout
npm run preview -- phone   # only names containing "phone"
```

`npm run screenshots` does the same, then copies a curated set into `docs/screenshots/`. Rerun it after visible UI changes, and commit the images.

This builds a Docker image and runs the plugin in a throwaway Paseo daemon that serves its own web app, then saves screenshots of every tab to `preview/out/`: desktop and phone width, dark and light.

It's isolated on purpose. Agents must never connect tooling to the Paseo daemon that runs them.
- The container gets only Paseo (mounted read-only from the host install), the plugin source (read-only) and the output folder. It has no `~/.paseo`, no `gh` login and no access to the host's loopback.
- The plugin runs in fixture mode (`PASEO_ATTENTION_SPAN_FIXTURE=1`) on the made-up data in `server/fixture.ts`, which shows every section. GitHub calls fail on purpose.
- It still needs internet access for GitHub avatar images.

The previews are react-native-web. Check the iOS and Android apps by hand now and then.

## Install on the daemon

Only when the owner asks: `paseo plugin install <path>`, or `paseo plugin reload attention-span` after changes.

To try the unreleased latest from `main` instead of the registry release: `paseo plugin add git:andrioid/paseo-attention-span`.

## Release

Run the Release workflow in GitHub Actions on `main` and pick patch or minor. It runs `npm run check`, publishes `@andrioid/paseo-attention-span` to npm with the next version after the latest `v*` tag, then pushes that tag and a GitHub Release with generated notes. It never commits, so `version` in `package.json` stays a placeholder.

The registry checks npm twice a day and updates the listing through its own review, so a release needs nothing else.

npm trusts the workflow through trusted publishing, so there is no npm token.

## Listing

The registry listing is [OVERVIEW.md](OVERVIEW.md) plus the `media` in `paseo-plugin.json`, which are screenshots from `docs/screenshots/`; the first is the card thumbnail. The registry reads them from the npm package, so every screenshot in `media` or the overview must also be listed in `files` in `package.json`. Keep the overview in step with what the plugin does. It must not contain install commands.

The logo is `assets/logo.svg`. `assets/icon.png` is the manifest's icon: the logo without its white background, 512 px. The sidebar uses a one-colour copy in `client/icons.ts`, so it follows the theme.
