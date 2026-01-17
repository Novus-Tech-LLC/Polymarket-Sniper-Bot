export const formatClobAuthFailureHint = (deriveEnabled: boolean): string => {
  const deriveHint = deriveEnabled
    ? "Derived keys are enabled; ensure the wallet has access to the CLOB and that derived credentials are valid."
    : "If you want wallet-derived keys, set CLOB_DERIVE_CREDS=true (or CLOB_DERIVE_API_KEY=true) and remove manual API keys.";
  return [
    "[CLOB] Auth hint: verify POLYMARKET_API_KEY/SECRET/PASSPHRASE are CLOB API keys (not browser/session tokens),",
    "match the production environment, and regenerate them if rotated.",
    "IMPORTANT: Builder API keys (POLY_BUILDER_API_KEY) are NOT the same as CLOB API keys - they are for gasless relayer transactions only.",
    deriveHint,
  ].join(" ");
};
