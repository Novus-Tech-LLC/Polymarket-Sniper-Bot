import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { ORDER_EXECUTION } from "../constants/polymarket.constants";
import { withAuthRetry } from "../infrastructure/clob-auth";
import type { Logger } from "./logger.util";
import {
  getOrderSubmissionController,
  toOrderSubmissionSettings,
  type OrderSubmissionConfig,
  type OrderSubmissionResult,
} from "./order-submission.util";
import {
  checkFundsAndAllowance,
  formatCollateralLabel,
  resolveSignerAddress,
  isInFlightOrCooldown,
  markBuyInFlight,
  markBuyCompleted,
  isMarketInCooldown,
  markMarketBuyCompleted,
} from "./funds-allowance.util";
import { isLiveTradingEnabled } from "./live-trading.util";

// On-chain trading support
import type { Wallet } from "ethers";
import { executeOnChainOrder } from "../trading/onchain-executor";

export type OrderSide = "BUY" | "SELL";
export type OrderOutcome = "YES" | "NO";

/**
 * Global minimum price for BUY orders to prevent buying "loser" positions.
 * Positions at extremely low prices (e.g., 3¢) are almost certain to lose.
 * This is a safety net that applies to ALL buy orders unless explicitly skipped.
 * Default: 0.10 (10¢) - only blocks extreme loser positions
 */
export const GLOBAL_MIN_BUY_PRICE = 0.1;

export type PostOrderInput = {
  client: ClobClient;
  wallet?: Wallet; // Required for on-chain mode
  marketId?: string;
  tokenId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  sizeUsd: number;
  collateralTokenAddress?: string;
  collateralTokenDecimals?: number;
  collateralTokenId?: string;
  maxAcceptablePrice?: number;
  priority?: boolean; // For frontrunning - execute with higher priority
  targetGasPrice?: string; // Gas price of target transaction for frontrunning
  /**
   * Skip duplicate prevention check for this order.
   * Use for hedging, stop-loss, or other operations that need to execute
   * regardless of recent orders on the same token.
   */
  skipDuplicatePrevention?: boolean;
  /**
   * Skip the global minimum buy price check.
   * Set to true for legitimate hedge operations where buying at low prices
   * is intentional (e.g., buying NO at 3¢ when YES is at 97¢ and losing).
   * Default: false - always enforce minimum buy price safety
   */
  skipMinBuyPriceCheck?: boolean;
  /**
   * Minimum buy price threshold. Set via MIN_BUY_PRICE env variable.
   * Set to 0 to allow buying at any price (useful for scalping volatile low-price positions).
   * If not provided, uses GLOBAL_MIN_BUY_PRICE constant (0.10 = 10¢) as fallback.
   */
  minBuyPrice?: number;
  /**
   * Low-price scalping threshold. Set via SCALP_LOW_PRICE_THRESHOLD env variable.
   * If set > 0, allows buying at prices at or below this threshold (bypasses MIN_BUY_PRICE).
   * Example: 0.20 means you can buy at 20¢ or below, and those positions get instant profit.
   */
  scalpLowPriceThreshold?: number;
  /**
   * Skip the minimum order size check.
   * Use for liquidations/sells where we need to sell whatever position
   * size we have, even if it's below the normal minimum order size.
   * Default: false - enforce minimum order size
   */
  skipMinOrderSizeCheck?: boolean;
  logger: Logger;
  orderConfig?: OrderSubmissionConfig;
  now?: number;
};

const missingOrderbooks = new Set<string>();

/**
 * Post an order to Polymarket
 *
 * This function routes orders based on the TRADE_MODE environment variable:
 * - TRADE_MODE=clob (default): Uses CLOB API with authentication
 * - TRADE_MODE=onchain (experimental): Bypasses CLOB API and trades directly on-chain
 *   (Note: On-chain mode infrastructure is in place but requires additional integration)
 *
 * On-chain mode benefits (when fully implemented):
 * - No API credentials required (only PRIVATE_KEY and RPC_URL)
 * - No rate limits from CLOB API
 * - Direct blockchain interaction
 * - More transparent execution
 *
 * Note: TRADE_MODE is read from environment for simplicity since it affects
 * early initialization before config is fully loaded. For testability, you can
 * mock process.env.TRADE_MODE in tests.
 *
 * @param input Order parameters
 * @returns Order submission result
 */
