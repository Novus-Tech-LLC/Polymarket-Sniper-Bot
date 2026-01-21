# 🔍 401 Auth Failure - Visual Diagnostic Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   USER REPORTS 401 ERROR                        │
│  "Unauthorized/Invalid api key" despite valid credentials      │
│  Wallet HAS TRADED on Polymarket ✓                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│              HYPOTHESIS: SIGNATURE MISMATCH                     │
│  Credentials are valid, but signature computation is wrong      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│           SOLUTION: HMAC DIAGNOSTIC INSTRUMENTATION             │
│                                                                 │
│  ┌─────────────────────┐         ┌─────────────────────┐      │
│  │  HMAC Override      │         │  HTTP Interceptor   │      │
│  │  (Signing Inputs)   │         │  (Actual Request)   │      │
│  └──────────┬──────────┘         └──────────┬──────────┘      │
│             │                               │                  │
│             │    Track signing inputs       │                  │
│             └───────────────┬───────────────┘                  │
│                             ↓                                  │
│                  ┌──────────────────────┐                      │
│                  │   CORRELATION        │                      │
│                  │  Compare:            │                      │
│                  │  • Signed path       │                      │
│                  │  • Actual path       │                      │
│                  │  • Method            │                      │
│                  │  • Body hash         │                      │
│                  └──────────┬───────────┘                      │
│                             ↓                                  │
│            ┌────────────────┴────────────────┐                │
│            │                                 │                │
│      ✓ MATCH                          ✗ MISMATCH             │
│      (200 OK)                        (401 + Diagnostic)       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DIAGNOSTIC OUTPUT                            │
│                                                                 │
│  {                                                              │
│    "signedPath": "/balance-allowance?asset_type=COLLATERAL...",│
│    "actualPath": "/balance-allowance?signature_type=0&asset...",│
│    "pathMatch": false,  ← ROOT CAUSE IDENTIFIED                │
│    "signedMethod": "GET",                                       │
│    "actualMethod": "GET",                                       │
│    "methodMatch": true,                                         │
│    "secretHash": "a3f8b2c1...",                                 │
│    "timestamp": "1705680000"                                    │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    TARGETED FIX                                 │
│                                                                 │
│  IF pathMatch = false:                                          │
│    → Query params in wrong order                                │
│    → Extend patch to canonicalize ALL endpoints                 │
│                                                                 │
│  IF signatureType = 0 for browser wallet:                       │
│    → Should be signatureType = 2                                │
│    → Set POLYMARKET_PROXY_ADDRESS                               │
│                                                                 │
│  IF secretEncoding mismatch:                                    │
│    → Already handled by clob-client (unlikely)                  │
└─────────────────────────────────────────────────────────────────┘
```

## 🎯 Key Insight

Instead of **guessing** the root cause, we **intercept both sides** of the transaction:

1. **What we sign** (HMAC Override)
2. **What we send** (HTTP Interceptor)
3. **Compare them** (Correlation)

The diagnostic shows the **exact discrepancy**, enabling a surgical fix.

## 📊 Probability Assessment

| Root Cause                 | Probability | How Diagnostic Detects It         |
| -------------------------- | ----------- | --------------------------------- |
| Query param order mismatch | 70%         | `pathMatch: false`                |
| Wrong signature type       | 20%         | User must check wallet type       |
| Secret encoding issue      | 5%          | Already normalized by clob-client |
| Timestamp drift            | 3%          | `timestamp` field in diagnostic   |
| Body encoding issue        | 2%          | `bodyHash` comparison             |

## 🚀 Quick Start

```bash
# 1. Set credentials
export PRIVATE_KEY="your_key"
export POLYMARKET_API_KEY="your_key"
export POLYMARKET_API_SECRET="your_secret"
export POLYMARKET_API_PASSPHRASE="your_passphrase"

# 2. Run diagnostic
./scripts/quick-401-diagnostic.sh

# 3. Review output
# Look for [HmacDiag] MISMATCH DETECTED
# Check JSON diagnostic for pathMatch: false
```

## 📚 Documentation Tree

```
/home/runner/work/Polymarket-Sniper-Bot/Polymarket-Sniper-Bot/
├── NEXT_STEPS_401_FIX.md          ← START HERE (User-facing guide)
├── HMAC_DIAGNOSTIC_FIX.md          ← Technical details
├── IMPLEMENTATION_SUMMARY_401_FIX.md ← Complete implementation summary
├── scripts/
│   ├── quick-401-diagnostic.sh     ← One-command diagnostic
│   └── test-hmac-diagnostic.js     ← Standalone test harness
├── src/
│   ├── utils/
│   │   ├── hmac-diagnostic-interceptor.ts  ← HTTP correlation
│   │   └── hmac-signature-override.ts      ← HMAC wrapping
│   └── infrastructure/
│       └── clob-client.factory.ts          ← Integration point
└── README.md                        ← Updated troubleshooting section
```

## ✅ Success Criteria

After running diagnostic and applying fix:

```
[INFO] Creating Polymarket client...
[INFO] Client created successfully
[INFO] Testing getBalanceAllowance...
✓ Success! Balance retrieved.
{
  "balance": "100.00",
  "allowance": "1000.00"
}
```

## 🔒 Security Guarantees

✅ Secrets hashed (SHA256) before logging  
✅ Only first/last 4-8 chars shown  
✅ Opt-in diagnostic mode  
✅ Zero overhead when disabled  
✅ No plaintext credentials in output

---

**Implementation Date**: 2025-01-19  
**Commit**: `d03f486`  
**Branch**: `copilot/fix-polymarket-clob-issues`  
**Estimated Time to Resolution**: 30-60 minutes
