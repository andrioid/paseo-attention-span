#!/bin/sh
# Refresh the screenshots in docs/screenshots/ from the isolated preview (fixture data).
set -eu
cd "$(dirname "$0")"
sh run.sh
rm -rf ../docs/screenshots && mkdir -p ../docs/screenshots
for name in desktop-dark-doing desktop-dark-doing-sheet desktop-dark-doing-acknowledge phone-dark-doing-sheet desktop-dark-doing-options desktop-dark-doing-merge-confirm desktop-dark-history-reviewed desktop-dark-waiting desktop-dark-next-up desktop-dark-next-up-code-repo desktop-light-doing phone-dark-doing phone-light-next-up-filtered; do
  cp "out/$name.png" "../docs/screenshots/$name.png"
done
ls -1 ../docs/screenshots
