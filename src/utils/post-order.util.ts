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
} from "./funds-allowance.util";

// On-chain trading support
import type { Wallet } from "ethers";
import { executeOnChainOrder } from "../trading/onchain-executor";

export type OrderSide = "BUY" | "SELL";
export type OrderOutcome = "YES" | "NO";

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
 */
async function postOrderOnChain(
  input: PostOrderInput,
): Promise<OrderSubmissionResult> {
  const {
    wallet,
    tokenId,
    outcome,
    side,
    sizeUsd,
    maxAcceptablePrice,
    logger,
  } = input;

  const liveTradingEnabled =
    process.env.ARB_LIVE_TRADING === "I_UNDERSTAND_THE_RISKS";
  if (!liveTradingEnabled) {
    logger.warn("[ONCHAIN] Live trading disabled; skipping order submission.");
    return { status: "skipped", reason: "LIVE_TRADING_DISABLED" };
  }

  if (!wallet) {
    logger.error("[ONCHAIN] Wallet required for on-chain trading mode");
    return { status: "failed", reason: "NO_WALLET" };
  }

  logger.info(
    `[ONCHAIN] Executing on-chain order: ${side} ${sizeUsd} USD of token ${tokenId}`,
  );

  try {
    const result = await executeOnChainOrder({
      wallet,
      tokenId,
      outcome,
      side,
      sizeUsd,
      maxAcceptablePrice,
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
      logger.error(`[ONCHAIN] Order failed: ${result.error ?? result.reason}`);
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
  const {
    client,
    marketId,
    tokenId,
    outcome,
    side,
    sizeUsd,
    maxAcceptablePrice,
    logger,
  } = input;
  const liveTradingEnabled =
    process.env.ARB_LIVE_TRADING === "I_UNDERSTAND_THE_RISKS";
  if (!liveTradingEnabled) {
    logger.warn("[CLOB] Live trading disabled; skipping order submission.");
    return { status: "skipped", reason: "LIVE_TRADING_DISABLED" };
  }
  const settings = toOrderSubmissionSettings({
    minOrderUsd: input.orderConfig?.minOrderUsd,
    orderSubmitMinIntervalMs: input.orderConfig?.orderSubmitMinIntervalMs,
    orderSubmitMaxPerHour: input.orderConfig?.orderSubmitMaxPerHour,
    orderSubmitMarketCooldownSeconds:
      input.orderConfig?.orderSubmitMarketCooldownSeconds,
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
      orderFingerprint,
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

  return { status: "failed", reason: "order_incomplete" };
}
