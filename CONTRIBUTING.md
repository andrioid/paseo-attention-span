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

Only when the owner asks: `paseo plugin install <path>`, or `paseo plugin reload github-attention` after changes.
