#!/bin/sh
# Build and run the isolated preview. Screenshots land in preview/out/.
# Usage: run.sh [selection]: nothing for every shot, or what shots.mjs describes (`phone`, `doing-sheet`, `desktop-dark-doing-sheet`).
# Each layout runs in a container of its own, two at a time, so no layout's changes reach another. A container gets only
# Paseo (read-only), the plugin source (read-only) and the output folder: no ~/.paseo, no gh login, no host network.
set -eu
cd "$(dirname "$0")"
PASEO_APP=$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v paseo)")")")")
# An unknown name fails here, before anything is built or cleared.
layouts=$(node shots.mjs layouts "${1:-}")
mkdir -p out && chmod 777 out && rm -f out/*.png out/*.txt out/*.log out/manifest.json
# Taken before and after, so an edit made during the run doesn't pass for what was shot.
before=$(node fingerprint.mjs)
# A name of its own, apart from the older image that had a shooter built in, which worktrees on older branches still build.
# Every container runs the image this build made, by its id, even if another worktree retags the name meanwhile.
image=$(docker build -q -t attention-span-preview-base .)
started=$(date +%s)
# One layout per container. Its output goes to out/<layout>.log; its result lines are printed as it ends, with the
# daemon's log tail when it failed.
export PASEO_APP PLUGIN="$(cd .. && pwd)" OUT="$PWD/out" SELECTION="${1:-}" IMAGE="$image"
# shellcheck disable=SC2086
printf '%s\n' $layouts | xargs -P 2 -I{} sh -c '
  status=0
  docker run --rm -v "$PASEO_APP":/opt/paseo:ro -v "$PLUGIN":/plugin:ro -v "$OUT":/out "$IMAGE" "$SELECTION" {} >"$OUT/{}.log" 2>&1 || status=$?
  grep -E "^(ok|failed)" "$OUT/{}.log" || true
  if [ "$status" -ne 0 ]; then tail -40 "$OUT/{}.log" | sed "s/^/  {} | /"; touch "$OUT/{}.failed"; fi
' || true
status=0
for layout in $layouts; do if [ -e "out/$layout.failed" ]; then status=1; fi; done
rm -f out/*.failed
echo "preview took $(($(date +%s) - started))s; each layout's log is preview/out/<layout>.log"
# Only a finished full run can be copied into docs/screenshots/ (npm run screenshots).
if [ "$status" -eq 0 ] && [ -z "${1:-}" ]; then
  if [ "$(node fingerprint.mjs)" = "$before" ]; then
    printf '{ "fingerprint": "%s", "finished": "%s" }\n' "$before" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >out/manifest.json
  else
    echo "The source changed during the run; run it again before npm run screenshots."
  fi
fi
exit "$status"
