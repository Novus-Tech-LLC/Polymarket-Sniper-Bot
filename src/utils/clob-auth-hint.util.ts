export const formatClobAuthFailureHint = (deriveEnabled: boolean): string => {
  const deriveHint = deriveEnabled
    ? "Derived keys are enabled; ensure the wallet has traded on Polymarket at least once."
    : "If you want wallet-derived keys, set CLOB_DERIVE_CREDS=true (or CLOB_DERIVE_API_KEY=true) and remove manual API keys.";
  return [
    "[CLOB] Auth hint: Several possible causes for 401 errors:",
    "1) If this is a NEW WALLET that has never traded on Polymarket, you MUST make at least one trade on https://polymarket.com first.",
    "2) If using manual API keys (POLYMARKET_API_*), verify they are CLOB API keys from https://polymarket.com/settings/api",
    "3) Verify the API keys were created for THIS specific wallet address (check logs for wallet address).",
    "4) Check that keys are not expired - try regenerating new keys.",
    "5) Ensure you're not using Builder API keys (POLY_BUILDER_*) as CLOB keys - they are for gasless transactions only.",
    "6) Try enabling CLOB_PREFLIGHT_MATRIX=true for detailed auth debugging.",
    deriveHint,
  ].join(" ");
};
