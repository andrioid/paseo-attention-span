#!/bin/sh
# Build and run the isolated preview. Screenshots land in preview/out/.
# The container gets only Paseo (read-only), the plugin source (read-only) and the output folder:
# no ~/.paseo, no gh login, no host network.
set -eu
cd "$(dirname "$0")"
PASEO_APP=$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v paseo)")")")")
mkdir -p out && chmod 777 out && rm -f out/*.png out/*.txt out/manifest.json
# Taken before and after, so an edit made during the run doesn't pass for what was shot.
before=$(node fingerprint.mjs)
docker build -q -t attention-span-preview . >/dev/null
status=0
docker run --rm -v "$PASEO_APP":/opt/paseo:ro -v "$(cd .. && pwd)":/plugin:ro -v "$PWD/out":/out attention-span-preview "$@" || status=$?
# Only a finished full run can be copied into docs/screenshots/ (npm run screenshots).
if [ "$status" -eq 0 ] && [ "$#" -eq 0 ]; then
  if [ "$(node fingerprint.mjs)" = "$before" ]; then
    printf '{ "fingerprint": "%s", "finished": "%s" }\n' "$before" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >out/manifest.json
  else
    echo "The source changed during the run; run it again before npm run screenshots."
  fi
fi
exit "$status"
