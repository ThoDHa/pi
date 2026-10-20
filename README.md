# pi

Configuration for the pi coding agent (`@earendil-works/pi-coding-agent`), deployed to `~/.pi/agent` by the dotfiles bootstrap.

This repository is whitelist-managed: everything is ignored by default, and only the entries listed in `.gitignore` are tracked. `auth.json` and `sessions/` must never be committed; the `pre-commit` hook enforces this as a second layer behind the whitelist.

Session transcripts live outside the repository, in the directory `PI_CODING_AGENT_SESSION_DIR` points to.

## Enabling the pre-commit guard

```sh
git config core.hooksPath .githooks
```

Fresh clones must run this once; the dotfiles bootstrap does it automatically.
