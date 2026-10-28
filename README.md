# Attention Span

For when your attention is spread thin. A [Paseo](https://paseo.sh) plugin that lists the GitHub issues and pull requests waiting on you, grouped by why, and starts agent sessions to act on them.

![Doing](docs/screenshots/desktop-dark-doing.png)

[OVERVIEW.md](OVERVIEW.md) explains what it shows, its actions, its settings and where data goes.

## Install

```bash
paseo plugin install git:andrioid/paseo-attention-span
```

Then:

- Sign in to the GitHub CLI on the daemon host: `gh auth login`.
- Register the repositories you work in as Paseo projects, so items can start sessions.
- Optionally, narrow it down in `~/.config/paseo-attention-span/config.json`, for example:

  ```json
  { "orgs": ["acme"], "repos": ["someone/tool"] }
  ```

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md), [requirements.yaml](requirements.yaml) and [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
