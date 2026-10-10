#!/usr/bin/env bash
# Onboard a branch onto the Operator: create (or reuse) its WhatsApp account and
# point the account's concierge webhook binding at this service.
#
# Safe to re-run: the Operator upserts bindings on (account, appId, tenantId).
#
# Usage:
#   OPERATOR_BASE_URL=https://my-own-whatsapp-2z5h.onrender.com \
#   OPERATOR_API_KEY=... \
#   CONCIERGE_PUBLIC_URL=https://nahalabs-restaurant-concierge.onrender.com \
#   ./scripts/onboard-branch.sh <tenantId> [label]
#
# Then: pair the branch phone with the printed QR steps, and paste the returned
# waAccountId into branches/<branch>.json ("waAccountId": "...") before flipping
# mode to "live".
set -euo pipefail

TENANT_ID="${1:?usage: onboard-branch.sh <tenantId> [label]}"
LABEL="${2:-concierge-$TENANT_ID}"
APP_ID="${APP_ID:-restaurant-concierge}"

: "${OPERATOR_BASE_URL:?set OPERATOR_BASE_URL}"
: "${OPERATOR_API_KEY:?set OPERATOR_API_KEY}"
: "${CONCIERGE_PUBLIC_URL:?set CONCIERGE_PUBLIC_URL}"

curl -fsS -X POST "$OPERATOR_BASE_URL/accounts/bootstrap" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $OPERATOR_API_KEY" \
  -d "{
    \"label\": \"$LABEL\",
    \"appId\": \"$APP_ID\",
    \"tenantId\": \"$TENANT_ID\",
    \"webhookUrl\": \"$CONCIERGE_PUBLIC_URL/webhooks/operator\"
  }" | tee /tmp/concierge-bootstrap.json

echo
echo "Next steps:"
echo "1. Copy waAccountId from above into branches/<branch>.json"
echo "2. Pair the branch phone: GET $OPERATOR_BASE_URL/accounts/<waAccountId>/qr.png (X-API-Key + X-App-Id + X-Tenant-Id headers) and scan it from the branch's WhatsApp > Linked Devices"
echo "3. Wait for /accounts/<waAccountId>/status = connected"
echo "4. Flip the branch config to mode: live and redeploy"
