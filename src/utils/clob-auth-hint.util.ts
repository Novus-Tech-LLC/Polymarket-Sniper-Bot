export const formatClobAuthFailureHint = (deriveEnabled: boolean): string => {
  // Note: deriveEnabled defaults to true now (pmxt-style)
  const deriveHint = deriveEnabled
    ? "Credential derivation is enabled (default); ensure the wallet has traded on Polymarket at least once."
    : "Credential derivation is disabled; to enable auto-derivation from PRIVATE_KEY, set CLOB_DERIVE_CREDS=true or remove it from your configuration.";
  return [
    "[CLOB] Auth hint: Several possible causes for 401 errors:",
    "1) If this is a NEW WALLET that has never traded on Polymarket, you MUST make at least one trade on https://polymarket.com first.",
    "2) If using manual API keys (POLYMARKET_API_*), verify they are CLOB API keys (there is no web UI to manually generate CLOB API keys)",
    "3) Verify the API keys were created for THIS specific wallet address (check logs for wallet address).",
    "4) Check that keys are not expired - try regenerating new keys.",
    "5) Ensure you're not using Builder API keys (POLY_BUILDER_*) as CLOB keys - they are for gasless transactions only.",
    "6) Try enabling CLOB_PREFLIGHT_MATRIX=true for detailed auth debugging.",
    deriveHint,
  ].join(" ");
};
