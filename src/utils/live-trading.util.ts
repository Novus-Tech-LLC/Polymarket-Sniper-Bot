/**
 * Utility to check if live trading is enabled.
 * Supports both ARB_LIVE_TRADING and LIVE_TRADING (alias) environment variables.
 */

/**
 * Check if live trading is enabled via ARB_LIVE_TRADING or LIVE_TRADING env vars.
 * Live trading is enabled if either variable is set to exactly "I_UNDERSTAND_THE_RISKS".
 * 
 * @returns true if either ARB_LIVE_TRADING or LIVE_TRADING is set to "I_UNDERSTAND_THE_RISKS"
 */
export function isLiveTradingEnabled(): boolean {
  const arbLiveTrading =
    process.env.ARB_LIVE_TRADING ?? process.env.arb_live_trading;
  const liveTrading = process.env.LIVE_TRADING ?? process.env.live_trading;

  return (
    arbLiveTrading === "I_UNDERSTAND_THE_RISKS" ||
    liveTrading === "I_UNDERSTAND_THE_RISKS"
  );
}
