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

export type OrderSide = "BUY" | "SELL";
export type OrderOutcome = "YES" | "NO";

export type PostOrderInput = {
  client: ClobClient;
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

export async function postOrder(
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
