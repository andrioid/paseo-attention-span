#!/bin/sh
# Starts a throwaway Paseo daemon with the plugin in fixture mode, then takes screenshots.
set -eu
HOME_DIR=/tmp/paseo-home
paseo() { /opt/paseo/resources/bin/paseo --home "$HOME_DIR" "$@"; }

mkdir -p "$HOME/.config/paseo-attention-span"
cp /preview/plugin-config.json "$HOME/.config/paseo-attention-span/config.json"

export PASEO_ATTENTION_SPAN_FIXTURE=1
# The daemon serves the web app itself; no relay, dictation or voice.
for setting in pluginsEnabled=true features.webUi.enabled=true features.dictation.enabled=false features.voiceMode.enabled=false; do
  /opt/paseo/resources/bin/paseo daemon config set --home "$HOME_DIR" "${setting%%=*}" "${setting#*=}" >/dev/null
done
paseo daemon run >/tmp/daemon.log 2>&1 &
for i in $(seq 1 90); do
  paseo daemon status --json 2>/dev/null | grep -q '"localDaemon": "running"' && break
  sleep 1
done
paseo daemon status --json | grep -q '"localDaemon": "running"' || { cat /tmp/daemon.log; exit 1; }
paseo plugin install /plugin >/dev/null

# A local repo with the fixture's GitHub remote, so sessions find a project, and a workspace on PR 102's branch.
git init -q -b main /tmp/shop
git -C /tmp/shop -c user.name=preview -c user.email=preview@example.com commit -q --allow-empty -m init
git -C /tmp/shop remote add origin https://github.com/acme/shop.git
git -C /tmp/shop branch branch-102
paseo project create /tmp/shop >/dev/null
paseo workspace create --path /tmp/shop --isolation worktree --mode checkout-branch --branch branch-102 --title "Retry webhooks" >/dev/null || echo "workspace setup failed"
paseo plugin ls
node /preview/shoot.mjs "$@" || { tail -40 /tmp/daemon.log; exit 1; }
