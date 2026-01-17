#!/bin/bash
# Test script to verify preflight behavior without real credentials

export RPC_URL="https://polygon-rpc.com"
export PRIVATE_KEY="0x0000000000000000000000000000000000000000000000000000000000000001"
export CLOB_DERIVE_CREDS="true"
export ARB_LIVE_TRADING="false"

echo "Testing preflight with minimal config..."
npm run preflight
EXIT_CODE=$?

echo ""
echo "Preflight exit code: $EXIT_CODE"
echo "Expected: non-zero (should fail without real credentials/network)"

if [ $EXIT_CODE -ne 0 ]; then
    echo "✅ Preflight correctly returns non-zero when not ready to trade"
    exit 0
else
    echo "❌ Preflight returned 0 when it should have failed"
    exit 1
fi