export async function postOrder(
  input: PostOrderInput,
): Promise<OrderSubmissionResult> {
  // Check if on-chain mode is enabled
  // Note: Read from env for early initialization; set process.env.TRADE_MODE in tests
  const tradeMode = (process.env.TRADE_MODE ?? "clob").toLowerCase();

  if (tradeMode === "onchain") {
    return postOrderOnChain(input);
  }

  // Default CLOB mode
  return postOrderClob(input);
}

/**
 * Post order via on-chain execution (bypasses CLOB API)
 *
 * ⚠️ IMPORTANT: On-chain trading mode is EXPERIMENTAL and NOT FULLY IMPLEMENTED.
 *
 * The on-chain executor can verify balances and approvals, but cannot actually
 * execute trades because it requires signed maker orders from the CLOB API.
 *
 * For trading (BUY/SELL), use TRADE_MODE=clob instead.
 *
 * Redemption of resolved positions works separately via the AutoRedeem strategy
 * which directly calls the CTF contract's redeemPositions() function.
 */
async function postOrderOnChain(
  input: PostOrderInput,
): Promise<OrderSubmissionResult> {
  const { wallet, tokenId, side, sizeUsd, logger } = input;

  // Emit a clear warning about on-chain mode limitations
  logger.warn(
    `[ONCHAIN] ⚠️ TRADE_MODE=onchain does NOT support ${side} orders. ` +
      `On-chain trading requires signed maker orders (not implemented). ` +
      `Use TRADE_MODE=clob for trading. Redemption of resolved positions works separately via AutoRedeem.`,
  );

  const liveTradingEnabled = isLiveTradingEnabled();
  if (!liveTradingEnabled) {
    logger.warn("[ONCHAIN] Live trading disabled; skipping order submission.");
    return { status: "skipped", reason: "LIVE_TRADING_DISABLED" };
  }

  if (!wallet) {
    logger.error("[ONCHAIN] Wallet required for on-chain trading mode");
    return { status: "failed", reason: "NO_WALLET" };
  }

  logger.info(
    `[ONCHAIN] Attempting on-chain order: ${side} ${sizeUsd} USD of token ${tokenId.slice(0, 16)}...`,
  );

  try {
    const result = await executeOnChainOrder({
      wallet,
      tokenId,
      outcome: input.outcome,
      side,
      sizeUsd,
      maxAcceptablePrice: input.maxAcceptablePrice,
      collateralTokenAddress: input.collateralTokenAddress,
      collateralTokenDecimals: input.collateralTokenDecimals,
      logger,
      dryRun: !liveTradingEnabled,
    });

    if (result.success) {
      logger.info(
        `[ONCHAIN] Order executed successfully${result.transactionHash ? ` - tx: ${result.transactionHash}` : ""}`,
      );
      return {
        status: "submitted",
        transactionHash: result.transactionHash,
        orderId: result.transactionHash,
      };
    } else {
      // Provide actionable guidance for NOT_IMPLEMENTED error
      if (result.reason === "NOT_IMPLEMENTED") {
        logger.error(
          `[ONCHAIN] ❌ On-chain ${side} not supported. Switch to TRADE_MODE=clob for trading.`,
        );
      } else {
        logger.error(
          `[ONCHAIN] Order failed: ${result.error ?? result.reason}`,
        );
      }
      return {
        status: "failed",
        reason: result.reason ?? "ONCHAIN_EXECUTION_FAILED",
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[ONCHAIN] Order execution error: ${errorMessage}`);
    return {
      status: "failed",
      reason: "ONCHAIN_ERROR",
    };
  }
}

/**
 * Post order via CLOB API (traditional mode)
 */
async function postOrderClob(
  input: PostOrderInput,
): Promise<OrderSubmissionResult> {
  const { tokenId, side, logger, maxAcceptablePrice, marketId } = input;
  const liveTradingEnabled = isLiveTradingEnabled();
  if (!liveTradingEnabled) {
    logger.warn("[CLOB] Live trading disabled; skipping order submission.");
    return { status: "skipped", reason: "LIVE_TRADING_DISABLED" };
  }

  // === GLOBAL MINIMUM BUY PRICE CHECK ===
  // Prevents buying extremely low-probability "loser" positions (e.g., 3¢)
  // This is a SAFETY NET that catches orders from any source (ARB, copy trading, etc.)
  //
  // EXCEPTION: If SCALP_LOW_PRICE_THRESHOLD is set, allow buys at or below that threshold.
  // This enables scalping volatile low-price positions - one setting controls everything.
  // Example: SCALP_LOW_PRICE_THRESHOLD=0.20 allows buying at 20¢ or below.
  const effectiveMinBuyPrice = input.minBuyPrice ?? GLOBAL_MIN_BUY_PRICE;
  const scalpThreshold = input.scalpLowPriceThreshold ?? 0;

  if (
    side === "BUY" &&
    !input.skipMinBuyPriceCheck &&
    maxAcceptablePrice !== undefined &&
    effectiveMinBuyPrice > 0 // Skip check if minBuyPrice is 0 (uncapped)
  ) {
    // Allow buys at or below the scalp threshold (for low-price scalping)
    const allowedByScalpThreshold =
      scalpThreshold > 0 && maxAcceptablePrice <= scalpThreshold;

    if (!allowedByScalpThreshold && maxAcceptablePrice < effectiveMinBuyPrice) {
      logger.warn(
        `[CLOB] 🚫 Order blocked (LOSER_POSITION): BUY price ${(maxAcceptablePrice * 100).toFixed(1)}¢ < ${(effectiveMinBuyPrice * 100).toFixed(0)}¢ min. ` +
          `Positions this cheap are almost certain to lose. Token: ${tokenId.slice(0, 16)}... (Set SCALP_LOW_PRICE_THRESHOLD to enable low-price scalping)`,
      );
      return {
        status: "skipped",
        reason: "LOSER_POSITION_PRICE_TOO_LOW",
      };
    }
  }

  // === MARKET-LEVEL COOLDOWN CHECK ===
  // Prevents stacked buys on the SAME MARKET (different outcomes have different tokenIds)
  // This is critical to prevent buying multiple times on the same market within minutes
  if (!input.skipDuplicatePrevention && side === "BUY" && marketId) {
    const marketCooldownStatus = isMarketInCooldown(marketId);
    if (marketCooldownStatus.blocked) {
      const remainingSec = Math.ceil(
        (marketCooldownStatus.remainingMs ?? 0) / 1000,
      );
      logger.warn(
        `[CLOB] Order skipped (${marketCooldownStatus.reason}): BUY on market ${marketId.slice(0, 8)}... blocked for ${remainingSec}s (prevents stacked buys on same market)`,
      );
      return {
        status: "skipped",
        reason: marketCooldownStatus.reason ?? "MARKET_BUY_COOLDOWN",
      };
    }
  }

  // Early check for in-flight BUY orders to prevent stacking
  // This check runs BEFORE any expensive operations (orderbook fetch, balance check)
  if (!input.skipDuplicatePrevention && side === "BUY") {
    const inFlightStatus = isInFlightOrCooldown(tokenId, side);
    if (inFlightStatus.blocked) {
      const remainingSec = Math.ceil((inFlightStatus.remainingMs ?? 0) / 1000);
      logger.warn(
        `[CLOB] Order skipped (${inFlightStatus.reason}): BUY on token ${tokenId.slice(0, 8)}... blocked for ${remainingSec}s (prevents buy stacking)`,
      );
      return {
        status: "skipped",
        reason: inFlightStatus.reason ?? "IN_FLIGHT_BUY",
      };
    }
    // Mark this buy as in-flight (returns false if race condition detected)
    const marked = markBuyInFlight(tokenId);
    if (!marked) {
      logger.warn(
        `[CLOB] Order skipped (IN_FLIGHT_BUY): BUY on token ${tokenId.slice(0, 8)}... race condition detected (prevents buy stacking)`,
      );
      return {
        status: "skipped",
        reason: "IN_FLIGHT_BUY",
      };
    }
  }

  // Wrap the rest in try/finally to ensure we mark completion
  try {
    const result = await postOrderClobInner(input);
    return result;
  } finally {
    // Always mark completion for BUY orders (regardless of success/failure)
    // This prevents rapid-fire retry attempts on the same token/market
    if (!input.skipDuplicatePrevention && side === "BUY") {
      markBuyCompleted(tokenId);
      // Mark market cooldown regardless of submission success
      // The intent was to buy on this market, so apply cooldown even if order fails
      if (marketId) {
        markMarketBuyCompleted(marketId);
      }
    }
  }
}

/**
 * Inner implementation of postOrderClob (after in-flight check)
 */
async function postOrderClobInner(
  input: PostOrderInput,
): Promise<OrderSubmissionResult> {
  const {
    client,
    marketId,
    tokenId,
    side,
    sizeUsd,
    maxAcceptablePrice,
    logger,
  } = input;
  const settings = toOrderSubmissionSettings({
    minOrderUsd: input.orderConfig?.minOrderUsd,
    orderSubmitMinIntervalMs: input.orderConfig?.orderSubmitMinIntervalMs,
    orderSubmitMaxPerHour: input.orderConfig?.orderSubmitMaxPerHour,
    orderSubmitMarketCooldownSeconds:
      input.orderConfig?.orderSubmitMarketCooldownSeconds,
    orderDuplicatePreventionSeconds:
      input.orderConfig?.orderDuplicatePreventionSeconds,
    cloudflareCooldownSeconds: input.orderConfig?.cloudflareCooldownSeconds,
    authCooldownSeconds: input.orderConfig?.authCooldownSeconds,
  });
  const submissionController = getOrderSubmissionController(settings);
  const signerAddress = resolveSignerAddress(client);
  const collateralLabel = formatCollateralLabel(
    input.collateralTokenAddress,
    input.collateralTokenId,
  );

  if (missingOrderbooks.has(tokenId)) {
    throw new Error(`No orderbook exists for token ${tokenId} (cached)`);
  }

  // Optional: validate market exists if marketId provided
  if (marketId) {
    const market = await client.getMarket(marketId);
    if (!market) {
      throw new Error(`Market not found: ${marketId}`);
    }
  }

  let orderBook;
  try {
    orderBook = await client.getOrderBook(tokenId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("No orderbook exists") ||
      errorMessage.includes("404")
    ) {
      missingOrderbooks.add(tokenId);
      throw new Error(
        `Market ${marketId} is closed or resolved - no orderbook available for token ${tokenId}`,
      );
    }
    throw error;
  }

  if (!orderBook) {
    throw new Error(`Failed to fetch orderbook for token ${tokenId}`);
  }

  const isBuy = side === "BUY";
  const levels = isBuy ? orderBook.asks : orderBook.bids;

  if (!levels || levels.length === 0) {
    throw new Error(
      `No ${isBuy ? "asks" : "bids"} available for token ${tokenId} - market may be closed or have no liquidity`,
    );
  }

  const bestPrice = parseFloat(levels[0].price);
  if (
    maxAcceptablePrice &&
    ((isBuy && bestPrice > maxAcceptablePrice) ||
      (!isBuy && bestPrice < maxAcceptablePrice))
  ) {
    throw new Error(
      `Price protection: best price ${bestPrice} exceeds max acceptable ${maxAcceptablePrice}`,
    );
  }

  const orderSide = isBuy ? Side.BUY : Side.SELL;
  let remaining = sizeUsd;
  let retryCount = 0;
  const maxRetries = ORDER_EXECUTION.MAX_RETRIES;

  while (
    remaining > ORDER_EXECUTION.MIN_REMAINING_USD &&
    retryCount < maxRetries
  ) {
    const currentOrderBook = await client.getOrderBook(tokenId);
    const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

    if (!currentLevels || currentLevels.length === 0) {
      break;
    }

    const level = currentLevels[0];
    const levelPrice = parseFloat(level.price);
    const levelSize = parseFloat(level.size);

    let orderSize: number;
    let orderValue: number;

    if (isBuy) {
      const levelValue = levelSize * levelPrice;
      orderValue = Math.min(remaining, levelValue);
      orderSize = orderValue / levelPrice;
    } else {
      const levelValue = levelSize * levelPrice;
      orderValue = Math.min(remaining, levelValue);
      orderSize = orderValue / levelPrice;
    }

    const orderArgs = {
      side: orderSide,
      tokenID: tokenId,
      amount: orderSize,
      price: levelPrice,
    };
    const orderFingerprint = `${tokenId}:${orderSide}:${levelPrice}:${orderSize}`;

    const readiness = await checkFundsAndAllowance({
      client,
      sizeUsd: orderValue,
      balanceBufferBps: input.orderConfig?.balanceBufferBps,
      collateralTokenAddress: input.collateralTokenAddress,
      collateralTokenDecimals: input.collateralTokenDecimals,
      collateralTokenId: input.collateralTokenId,
      conditionalTokenId: tokenId,
      autoApprove: input.orderConfig?.autoApprove,
      autoApproveMaxUsd: input.orderConfig?.autoApproveMaxUsd,
      logger,
    });
    if (!readiness.ok) {
      return {
        status: "skipped",
        reason: readiness.reason ?? "INSUFFICIENT_BALANCE_OR_ALLOWANCE",
      };
    }

    const result = await submissionController.submit({
      sizeUsd: orderValue,
      marketId,
      tokenId,
      side, // Pass side for duplicate prevention
      orderFingerprint,
      skipDuplicatePrevention: input.skipDuplicatePrevention,
      skipMinOrderSizeCheck: input.skipMinOrderSizeCheck,
      logger,
      now: input.now,
      skipRateLimit: retryCount > 0,
      signerAddress,
      collateralLabel,
      submit: async () => {
        const signedOrder = await client.createMarketOrder(orderArgs);
        return withAuthRetry(client, () =>
          client.postOrder(signedOrder, OrderType.FOK),
        );
      },
    });

    if (result.status === "submitted") {
      remaining -= orderValue;
      retryCount = 0;
      continue;
    }

    if (result.status === "skipped") {
      logger.warn(
        `[CLOB] Order skipped (${result.reason ?? "unknown"}): required=${orderValue.toFixed(2)} signer=${signerAddress} collateral=${collateralLabel}`,
      );
      return result;
    }

    // Handle FOK order killed (no fill) - this is a market liquidity issue
    if (result.reason === "FOK_ORDER_KILLED") {
      logger.warn(
        `[CLOB] FOK order killed (no liquidity): required=${orderValue.toFixed(2)} signer=${signerAddress} - market may have insufficient liquidity or price moved`,
      );
      return result;
    }

    if (result.statusCode === 403) {
      logger.warn(
        `[CLOB] Order failed (403): required=${orderValue.toFixed(2)} signer=${signerAddress} collateral=${collateralLabel}`,
      );
      return result;
    }

    retryCount++;
    if (retryCount >= maxRetries) {
      logger.warn(
        `[CLOB] Order failed (${result.reason ?? "unknown"}): required=${orderValue.toFixed(2)} signer=${signerAddress} collateral=${collateralLabel}`,
      );
      return result;
    }
  }

  // Check if order was filled (remaining amount is negligible)
  // Orders are considered successful when remaining <= MIN_REMAINING_USD (0.01)
  // because sub-cent amounts can't be practically filled due to price precision
  if (remaining <= ORDER_EXECUTION.MIN_REMAINING_USD) {
    return { status: "submitted" };
  }

  // Order was not fully filled - check if it was partially filled
  const filledAmount = sizeUsd - remaining;
  if (filledAmount > 0) {
    logger.warn(
      `[CLOB] Order partially filled: ${filledAmount.toFixed(2)}/${sizeUsd.toFixed(2)} USD (${((filledAmount / sizeUsd) * 100).toFixed(1)}%)`,
    );
  }

  // Return partial fill information so callers can track that money was spent
  return {
    status: "failed",
    reason: "order_incomplete",
    filledAmountUsd: filledAmount > 0 ? filledAmount : undefined,
  };
}
