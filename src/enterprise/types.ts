/**
 * Enterprise Trading System Types
 *
 * Core type definitions for the enterprise-grade trading system.
 */

/**
 * Position lifecycle states
 */
export type PositionState = "OPEN" | "PARTIAL" | "CLOSING" | "CLOSED" | "DUST";

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
  | "AUTO_SELL"
  | "STOP_LOSS"
  | "HEDGE"
  | "MANUAL";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "POST_ONLY" | "IOC" | "FOK" | "MARKET";
export type OrderOutcome = "YES" | "NO";

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

export interface CooldownEntry {
  tokenId: string;
  cooldownUntil: number;
  reason: string;
  attempts: number;
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
}
