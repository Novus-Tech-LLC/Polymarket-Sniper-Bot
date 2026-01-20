#!/bin/bash
# Check that no secrets are being logged in the codebase
# This script searches for potential secret leakage patterns

set -e

echo "========================================="
echo "Checking for potential secret leakage..."
echo "========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

VIOLATIONS=0

# Pattern 1: Direct logging of privateKey/secret/passphrase variables
echo ""
echo "Checking for direct secret logging..."
if grep -rn --include="*.ts" --include="*.js" \
  -iE "console\.(log|info|warn|error|debug)\(.*\b(private.*key|secret|passphrase|api.*key)\b" \
  src/ 2>/dev/null | grep -v "// eslint-disable" | grep -v "src/utils/structured-logger.ts"; then
  echo -e "${RED}❌ VIOLATION: Found direct secret logging${NC}"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo -e "${GREEN}✅ No direct secret logging found${NC}"
fi

# Pattern 2: Logging entire credential objects
echo ""
echo "Checking for credential object logging..."
if grep -rn --include="*.ts" --include="*.js" \
  -iE "console\.(log|info|warn|error|debug)\(.*\b(creds|credentials|api.*key)\b.*\)" \
  src/ 2>/dev/null | grep -v "// eslint-disable" | grep -v "apiKeySuffix" | grep -v "src/utils/structured-logger.ts"; then
  echo -e "${YELLOW}⚠️  WARNING: Found potential credential object logging${NC}"
  echo "   Review these manually to ensure they're using redaction"
else
  echo -e "${GREEN}✅ No credential object logging found${NC}"
fi

# Pattern 3: String interpolation with secrets
echo ""
echo "Checking for secret string interpolation..."
if grep -rn --include="*.ts" --include="*.js" \
  -iE "\`.*\$\{(private.*key|secret|passphrase|api.*key)\}.*\`" \
  src/ 2>/dev/null | grep -v "src/utils/structured-logger.ts"; then
  echo -e "${RED}❌ VIOLATION: Found secret string interpolation${NC}"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo -e "${GREEN}✅ No secret string interpolation found${NC}"
fi

# Pattern 4: Full wallet.privateKey access (should only show suffix)
echo ""
echo "Checking for full wallet.privateKey logging..."
if grep -rn --include="*.ts" --include="*.js" \
  -iE "console\.(log|info|warn|error|debug)\(.*wallet\.privateKey" \
  src/ 2>/dev/null; then
  echo -e "${RED}❌ VIOLATION: Found wallet.privateKey logging${NC}"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo -e "${GREEN}✅ No wallet.privateKey logging found${NC}"
fi

# Pattern 5: Ensure structured logger is using redaction
echo ""
echo "Checking structured logger redaction function..."
if grep -q "function redactSecrets" src/utils/structured-logger.ts; then
  echo -e "${GREEN}✅ Structured logger has redactSecrets function${NC}"
else
  echo -e "${RED}❌ VIOLATION: Structured logger missing redactSecrets${NC}"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# Summary
echo ""
echo "========================================="
if [ $VIOLATIONS -eq 0 ]; then
  echo -e "${GREEN}✅ All checks passed - no secret leakage detected${NC}"
  exit 0
else
  echo -e "${RED}❌ Found $VIOLATIONS violation(s)${NC}"
  echo ""
  echo "REQUIRED ACTIONS:"
  echo "1. Replace console.log with structured logger (getLogger())"
  echo "2. Use suffix/hash instead of full secrets"
  echo "3. Ensure all credential logging uses redaction"
  exit 1
fi
