#!/bin/sh
# Copy a curated set of the last full preview's screenshots into docs/screenshots/.
# Refuses unless preview/out/ holds a finished full run of the current source: run npm run preview first.
set -eu
cd "$(dirname "$0")"
names="desktop-dark-doing desktop-dark-doing-wrap desktop-dark-doing-wrap-dirty desktop-dark-doing-wrap-multi desktop-dark-doing-clear desktop-dark-next-up-setup desktop-dark-doing-sheet desktop-dark-doing-issue-sheet desktop-dark-doing-acknowledge desktop-dark-doing-reviewers phone-dark-doing-issue-sheet phone-dark-doing-sheet desktop-dark-doing-options desktop-dark-doing-merge-confirm desktop-dark-history desktop-dark-history-filtered desktop-dark-history-groups phone-dark-history desktop-dark-waiting desktop-dark-waiting-too-long desktop-dark-next-up desktop-dark-next-up-filter-projects desktop-dark-next-up-sheet desktop-dark-next-up-code-repo desktop-light-doing phone-dark-doing phone-light-next-up-filtered desktop-dark-setup desktop-dark-settings phone-light-settings-typo"
# shellcheck disable=SC2086
node fingerprint.mjs check $names
rm -rf ../docs/screenshots && mkdir -p ../docs/screenshots
for name in $names; do
  cp "out/$name.png" "../docs/screenshots/$name.png"
done
ls -1 ../docs/screenshots
