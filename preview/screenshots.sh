#!/bin/sh
# Refresh the screenshots in docs/screenshots/ from the isolated preview (fixture data).
set -eu
cd "$(dirname "$0")"
sh run.sh
mkdir -p ../docs/screenshots
for name in desktop-dark-doing desktop-dark-doing-expanded desktop-dark-history desktop-dark-waiting desktop-dark-next-up desktop-light-doing phone-dark-doing phone-light-next-up; do
  cp "out/$name.png" "../docs/screenshots/$name.png"
done
ls -1 ../docs/screenshots
