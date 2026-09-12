#!/usr/bin/env bash
set -euo pipefail

: "${RENDER_OPERATOR_URL:?Set RENDER_OPERATOR_URL to your deployed Render operator URL}"

url="${RENDER_OPERATOR_URL%/}/health?keepalive=$(date +%s)"

printf '[keepalive] GET %s\n' "$url"
curl --fail --silent --show-error --location \
  --connect-timeout 10 \
  --max-time 30 \
  -H 'Cache-Control: no-cache' \
  -H 'Pragma: no-cache' \
  "$url"
printf '\n[keepalive] Render operator is reachable\n'
