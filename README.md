<img src="assets/icon.png" width="96" alt="">

# Attention Span

My work is spread across a pile of repositories, a queue of reviews and a handful of agents doing who-knows-what in their worktrees. Every time I went to GitHub to check what needed me, I came back twenty minutes later having read three unrelated threads and forgotten what I was doing. So I built this instead.

It's a [Paseo](https://paseo.sh) plugin that boils GitHub down to a short list of what actually needs you, says why, and starts an agent session when you want help with it.

![Doing](docs/screenshots/desktop-dark-doing.png)

- **Doing:** what needs you right now. Someone's waiting for a reply, a review, CI's red, something's ready to merge.
- **Waiting:** the ball's in someone else's court. You can stop thinking about it, at least until it's waited too long.
- **Next up:** for when your plate is actually clear. It happens. Occasionally.
- **History:** what you got done, for when someone asks and your mind goes blank.

I've tried not to assume much about how you use GitHub. Solo, a team that reviews everything, stacked PRs, issues first, open source: so far it copes with all of them. Tell me where it doesn't.

There's more in [OVERVIEW.md](OVERVIEW.md): each tab, what the buttons do, settings, and where your data goes.

## Install

```bash
paseo plugin add andrioid/attention-span
```

Then open Attention in the sidebar. If something's missing, like `gh` not being signed in, it'll tell you what and how to fix it.

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md), [requirements.yaml](requirements.yaml) and [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
