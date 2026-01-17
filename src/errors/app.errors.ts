/**
 * Base application error class
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration error - thrown when required environment variables are missing
 */
export class ConfigurationError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "CONFIG_ERROR", cause);
  }
}

/**
 * Trade execution error - thrown when order execution fails
 */
export class TradeExecutionError extends AppError {
  constructor(
    message: string,
    public readonly marketId?: string,
    public readonly tokenId?: string,
    cause?: Error,
  ) {
    super(message, "TRADE_EXECUTION_ERROR", cause);
  }
}

/**
 * Balance error - thrown when insufficient funds are available
 */
export class BalanceError extends AppError {
  constructor(
    message: string,
    public readonly required?: number,
    public readonly available?: number,
    cause?: Error,
  ) {
    super(message, "BALANCE_ERROR", cause);
  }
}

/**
 * Market error - thrown when market is closed, resolved, or unavailable
 */
export class MarketError extends AppError {
  constructor(
    message: string,
    public readonly marketId?: string,
    cause?: Error,
  ) {
    super(message, "MARKET_ERROR", cause);
  }
}

/**
 * Orderbook error - thrown when no orderbook exists for a token
 */
export class OrderbookNotFoundError extends MarketError {
  constructor(
    message: string,
    public readonly tokenId?: string,
    marketId?: string,
    cause?: Error,
  ) {
    super(message, marketId, cause);
  }
}

/**
 * Network error - thrown when RPC or API calls fail
 */
export class NetworkError extends AppError {
  constructor(
    message: string,
    public readonly endpoint?: string,
    cause?: Error,
  ) {
    super(message, "NETWORK_ERROR", cause);
  }
}
