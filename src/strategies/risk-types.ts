/**
 * Enterprise Trading System Types
 *
 * Core type definitions for the enterprise-grade trading system.
 */

/**
 * Position lifecycle states
 * - OPEN: Active position with value above dust threshold
 * - PARTIAL: Partially filled/closed position
 * - CLOSING: Position being closed (sell order pending)
 * - CLOSED: Position fully closed
 * - DUST: Position below dust threshold (excluded from risk calculations)
 * - RESOLVED: Market has resolved (waiting for redemption)
 */
export type PositionState =
  | "OPEN"
  | "PARTIAL"
  | "CLOSING"
  | "CLOSED"
  | "DUST"
  | "RESOLVED";

/**
 * Strategy identifiers
 */
export type StrategyId =
  | "MM"
  | "FF"
  | "ICC"
  | "ARB"
  | "ENDGAME"
  | "QUICK_FLIP"
  | "STOP_LOSS"
  | "HEDGE"
  | "SMART_HEDGE"
  | "PANIC_LIQUIDATION"
  | "MANUAL";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "POST_ONLY" | "IOC" | "FOK" | "MARKET";
export type OrderOutcome = "YES" | "NO";

/**
 * Token type for allowance handling
 * - COLLATERAL: USDC (ERC20)
 * - CONDITIONAL: Outcome tokens (ERC1155)
 */
export type TokenType = "COLLATERAL" | "CONDITIONAL";

export interface RiskDecision {
  approved: boolean;
  reason: string;
  adjustedSize?: number;
  warnings?: string[];
}

export interface OrderRequest {
  strategyId: StrategyId;
  marketId: string;
  tokenId: string;
  outcome: OrderOutcome; // YES or NO outcome
  side: OrderSide;
  size: number;
  price: number;
  sizeUsd: number;
  orderType: OrderType;
  expectedSlippage?: number;
  maxSlippage?: number;
  priority?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status:
    | "submitted"
    | "filled"
    | "partial"
    | "rejected"
    | "cancelled"
    | "error";
  filledSize?: number;
  filledPrice?: number;
  rejectCode?: string;
  rejectReason?: string;
  cooldownUntil?: number;
  error?: string;
}

export interface MarketData {
  marketId: string;
  tokenId: string;
  question: string;
  category?: string;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number;
  bidDepth: number;
  askDepth: number;
  volume24h?: number;
  tradesLast5Min?: number;
  lastUpdate: number;
  isHealthy: boolean;
}

export interface CircuitBreakerState {
  triggered: boolean;
  reason?: string;
  triggeredAt?: number;
  resumeAt?: number;
  consecutiveRejects: number;
  consecutiveApiErrors: number;
}

/**
 * Cooldown entry with side awareness
 * Key is `${tokenId}:${side}` for per-token, per-side cooldowns
 */
export interface CooldownEntry {
  tokenId: string;
  side: OrderSide;
  cooldownUntil: number;
  reason: string;
  attempts: number;
}

/**
 * In-flight order lock to prevent stacking/flip-flopping
 */
export interface InFlightLock {
  tokenId: string;
  side: OrderSide;
  strategyId: StrategyId;
  startedAt: number;
  completedAt?: number;
}

/**
 * Position with state tracking for DUST/RESOLVED exclusion
 */
export interface TrackedPosition {
  tokenId: string;
  marketId: string;
  outcome: OrderOutcome;
  state: PositionState;
  size: number;
  costBasis: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  bestBid: number; // For executable value reconciliation
  entryTime: number;
  lastUpdate: number;
}

/**
 * Allowance tracking with token type awareness
 */
export interface AllowanceInfo {
  tokenType: TokenType;
  tokenId?: string; // For CONDITIONAL tokens
  allowance: number;
  balance: number;
  lastCheck: number;
  lastRejectReason?: string;
}

/**
 * Strategy kill switch state
 */
export interface StrategyKillSwitch {
  strategyId: StrategyId;
  killed: boolean;
  reason?: string;
  killedAt?: number;
}

/**
 * PnL reconciliation result
 */
export interface ReconciliationResult {
  tokenId: string;
  reportedPnl: number;
  executableValue: number; // bestBid * size
  discrepancy: number;
  discrepancyPct: number;
  flagged: boolean;
  halted: boolean;
}

export interface TradeLogEntry {
  timestamp: number;
  strategyId: StrategyId;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  size: number;
  price: number;
  sizeUsd: number;
  riskDecision: RiskDecision;
  result: OrderResult;
  allowancePath?: string; // COLLATERAL or CONDITIONAL path used
}
