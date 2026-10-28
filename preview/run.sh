#!/bin/sh
# Build and run the isolated preview. Screenshots land in preview/out/.
# The container gets only Paseo (read-only), the plugin source (read-only) and the output folder:
# no ~/.paseo, no gh login, no host network.
set -eu
cd "$(dirname "$0")"
PASEO_APP=$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v paseo)")")")")
mkdir -p out && chmod 777 out && rm -f out/*.png
docker build -q -t attention-span-preview . >/dev/null
docker run --rm -v "$PASEO_APP":/opt/paseo:ro -v "$(cd .. && pwd)":/plugin:ro -v "$PWD/out":/out attention-span-preview "$@"
