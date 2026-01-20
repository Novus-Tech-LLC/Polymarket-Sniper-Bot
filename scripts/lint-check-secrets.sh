#!/bin/bash
# Lint Check - Block console.log and secret leakage
#
# This script enforces:
# 1. No console.log in src/ (except in utils/structured-logger.ts and utils/logger.util.ts)
# 2. No logs containing secrets (private, secret, passphrase, apiKey - case insensitive)
# 3. Exit code 1 if violations found
#
# Usage:
#   npm run lint:secrets
#   bash scripts/lint-check-secrets.sh

set -e

echo "========================================="
echo "Linting for console.log and secret leakage..."
echo "========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

VIOLATIONS=0

# ===================================================================
# RULE 1: No console.log in src/ (except in allowed files)
# ===================================================================
echo ""
echo "RULE 1: Checking for console.log in src/"
echo "        (Allowed: structured-logger.ts, logger.util.ts, minimal-auth.ts)"

ALLOWED_FILES=(
  "src/utils/structured-logger.ts"
  "src/utils/logger.util.ts"
  "src/clob/minimal-auth.ts"
)

# Find all console.log occurrences
CONSOLE_LOG_FILES=$(grep -rn --include="*.ts" "console\.log" src/ 2>/dev/null | grep -v "eslint-disable" || true)

if [ -z "$CONSOLE_LOG_FILES" ]; then
  echo -e "${GREEN}✅ No console.log found${NC}"
else
  # Filter out allowed files
  VIOLATIONS_FOUND=false
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    IS_ALLOWED=false
    
    for allowed in "${ALLOWED_FILES[@]}"; do
      if [[ "$FILE" == "$allowed" ]]; then
        IS_ALLOWED=true
        break
      fi
    done
    
    if [ "$IS_ALLOWED" = false ]; then
      if [ "$VIOLATIONS_FOUND" = false ]; then
        echo -e "${RED}❌ VIOLATION: Found console.log in non-allowed files:${NC}"
        VIOLATIONS_FOUND=true
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
      echo "   $line"
    fi
  done <<< "$CONSOLE_LOG_FILES"
  
  if [ "$VIOLATIONS_FOUND" = false ]; then
    echo -e "${GREEN}✅ All console.log occurrences are in allowed files${NC}"
  fi
fi

# ===================================================================
# RULE 2: No console.error/warn in src/ (except in allowed files)
# ===================================================================
echo ""
echo "RULE 2: Checking for console.error/console.warn in src/"
echo "        (Use structured logger instead)"

# Exclude files that legitimately need console.error/warn
EXCLUDED_FROM_CONSOLE_CHECK=(
  "src/utils/structured-logger.ts"
  "src/utils/logger.util.ts"
  "src/utils/console-filter.util.ts"
  "src/clob/minimal-auth.ts"
)

CONSOLE_ERROR_FILES=$(grep -rn --include="*.ts" -E "console\.(error|warn)" src/ 2>/dev/null | grep -v "eslint-disable" || true)
for excluded in "${EXCLUDED_FROM_CONSOLE_CHECK[@]}"; do
  CONSOLE_ERROR_FILES=$(echo "$CONSOLE_ERROR_FILES" | grep -v "$excluded" || true)
done

if [ -z "$CONSOLE_ERROR_FILES" ]; then
  echo -e "${GREEN}✅ No unauthorized console.error/warn found${NC}"
else
  echo -e "${YELLOW}⚠️  WARNING: Found console.error/warn (review these):${NC}"
  echo "$CONSOLE_ERROR_FILES"
fi

# ===================================================================
# RULE 3: No direct secret logging (privateKey, secret, passphrase)
# ===================================================================
echo ""
echo "RULE 3: Checking for direct secret logging"

SECRET_LOGS=$(grep -rn --include="*.ts" --include="*.js" \
  -iE "console\.(log|info|warn|error|debug)\(.*\b(private.*key|secret|passphrase|api.*key)\b" \
  src/ 2>/dev/null | grep -v "eslint-disable" | grep -v "src/utils/structured-logger.ts" | grep -v "src/utils/auth-logger.ts" | grep -v "redactApiKey\|redactSecret\|redactPassphrase\|apiKeySuffix" || true)

if [ -z "$SECRET_LOGS" ]; then
  echo -e "${GREEN}✅ No direct secret logging found${NC}"
else
  echo -e "${RED}❌ VIOLATION: Found direct secret logging:${NC}"
  echo "$SECRET_LOGS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# ===================================================================
# RULE 4: No string interpolation with secrets
# ===================================================================
echo ""
echo "RULE 4: Checking for secret string interpolation"

# Exclude files that use these variable names for non-secret purposes
EXCLUDED_FROM_INTERPOLATION_CHECK=(
  "src/utils/structured-logger.ts"
  "src/utils/auth-logger.ts"
  "src/utils/clob-credentials.util.ts"
)

SECRET_INTERPOLATION=$(grep -rn --include="*.ts" --include="*.js" \
  -iE '`.*\$\{(private.*key|secret|passphrase|api.*key)\}.*`' \
  src/ 2>/dev/null || true)
for excluded in "${EXCLUDED_FROM_INTERPOLATION_CHECK[@]}"; do
  SECRET_INTERPOLATION=$(echo "$SECRET_INTERPOLATION" | grep -v "$excluded" || true)
done

if [ -z "$SECRET_INTERPOLATION" ]; then
  echo -e "${GREEN}✅ No secret string interpolation found${NC}"
else
  echo -e "${RED}❌ VIOLATION: Found secret string interpolation:${NC}"
  echo "$SECRET_INTERPOLATION"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# ===================================================================
# RULE 5: No full wallet.privateKey logging
# ===================================================================
echo ""
echo "RULE 5: Checking for full wallet.privateKey logging"

WALLET_PK_LOGS=$(grep -rn --include="*.ts" --include="*.js" \
  -iE "console\.(log|info|warn|error|debug)\(.*wallet\.privateKey" \
  src/ 2>/dev/null || true)

if [ -z "$WALLET_PK_LOGS" ]; then
  echo -e "${GREEN}✅ No wallet.privateKey logging found${NC}"
else
  echo -e "${RED}❌ VIOLATION: Found wallet.privateKey logging:${NC}"
  echo "$WALLET_PK_LOGS"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# ===================================================================
# RULE 6: Ensure structured logger has redactSecrets function
# ===================================================================
echo ""
echo "RULE 6: Verifying structured logger redaction"

if grep -q "function redactSecrets" src/utils/structured-logger.ts; then
  echo -e "${GREEN}✅ Structured logger has redactSecrets function${NC}"
else
  echo -e "${RED}❌ VIOLATION: Structured logger missing redactSecrets${NC}"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# ===================================================================
# SUMMARY
# ===================================================================
echo ""
echo "========================================="
if [ $VIOLATIONS -eq 0 ]; then
  echo -e "${GREEN}✅ All checks passed - no secret leakage or console.log violations${NC}"
  exit 0
else
  echo -e "${RED}❌ Found $VIOLATIONS violation(s)${NC}"
  echo ""
  echo "REQUIRED ACTIONS:"
  echo "1. Replace console.log with structured logger (getLogger())"
  echo "2. Use suffix/hash instead of full secrets"
  echo "3. Ensure all credential logging uses redaction"
  echo "4. Add eslint-disable comments with justification if console.log is intentional"
  exit 1
fi
