#!/bin/sh
# Starts a throwaway Paseo daemon with the plugin in fixture mode, then takes screenshots.
set -eu
HOME_DIR=/tmp/paseo-home
paseo() { /opt/paseo/resources/bin/paseo --home "$HOME_DIR" "$@"; }

mkdir -p "$HOME/.config/paseo-github-inbox"
cp /preview/plugin-config.json "$HOME/.config/paseo-github-inbox/config.json"

export PASEO_GITHUB_INBOX_FIXTURE=1
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
paseo plugin ls
node /preview/shoot.mjs "$@" || { tail -40 /tmp/daemon.log; exit 1; }
