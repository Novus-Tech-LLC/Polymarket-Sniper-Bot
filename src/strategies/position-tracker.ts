import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { Contract, type Wallet } from "ethers";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI } from "../trading/exchange-abi";
import { EntryMetaResolver } from "./entry-meta-resolver";
import {
  LogDeduper,
  HEARTBEAT_INTERVAL_MS,
  TRACKER_HEARTBEAT_MS,
} from "../utils/log-deduper.util";
import {
  formatCents,
  isNearResolution,
  NEAR_RESOLUTION_THRESHOLD_DOLLARS,
} from "../utils/price.util";
import { extractOrderbookPrices } from "../utils/post-order.util";

/**
 * Position status indicating tradability
 */
export type PositionStatus =
  | "ACTIVE"
  | "REDEEMABLE"
  | "RESOLVED"
  | "DUST"
  | "NO_BOOK";

/**
 * Book status indicating orderbook availability for execution.
 * Used to track why a position cannot be traded on CLOB.
 *
 * IMPORTANT: This is metadata only - a position can be ACTIVE even with
 * NO_BOOK_404 or EMPTY_BOOK. Orderbook status does NOT determine position state.
 */
export type BookStatus =
  | "AVAILABLE" // Orderbook exists with valid bids/asks
  | "EMPTY_BOOK" // Orderbook exists but no bids/asks
  | "NO_BOOK_404" // CLOB returned 404 for this tokenId
  | "BOOK_ANOMALY" // Orderbook has anomalies (crossed book, extreme spread)
  | "NOT_FETCHED"; // Orderbook not fetched (e.g., redeemable positions)

/**
 * Execution status indicating tradability on CLOB.
 * Derived from BookStatus - used by strategies to quickly filter.
 */
export type ExecutionStatus =
  | "TRADABLE" // Can execute on CLOB
  | "NOT_TRADABLE_ON_CLOB" // Cannot execute on CLOB (404, empty, anomaly)
  | "EXECUTION_BLOCKED"; // Temporarily blocked (cooldown, circuit breaker)

/**
 * STRICT POSITION STATE MACHINE (Jan 2025 Refactor)
 *
 * NON-NEGOTIABLE STATE DEFINITIONS:
 *
 * ACTIVE:
 *   - Default state for all positions with shares > 0
 *   - Position remains ACTIVE unless we have EXPLICIT PROOF it's REDEEMABLE
 *   - Price near 1.0 does NOT imply resolved
 *   - Empty orderbook does NOT imply resolved
 *   - Gamma "winner" metadata does NOT imply redeemable (only market closed)
 *
 * REDEEMABLE:
 *   - Only if EITHER:
 *     (a) Data-API positions payload explicitly flags redeemable=true, OR
 *     (b) On-chain ConditionalTokens.payoutDenominator(conditionId) > 0
 *   - DO NOT infer from price ≈ 1.0
 *   - DO NOT infer from empty orderbook
 *   - DO NOT infer from Gamma "winner" field alone
 *
 * CLOSED_NOT_REDEEMABLE:
 *   - Market is closed/ended (Gamma says closed=true or end_date passed)
 *   - BUT on-chain resolution not yet posted (payoutDenominator == 0)
 *   - Trading strategies should STOP acting, but NOT treat as redeemable
 *
 * UNKNOWN:
 *   - Cannot map tokenId -> conditionId
 *   - Cannot fetch required metadata
 *   - Keep as ACTIVE for safety but mark pnlTrusted=false
 */
export type PositionState =
  | "ACTIVE"
  | "REDEEMABLE"
  | "CLOSED_NOT_REDEEMABLE"
  | "UNKNOWN";

/**
 * Source of REDEEMABLE determination.
 * Used for auditing and debugging incorrect classifications.
 */
export type RedeemableProofSource =
  | "DATA_API_FLAG" // Data-API positions endpoint returned redeemable=true
  | "ONCHAIN_DENOM" // On-chain payoutDenominator > 0
  | "NONE"; // Not redeemable - for auditing

/**
 * P&L Classification for strategy decision-making.
 *
 * CRITICAL: Strategies MUST NOT act on positions with UNKNOWN classification.
 * The classification is ONLY valid when pnlTrusted === true.
 */
export type PnLClassification =
  | "PROFITABLE" // pnlTrusted && pnlPct > 0
  | "LOSING" // pnlTrusted && pnlPct < 0
  | "NEUTRAL" // pnlTrusted && pnlPct === 0
  | "UNKNOWN"; // pnlTrusted === false (missing cost basis or mark price)

/**
 * Source of P&L data indicating where the values came from.
 * Used to understand data quality and debugging.
 */
export type PnLSource =
  | "DATA_API" // P&L from Data API (cashPnl, percentPnl) - matches UI
  | "EXECUTABLE_BOOK" // P&L computed from CLOB best bid (executable mark)
  | "FALLBACK"; // P&L from fallback price API (less accurate)

/**
 * Cached outcome data for a tokenId
 * Used to prevent redundant Gamma API calls and log spam
 */
export interface OutcomeCacheEntry {
  winner: string | null;
  resolvedPrice: number; // 1.0 for win, 0.0 for loss, -1 if not resolved
  resolvedAtMs: number; // Timestamp when resolved, 0 if not resolved
  lastCheckedMs: number; // Last time we checked this outcome
  status: "ACTIVE" | "RESOLVED";
}

/**
 * Last logged state for a tokenId
 * Used to prevent repeated logging of the same state
 */
export interface LastLoggedState {
  status: "ACTIVE" | "RESOLVED";
  winner: string | null;
  priceCents: number;
}

/**
 * Metrics counters for PositionTracker refresh cycles
 */
export interface RefreshMetrics {
  gammaRequestsPerRefresh: number;
  tokenIdsFetched: number;
  cacheHits: number;
  cacheMisses: number;
  resolvedCacheHits: number;
}

/**
 * SNAPSHOT VALIDATION FAILURE REASONS
 *
 * Used to diagnose why a new snapshot was rejected during two-phase commit.
 * Each reason triggers specific diagnostic logging.
 */
export type SnapshotValidationFailure =
  | "ACTIVE_COLLAPSE_BUG" // raw_total > 0 && raw_active > 0 but final active = 0
  | "FETCH_REGRESSION" // new total < 20% of previous (suspicious drop)
  | "ADDRESS_FLIP_COLLAPSE" // address changed AND position counts collapsed
  | "SUSPICIOUS_SHRINK" // catastrophic drop: rawTotal < 25% of lastGood when lastGood >= 20
  | "ACTIVE_WIPEOUT"; // lastGood.active >= 10 AND new.active == 0 AND new.rawTotal > 0

/**
 * Result of snapshot validation check.
 * Used by validateSnapshot() to determine if a new snapshot should be published.
 */
export interface SnapshotValidationResult {
  /** Whether the snapshot passed validation */
  ok: boolean;
  /** Reason for failure (only set when ok === false) */
  reason?: SnapshotValidationFailure;
  /** Diagnostic details for logging */
  diagnostics?: string;
}

/**
 * Circuit breaker entry for a specific tokenId.
 * Tracks failing API calls to prevent thrashing.
 */
export interface CircuitBreakerEntry {
  /** Unix timestamp (ms) when first failure occurred in current window */
  firstFailureAtMs: number;
  /** Count of failures in current window */
  failureCount: number;
  /** Unix timestamp (ms) when circuit breaker opened (cooldown started) */
  openedAtMs: number;
  /** Last known price (Data-API) to use during cooldown */
  lastKnownPrice?: number;
  /** Error type that triggered the circuit breaker */
  errorType: "404" | "422" | "TIMEOUT" | "NETWORK" | "OTHER";
}

/**
 * Reset level for PositionTracker self-heal.
 * SOFT_RESET: Clear transient caches, clear in-flight promise
 * HARD_RESET: Also recreate HTTP clients, clear all mapping caches
 */
export type ResetLevel = "SOFT_RESET" | "HARD_RESET";

/**
 * Self-heal event for watchdog monitoring
 */
export interface SelfHealEvent {
  timestamp: number;
  level: ResetLevel;
  reason: string;
  previousFailures: number;
  staleAgeMs: number;
}

/**
 * Summary of position counts for a portfolio snapshot.
 * All strategies must use this for consistent reporting.
 */
export interface PortfolioSummary {
  /** Total active (non-redeemable) positions */
  activeTotal: number;
  /** Active positions with pnlClassification === PROFITABLE */
  prof: number;
  /** Active positions with pnlClassification === LOSING */
  lose: number;
  /** Active positions with pnlClassification === NEUTRAL */
  neutral: number;
  /** Active positions with pnlClassification === UNKNOWN (pnlTrusted=false) */
  unknown: number;
  /** Total redeemable positions */
  redeemableTotal: number;
}

/**
 * IMMUTABLE PORTFOLIO SNAPSHOT
 *
 * This is the single source of truth for position data during one orchestrator cycle.
 * Created by PositionTracker.refresh() and passed to all strategies.
 *
 * NON-NEGOTIABLE RULES:
 * 1. Snapshot is created ONCE per orchestrator cycle
 * 2. All strategies MUST use the same snapshot within a cycle
 * 3. No strategy may independently refresh or fetch positions
 * 4. Arrays are frozen to prevent mutation
 *
 * CRASH-PROOF RECOVERY (Jan 2025):
 * - If snapshot.stale === true, the snapshot is from lastGoodSnapshot fallback
 * - staleAgeMs indicates how old the data is
 * - Strategies should still operate but may log a warning
 */
export interface PortfolioSnapshot {
  /** Unique identifier for this snapshot's orchestrator cycle */
  cycleId: number;
  /** The address used to fetch positions (proxy or EOA) */
  addressUsed: string;
  /** Unix timestamp (ms) when this snapshot was created */
  fetchedAtMs: number;
  /** Active (non-redeemable) positions - FROZEN array */
  activePositions: readonly Position[];
  /** Redeemable positions - FROZEN array */
  redeemablePositions: readonly Position[];
  /** Summary counts for logging and diagnostics */
  summary: PortfolioSummary;
  /** Raw counts from API before filtering (for ACTIVE_COLLAPSE_BUG diagnostics) */
  rawCounts?: {
    rawTotal: number;
    rawActiveCandidates: number;
    rawRedeemableCandidates: number;
  };
  /** Classification reasons for filtered positions (for diagnostics) */
  classificationReasons?: Map<string, number>;
  /**
   * CRASH-PROOF RECOVERY: Whether this snapshot is stale (from lastGoodSnapshot fallback).
   * Set to true when refresh fails and we fall back to the last known-good snapshot.
   * Downstream strategies should still operate but may log a warning.
   */
  stale?: boolean;
  /**
   * CRASH-PROOF RECOVERY: Age of the snapshot in milliseconds since it was created.
   * Only set when stale === true. Computed as: now - originalFetchedAtMs
   */
  staleAgeMs?: number;
  /**
   * CRASH-PROOF RECOVERY: Reason for staleness (why refresh failed or validation rejected).
   * Only set when stale === true.
   */
  staleReason?: string;
}

export interface Position {
  marketId: string;
  tokenId: string;
  side: string; // Outcome name (e.g., "YES", "NO" for binary markets, or "Medjedovic", "Under" for multi-outcome markets)
  size: number;
  entryPrice: number;
  currentPrice: number; // Mark price for P&L: uses BEST BID for active positions (what we can sell at)
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean; // True if market is resolved/closed
  marketEndTime?: number; // Market close time (Unix timestamp ms) - used for near-close hedging behavior
  /**
   * Best bid price from CLOB orderbook (what we can sell at)
   * This is the CANONICAL mark price for active positions.
   * undefined if no orderbook available (NO_BOOK status)
   */
  currentBidPrice?: number;
  /**
   * Best ask price from CLOB orderbook (what we would pay to buy)
   * Used for cost basis calculations and spread analysis.
   * undefined if no orderbook available
   */
  currentAskPrice?: number;
  /**
   * Position status for strategy routing:
   * - ACTIVE: Can be traded, has valid orderbook
   * - NO_BOOK: Active market but no orderbook data available (use fallback pricing)
   * - REDEEMABLE/RESOLVED: Market resolved, route to AutoRedeem
   * - DUST: Position too small to trade profitably
   */
  status?: PositionStatus;
  /**
   * Age of the orderbook cache in milliseconds
   * Used for debugging stale data issues
   */
  cacheAgeMs?: number;

  // === P&L TRUST SYSTEM ===
  // Strategies MUST check pnlTrusted before making any P&L-based decisions.
  // Acting on untrusted P&L can cause financial loss (selling winners, keeping losers).

  /**
   * Whether the P&L calculation can be trusted for decision-making.
   *
   * P&L is UNTRUSTED (false) when:
   * - Cost basis cannot be determined from trade history
   * - No orderbook bids available (mark price unknown)
   * - Price data is stale or contradictory
   *
   * CRITICAL: SmartHedging, ScalpTakeProfit, and StopLoss MUST skip
   * positions where pnlTrusted === false.
   */
  pnlTrusted: boolean;

  /**
   * The classification of this position for strategy routing.
   * ONLY VALID when pnlTrusted === true.
   *
   * - PROFITABLE: pnlPct > 0 (candidate for ScalpTakeProfit)
   * - LOSING: pnlPct < 0 (candidate for SmartHedging, StopLoss)
   * - NEUTRAL: pnlPct === 0 (breakeven)
   * - UNKNOWN: pnlTrusted === false (DO NOT ACT)
   */
  pnlClassification: PnLClassification;

  /**
   * Reason why P&L is untrusted (only set when pnlTrusted === false).
   * Used for diagnostics and rate-limited logging.
   */
  pnlUntrustedReason?: string;

  // === ENTRY METADATA (from EntryMetaResolver) ===
  // These fields are derived from trade history API, NOT from container uptime.
  // See entry-meta-resolver.ts for details on why uptime-based tracking is wrong.

  /**
   * Weighted average entry price in cents (e.g., 65.5 for 65.5¢)
   * Computed from trade history using weighted average method.
   * undefined if entry metadata could not be resolved from trade history.
   */
  avgEntryPriceCents?: number;

  /**
   * Timestamp (ms) when the position was first acquired.
   * This is the timestamp of the oldest BUY that contributes to the current position.
   * Derived from trade history API - survives container restarts.
   * undefined if entry metadata could not be resolved from trade history.
   */
  firstAcquiredAt?: number;

  /**
   * Timestamp (ms) when the position was last increased (most recent BUY).
   * Derived from trade history API - survives container restarts.
   * undefined if entry metadata could not be resolved from trade history.
   */
  lastAcquiredAt?: number;

  /**
   * Time held in seconds, computed as now - firstAcquiredAt (or lastAcquiredAt if configured).
   * CRITICAL: This is derived from trade history timestamps, NOT from container uptime.
   * This value is stable across container restarts because it uses actual trade timestamps.
   * undefined if entry metadata could not be resolved from trade history.
   */
  timeHeldSec?: number;

  /**
   * Cache age of the entry metadata in milliseconds.
   * Used for debugging to prove the data is not stale.
   */
  entryMetaCacheAgeMs?: number;

  // === DATA-API P&L FIELDS (UI-TRUTH) ===
  // These fields come directly from Polymarket Data API /positions endpoint
  // and represent what the Polymarket UI shows to users.

  /**
   * Source of P&L values - indicates where pnlPct and pnlUsd came from.
   * - DATA_API: Direct from Data API (matches Polymarket UI)
   * - EXECUTABLE_BOOK: Computed from CLOB best bid (more accurate for execution)
   * - FALLBACK: Computed from fallback price API (least accurate)
   */
  pnlSource?: PnLSource;

  /**
   * P&L values from Data API (when available).
   * These match what Polymarket UI shows and should be treated as UI-truth.
   */
  dataApiPnlUsd?: number; // cashPnl from Data API
  dataApiPnlPct?: number; // percentPnl from Data API
  dataApiCurPrice?: number; // curPrice from Data API (current market price)
  dataApiCurrentValue?: number; // currentValue from Data API (size * curPrice)
  dataApiInitialValue?: number; // initialValue from Data API (size * avgPrice)

  /**
   * Executable P&L computed from CLOB orderbook (optional enhancement).
   * Uses best bid for selling positions - what we can actually realize.
   */
  executablePnlUsd?: number;
  executableMarkCents?: number;

  /**
   * The conditionId (market identifier) from Data API.
   * Distinct from marketId which may be the same but tracked separately.
   */
  conditionId?: string;

  // === STRICT STATE MACHINE FIELDS (Jan 2025 Refactor) ===
  // These fields implement the non-negotiable state definitions.

  /**
   * Strict position state using authoritative sources only.
   * See PositionState type definition for state meanings.
   *
   * CRITICAL: Only REDEEMABLE if proven via DATA_API_FLAG or ONCHAIN_DENOM.
   * NEVER infer REDEEMABLE from price, orderbook, or Gamma winner.
   */
  positionState?: PositionState;

  /**
   * Source of REDEEMABLE proof (only set when positionState === "REDEEMABLE").
   * Used for auditing and debugging incorrect classifications.
   */
  redeemableProofSource?: RedeemableProofSource;

  /**
   * Whether the market is closed (ended) but not yet redeemable on-chain.
   * Set to true when Gamma says closed=true or market end_date passed,
   * but on-chain payoutDenominator is 0 or unknown.
   *
   * Trading strategies should STOP acting on these positions.
   */
  marketClosed?: boolean;

  // === NEAR-RESOLUTION CANDIDATE (Jan 2025 Fix) ===
  // Used to prevent hedging/liquidation of near-resolution winners.

  /**
   * Whether this position is a near-resolution candidate.
   *
   * Set to true when:
   * - currentPrice >= 99.5¢ (NEAR_RESOLUTION_THRESHOLD_DOLLARS)
   * - currentPrice >= 50¢ (safety guard - NEAR_RESOLUTION_MIN_PRICE_DOLLARS)
   * - redeemable is false
   *
   * SmartHedging MUST NOT hedge or liquidate positions where this is true.
   * Instead, wait for resolution or use sell-early module if configured.
   *
   * CRITICAL SAFETY GUARD: Prices < 50¢ are NEVER classified as near-resolution.
   * This prevents false positives from broken/stale orderbook data.
   */
  nearResolutionCandidate?: boolean;

  // === ORDERBOOK STATUS FIELDS (Jan 2025 Fix - Decouple from snapshot) ===
  // These fields track orderbook availability WITHOUT affecting position classification.
  // Positions remain ACTIVE even if orderbook returns 404 or is empty.

  /**
   * Orderbook status for this position.
   * Used to track why orderbook data may be unavailable.
   *
   * IMPORTANT: This does NOT affect position state (ACTIVE/REDEEMABLE).
   * A position can be ACTIVE with NO_BOOK_404 - it just can't be executed on CLOB.
   */
  bookStatus?: BookStatus;

  /**
   * Execution status derived from bookStatus.
   * Strategies should check this to determine if position can be traded on CLOB.
   *
   * - TRADABLE: Orderbook available with valid bids
   * - NOT_TRADABLE_ON_CLOB: No orderbook or no bids - cannot execute
   * - EXECUTION_BLOCKED: Temporarily blocked (cooldown, circuit breaker)
   */
  executionStatus?: ExecutionStatus;

  /**
   * Whether the executable price (bestBid) can be trusted for execution decisions.
   * False when bookStatus is NO_BOOK_404, EMPTY_BOOK, or BOOK_ANOMALY.
   *
   * CRITICAL: Strategies MUST NOT attempt execution when this is false.
   * P&L calculations can still use Data-API prices (pnlTrusted may still be true).
   */
  execPriceTrusted?: boolean;
}

// Price display constants
const PRICE_TO_CENTS_MULTIPLIER = 100;

// Default thresholds for liquidation candidate filtering
// Used by getLiquidationCandidates and getLiquidationCandidatesValue methods
export const DEFAULT_LIQUIDATION_MIN_LOSS_PCT = 10;
export const DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS = 60;

export interface PositionTrackerConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  refreshIntervalMs?: number;
}

/**
 * Tracks current positions and their P&L
 * Provides data to Quick Flip and Auto-Sell strategies
 */
export class PositionTracker {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positions: Map<string, Position> = new Map();
  private positionEntryTimes: Map<string, number> = new Map(); // Track when positions first appeared
  private positionLastSeen: Map<string, number> = new Map(); // Track when positions were last seen
  private refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private isRefreshing: boolean = false; // Prevent concurrent refreshes
  private currentRefreshPromise: Promise<void> | null = null; // Awaitable refresh promise for single-flight
  private missingOrderbooks = new Set<string>(); // Cache tokenIds with no orderbook to avoid repeated API calls
  private loggedFallbackPrices = new Set<string>(); // Cache tokenIds for which we've already logged fallback price (suppress repeated logs)
  // Cache market outcomes persistently across refresh cycles. Resolved markets cannot change their outcome,
  // so caching is safe and prevents redundant Gamma API calls on every 30-second refresh.
  // Note: Only successful outcomes are cached; null values from transient errors are not cached.
  // Maximum cache size is enforced to prevent unbounded memory growth in long-running processes.
  private marketOutcomeCache: Map<string, string> = new Map();
  private static readonly MAX_OUTCOME_CACHE_SIZE = 1000; // Maximum number of cached market outcomes
  private lastRefreshStats: {
    resolved: number;
    active: number;
    skipped: number;
  } = { resolved: 0, active: 0, skipped: 0 }; // Track stats for summary logging

  // Flag to track whether historical entry times have been loaded from API
  // This prevents immediate sells on container restart by ensuring we know actual entry times
  private historicalEntryTimesLoaded: boolean = false;

  // === PROXY WALLET / HOLDING ADDRESS RESOLUTION ===
  // Positions are held by proxy wallet, not EOA. Cache the resolved holding address.
  private cachedHoldingAddress: string | null = null;
  private cachedEOAAddress: string | null = null; // Track EOA for address probing
  private holdingAddressCacheMs = 0;
  private static readonly HOLDING_ADDRESS_CACHE_TTL_MS = 300_000; // 5 minutes TTL
  private addressProbeCompleted = false; // Track if address probe has been done

  // === STICKY ADDRESS SELECTION (Jan 2025) ===
  // Prevents address flip-flopping by keeping the selected address sticky for a minimum duration
  // Address will only switch if:
  //   1. Current address returns 0 positions for CONSECUTIVE_ZERO_THRESHOLD consecutive refreshes, OR
  //   2. Alternate address returns >= (current * ADDRESS_SWITCH_RATIO_THRESHOLD) positions, OR
  //   3. User explicitly forces proxy/EOA in config
  private addressStickySince: number = 0; // Timestamp when current address became sticky
  private consecutiveZeroRefreshes: number = 0; // Track consecutive refreshes with 0 positions
  private static readonly ADDRESS_STICKY_DURATION_MS = 600_000; // 10 minutes sticky duration
  private static readonly CONSECUTIVE_ZERO_THRESHOLD = 2; // 2 consecutive 0-position refreshes to switch
  private static readonly ADDRESS_SWITCH_RATIO_THRESHOLD = 3; // Alternate must return 3x more positions
  private static readonly SUSPICIOUS_SHRINK_THRESHOLD = 0.25; // 25% of lastGood is suspicious
  private static readonly MIN_POSITIONS_FOR_SHRINK_CHECK = 20; // Only check shrink if lastGood >= 20
  private static readonly MIN_ACTIVE_FOR_WIPEOUT_CHECK = 10; // Only check wipeout if lastGood.active >= 10

  // Cache market end times (Unix timestamp ms). Market end times are fetched from Gamma API
  // and cached to avoid redundant API calls on every 30-second refresh cycle.
  // End times can change, so callers should be prepared to refetch or invalidate entries as needed.
  private marketEndTimeCache: Map<string, number> = new Map();
  private static readonly MAX_END_TIME_CACHE_SIZE = 1000;

  // Enhanced outcome cache: stores detailed outcome data per tokenId with TTL management
  // - RESOLVED outcomes are cached indefinitely (winner won't change)
  // - ACTIVE outcomes have configurable TTL (default 30s)
  private outcomeCache: Map<string, OutcomeCacheEntry> = new Map();
  private static readonly ACTIVE_OUTCOME_CACHE_TTL_MS = 30000; // 30 seconds for active market outcomes
  private static readonly MAX_OUTCOME_CACHE_ENTRIES = 2000;

  // Track last logged state per tokenId to prevent repeated logging of the same state
  private lastLoggedState: Map<string, LastLoggedState> = new Map();

  // Metrics for the current refresh cycle
  private currentRefreshMetrics: RefreshMetrics = {
    gammaRequestsPerRefresh: 0,
    tokenIdsFetched: 0,
    cacheHits: 0,
    cacheMisses: 0,
    resolvedCacheHits: 0,
  };

  // Rate limiting for "refresh already in progress" log
  private lastSkipRefreshLogAt = 0;
  private static readonly SKIP_REFRESH_LOG_INTERVAL_MS = 60000; // Log at most once per 60s

  // Minimum refresh interval to prevent API hammering
  private lastRefreshCompletedAt = 0;
  private static readonly MIN_REFRESH_INTERVAL_MS = 5000; // 5 seconds between refreshes

  // Batch size for Gamma API requests (limit URL length)
  private static readonly GAMMA_BATCH_SIZE = 25; // Max tokenIds per Gamma request

  // === LOG DEDUPLICATION ===
  // Shared LogDeduper for rate-limiting and deduplicating logs
  private logDeduper = new LogDeduper();
  // Track last logged position counts for change detection
  private lastLoggedPositionCount = -1;

  // === CYCLE-AWARE LOG DEDUPLICATION ===
  // Prevents logging more than once per orchestrator cycle
  private lastProcessedLogCycleId: number = -1;
  private lastProcessedLogFingerprint: string | null = null;
  private lastProcessedLoggedAt: number = 0;
  // Track last cycle ID for single-flight refresh within same cycle
  private lastRefreshCycleId: number = -1;
  private lastRefreshCyclePromise: Promise<void> | null = null;

  // === IMMUTABLE PORTFOLIO SNAPSHOT ===
  // Created after each refresh, consumed by strategies via getSnapshot()
  // This ensures all strategies operate on the same position data within a cycle
  private lastSnapshot: PortfolioSnapshot | null = null;
  private lastSnapshotCycleId: number = -1;

  // === RAW COUNTS FOR DIAGNOSTICS ===
  // Track raw counts from last API fetch for ACTIVE_COLLAPSE_BUG detection
  private lastRawCounts: {
    rawTotal: number;
    rawActiveCandidates: number;
    rawRedeemableCandidates: number;
  } = { rawTotal: 0, rawActiveCandidates: 0, rawRedeemableCandidates: 0 };
  private lastClassificationReasons: Map<string, number> = new Map();

  // === ADDRESS STABILITY TRACKING ===
  // Track address changes to detect unstable address selection
  private lastSelectedAddress: string | null = null;
  private addressChangeLoggedAt: number = 0;
  private static readonly ADDRESS_CHANGE_LOG_COOLDOWN_MS = 300_000; // Log address change at most once per 5 min

  // === CRASH-PROOF RECOVERY (Jan 2025) ===
  // Two-phase commit: never replace good snapshot with failed/empty one
  // Last known-good snapshot for fallback when refresh fails
  private lastGoodSnapshot: PortfolioSnapshot | null = null;
  private lastGoodAtMs: number = 0;
  private lastErrorAtMs: number = 0;
  private consecutiveFailures: number = 0;
  private currentBackoffMs: number = 0;
  private static readonly MAX_BACKOFF_MS = 120_000; // 2 minutes max backoff
  private static readonly BASE_BACKOFF_MS = 5_000; // 5 seconds base backoff
  private static readonly FETCH_REGRESSION_THRESHOLD = 0.2; // 20% - below this is suspicious
  private static readonly MAX_STALE_AGE_MS = 30_000; // 30 seconds - HFT requires fresh data

  // === SELF-HEALING CONSTANTS (HFT-TIGHT) ===
  // Bounded failure policy to prevent infinite degraded mode
  private static readonly MAX_CONSECUTIVE_FAILURES = 5; // Trigger self-heal after 5 failures (HFT-tight)
  private static readonly MAX_DEGRADED_DURATION_MS = 120_000; // 2 minutes max in degraded mode before HARD_RESET
  private static readonly REFRESH_WATCHDOG_TIMEOUT_MS = 15_000; // 15 seconds max for a refresh cycle
  private static readonly RECOVERY_MODE_MAX_CYCLES = 3; // Exit recovery mode after 3 successful cycles
  private static readonly HEALTH_STATUS_LOG_INTERVAL_MS = 300_000; // Log health status every 5 minutes
  private static readonly MINIMAL_ACCEPTANCE_MAX_RAW_COUNT = 5; // Max raw count for minimal acceptance rule

  // === SELF-HEALING STATE ===
  private degradedModeEnteredAt: number = 0; // Timestamp when degraded mode started
  private recoveryMode: boolean = false; // When true, relax validation temporarily
  private recoveryCycleCount: number = 0; // Count successful cycles in recovery mode
  private lastSelfHealAt: number = 0; // Timestamp of last self-heal trigger
  private selfHealCount: number = 0; // Total self-heal events for diagnostics
  private lastHealthStatusLogAt: number = 0; // For periodic health logging
  private refreshAbortController: AbortController | null = null; // For aborting stuck refreshes

  /**
   * AUTO-RECOVERY BOOTSTRAP: When true, the next refresh will skip ACTIVE_COLLAPSE_BUG
   * validation to allow recovery similar to a container restart.
   *
   * Set when: Auto-recovery triggers because stale age >= MAX_STALE_AGE_MS (30 seconds for HFT).
   *           This clears lastGoodSnapshot and enables bootstrap mode.
   * Cleared when: A snapshot is successfully accepted (validation passes or bypassed).
   *
   * Why needed: After auto-recovery clears lastGoodSnapshot, the next snapshot may still
   * trigger ACTIVE_COLLAPSE_BUG. Without bootstrap mode, the service would be stuck in
   * a loop where every refresh fails with "NO lastGoodSnapshot available!"
   *
   * Safety: Bootstrap mode only allows ONE snapshot through before being cleared.
   * If that snapshot is later replaced by a valid one, normal validation resumes.
   */
  private allowBootstrapAfterAutoRecovery: boolean = false;

  // Circuit breaker for spammy failing calls per tokenId
  private circuitBreaker: Map<string, CircuitBreakerEntry> = new Map();
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3; // failures before opening
  private static readonly CIRCUIT_BREAKER_WINDOW_MS = 30_000; // 30s failure window
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 60s cooldown when open
  private static readonly MAX_CIRCUIT_BREAKER_ENTRIES = 500;

  // Track last validation failure for rate-limited logging
  private lastValidationFailureLoggedAt: number = 0;
  private lastValidationFailureReason: string | null = null;
  private static readonly VALIDATION_FAILURE_LOG_INTERVAL_MS = 60_000; // Log at most once per minute

  /**
   * Orderbook cache with TTL for accurate P&L calculation
   * Stores best bid/ask per tokenId with timestamp for staleness detection
   *
   * WHY PREVIOUS P&L SHOWED 0.0% AND ALL LOSING:
   * The old code used mid-price ((bestBid + bestAsk) / 2) for P&L calculations.
   * For sell-to-realize-profit scenarios, we MUST use the BEST BID - what we can actually sell at.
   * Using mid-price caused:
   * 1. Overestimation of position value when spread is wide
   * 2. 0.0% readings when mid-price happened to equal entry price
   * 3. All positions appearing as losing when bid was significantly below mid
   *
   * FIX: Now we use BEST BID as the mark price for active positions.
   */
  private orderbookCache: Map<
    string,
    {
      bestBid: number;
      bestAsk: number;
      fetchedAt: number; // Unix timestamp ms
    }
  > = new Map();
  private static readonly ORDERBOOK_CACHE_TTL_MS = 2000; // 2 seconds for active trading
  private static readonly POSITION_BALANCE_CACHE_TTL_MS = 5000; // 5 seconds for position balances
  private static readonly MAX_ORDERBOOK_CACHE_SIZE = 500;

  // API timeout constant for external API calls
  private static readonly API_TIMEOUT_MS = 10000; // 10 seconds

  // Pagination settings for loading historical trade data from wallet
  // PAGE_LIMIT: Maximum trades per API request (API max is 500)
  // MAX_PAGES: Safety limit to prevent infinite loops (500 * 20 = 10,000 trades max)
  private static readonly TRADES_PAGE_LIMIT = 500;
  private static readonly TRADES_MAX_PAGES = 20;

  // Threshold for determining market winner from outcomePrices
  // Price > 0.5 indicates the likely winner in resolved markets
  private static readonly WINNER_THRESHOLD = 0.5;

  // Threshold for detecting resolved positions by price
  // UPDATED: Use centralized NEAR_RESOLUTION_THRESHOLD_DOLLARS (0.995 = 99.5¢)
  // Prices >= 99.5¢ (high) or <= 0.5¢ (low) indicate likely resolved markets
  // This helps detect redeemable positions even when API doesn't mark them as redeemable
  // NOTE: We use the centralized threshold constant for consistency across modules
  private static readonly RESOLVED_PRICE_HIGH_THRESHOLD =
    NEAR_RESOLUTION_THRESHOLD_DOLLARS; // 0.995 (99.5¢)
  private static readonly RESOLVED_PRICE_LOW_THRESHOLD = 0.005; // 0.5¢ (inverse of 99.5¢)

  // P&L sanity check thresholds
  // Used to detect TOKEN_MISMATCH_OR_BOOK_FETCH_BUG:
  // If bid is near zero but market appears liquid (mid > threshold, spread < threshold)
  private static readonly SANITY_CHECK_BID_NEAR_ZERO = 0.001; // Bid below 0.1¢ considered "near zero"
  private static readonly SANITY_CHECK_MID_PRICE_MIN = 0.1; // Mid-price > 10¢ suggests active market
  private static readonly SANITY_CHECK_MAX_SPREAD = 0.2; // Spread < 20¢ suggests liquid market

  // Rate-limit P&L summary logging to avoid log spam (refreshes every 5s)
  private lastPnlSummaryLogAt = 0;
  private lastLoggedPnlCounts = {
    profitable: 0,
    losing: 0,
    neutral: 0,
    unknown: 0,
    redeemable: 0,
  };
  private static readonly PNL_SUMMARY_LOG_INTERVAL_MS = 60_000; // Log at most once per minute

  // === P&L CONSISTENCY THRESHOLDS ===
  // Used to detect and handle discrepancies between Data-API P&L and price-derived P&L.
  // ROUNDING_TOLERANCE_PCT: Tiny differences (<0.5%) are ignored as floating-point noise.
  // WARNING_THRESHOLD_PCT: Differences >2% logged as warnings but P&L still trusted.
  // UNTRUSTED_THRESHOLD_PCT: Differences >10% mark P&L as untrusted (material discrepancy).
  private static readonly PNL_ROUNDING_TOLERANCE_PCT = 0.5; // Ignore differences < 0.5%
  private static readonly PNL_WARNING_THRESHOLD_PCT = 2.0; // Log warning if > 2%
  private static readonly PNL_UNTRUSTED_THRESHOLD_PCT = 10.0; // Mark untrusted if > 10%

  // EntryMetaResolver for stateless entry metadata from trade history
  // WHY THIS EXISTS: Container restarts used to reset the "time held" clock.
  // Now we derive entry timestamps from the trade history API, which survives restarts.
  private entryMetaResolver: EntryMetaResolver;

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default

    // Initialize EntryMetaResolver for stateless entry metadata computation
    this.entryMetaResolver = new EntryMetaResolver({
      logger: config.logger,
      cacheTtlMs: 90_000, // 90 second cache TTL
      apiTimeoutMs: 10_000,
      maxPagesPerToken: 10,
      tradesPerPage: 500,
      useLastAcquiredForTimeHeld: false, // Use firstAcquiredAt by default
    });
  }

  /**
   * Resolve the holding address for positions.
   *
   * On Polymarket, positions and USDC are held by a PROXY WALLET, not the EOA.
   * This method fetches the proxy wallet address from the Gamma public profile API
   * and uses it as the holding address for all position fetching.
   *
   * NON-NEGOTIABLE RULE #1: Address correctness (proxy-first)
   * - Determine holding address every refresh
   * - Call Gamma public profile endpoint to fetch proxy wallet for EOA
   * - holdingAddress = proxyAddress ?? wallet.address
   *
   * @returns The holding address (proxy wallet if available, otherwise EOA)
   */
  async resolveHoldingAddress(): Promise<string> {
    const { resolveSignerAddress } =
      await import("../utils/funds-allowance.util");
    const signerAddress = resolveSignerAddress(this.client);

    // Always cache EOA for address probing
    this.cachedEOAAddress = signerAddress;

    // Validate signer address
    const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(signerAddress);
    if (!isValidAddress) {
      this.logger.warn(
        `[PositionTracker] Invalid signer address "${signerAddress}" - cannot resolve holding address`,
      );
      return signerAddress; // Return as-is (will fail downstream)
    }

    // Check cache
    const now = Date.now();
    if (
      this.cachedHoldingAddress &&
      now - this.holdingAddressCacheMs <
        PositionTracker.HOLDING_ADDRESS_CACHE_TTL_MS
    ) {
      return this.cachedHoldingAddress;
    }

    try {
      // Fetch proxy wallet from Gamma public profile API
      // Uses GAMMA_PROFILE_ENDPOINT for consistency with other API endpoint constants
      interface ProfileResponse {
        proxyWallet?: string;
      }

      const profileUrl = POLYMARKET_API.GAMMA_PROFILE_ENDPOINT(signerAddress);
      const profile = await httpGet<ProfileResponse>(profileUrl, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      const proxyWallet = profile?.proxyWallet;
      const isValidProxy =
        proxyWallet && /^0x[a-fA-F0-9]{40}$/.test(proxyWallet);

      if (isValidProxy) {
        // Cache and use proxy wallet
        this.cachedHoldingAddress = proxyWallet;
        this.holdingAddressCacheMs = now;

        // Log once per refresh in required format
        if (
          this.logDeduper.shouldLog(
            "Tracker:holding_address",
            HEARTBEAT_INTERVAL_MS,
            proxyWallet,
          )
        ) {
          this.logger.info(
            `[PositionTracker] wallet=${signerAddress} proxy=${proxyWallet} using=${proxyWallet}`,
          );
        }
        return proxyWallet;
      }

      // No proxy wallet found - use EOA
      this.cachedHoldingAddress = signerAddress;
      this.holdingAddressCacheMs = now;

      if (
        this.logDeduper.shouldLog(
          "Tracker:holding_address_eoa",
          HEARTBEAT_INTERVAL_MS,
        )
      ) {
        this.logger.info(
          `[PositionTracker] wallet=${signerAddress} proxy=none using=${signerAddress}`,
        );
      }
      return signerAddress;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `[PositionTracker] Failed to fetch proxy wallet, using EOA: ${errMsg}`,
      );

      // Fall back to EOA but don't cache on error (retry next time)
      return this.cachedHoldingAddress ?? signerAddress;
    }
  }

  /**
   * Get the current holding address (cached).
   * Returns null if not yet resolved.
   */
  getHoldingAddress(): string | null {
    return this.cachedHoldingAddress;
  }

  /**
   * Start tracking positions
   * On startup, fetches historical entry times from the activity API to prevent
   * mass sells on container restart. Without historical data, we don't know when
   * positions were actually acquired and might trigger stop-loss/hedging immediately.
   *
   * OPTIMIZED STARTUP (Jan 2025):
   * By default, we now:
   * 1. Run refresh() FIRST to get current ACTIVE + REDEEMABLE positions
   * 2. Load historical entry times ONLY for those active positions (much faster)
   *
   * The old full-history scan is gated behind LOAD_FULL_TRADE_HISTORY_ON_START=true
   * for users who need it (e.g., very old positions or complete history).
   *
   * BACKWARD COMPATIBILITY NOTE:
   * When LOAD_FULL_TRADE_HISTORY_ON_START=true, we maintain the legacy order:
   * history first, then refresh(). This ensures identical behavior for users
   * who enable the flag.
   */
  async start(): Promise<void> {
    this.logger.info("[PositionTracker] Starting position tracking");

    // Check config flag for startup behavior
    const loadFullHistory =
      process.env.LOAD_FULL_TRADE_HISTORY_ON_START?.toLowerCase() === "true";

    // Legacy behavior: Load full wallet BUY history BEFORE refresh
    // This maintains backward compatibility for users who enable the flag
    if (loadFullHistory) {
      this.logger.info(
        "[PositionTracker] LOAD_FULL_TRADE_HISTORY_ON_START=true - loading full wallet trade history (legacy behavior)",
      );
      await this.loadHistoricalEntryTimes();
    }

    // Start initial refresh synchronously to ensure positions are available before strategies run
    // This is critical - without positions loaded, strategies can't identify what to sell/redeem
    try {
      await this.refresh();

      // Optimized path: Load entry times ONLY for active positions AFTER refresh
      // This is much faster than the full-history scan
      if (!loadFullHistory) {
        await this.loadHistoricalEntryTimesForPositions();
      }

      // Log positions without entry times (critical diagnostic)
      const positions = this.getPositions();
      const withoutEntryTime = positions.filter((p) => {
        const key = `${p.marketId}-${p.tokenId}`;
        return !this.positionEntryTimes.has(key);
      });

      if (withoutEntryTime.length > 0) {
        this.logger.warn(
          `[PositionTracker] ⚠️ ${withoutEntryTime.length} position(s) have NO entry time (external purchases?): ${withoutEntryTime.map((p) => `${p.tokenId.slice(0, 8)}...${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`).join(", ")}`,
        );
        this.logger.info(
          `[PositionTracker] ℹ️ Positions without entry times will still be sold if profitable (entry time check bypassed for profitable positions)`,
        );
      }
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Initial refresh failed",
        err as Error,
      );
    }

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error("[PositionTracker] Refresh failed", err as Error);
      });
    }, this.refreshIntervalMs);
  }

  /**
   * Stop tracking positions
   */
  stop(): void {
    // Abort any in-flight refresh
    if (this.refreshAbortController) {
      this.refreshAbortController.abort();
      this.refreshAbortController = null;
    }

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    // Clear the single-flight promise to prevent deadlocks
    this.currentRefreshPromise = null;
    this.isRefreshing = false;

    // Clear caches to release memory
    this.marketOutcomeCache.clear();
    this.missingOrderbooks.clear();
    this.loggedFallbackPrices.clear();
    this.orderbookCache.clear();
    this.outcomeCache.clear();
    this.lastLoggedState.clear();
    this.logger.info("[PositionTracker] Stopped position tracking");
  }

  /**
   * SELF-HEALING: Reset internal state to recover from stuck/degraded mode.
   *
   * This method implements the self-heal lifecycle for PositionTracker.
   * Call this when the tracker is stuck and needs recovery without container restart.
   *
   * @param level - Reset level:
   *   - SOFT_RESET: Clear transient caches, clear in-flight promise, reset throttling
   *   - HARD_RESET: Also clear all mapping caches, address probe cache, circuit breakers
   * @param reason - Human-readable reason for the reset (for logging)
   */
  resetState(level: ResetLevel, reason: string): void {
    const now = Date.now();
    const staleAge = this.lastGoodAtMs > 0 ? now - this.lastGoodAtMs : 0;

    this.logger.warn(
      `[PositionTracker] 🔄 SELF_HEAL: level=${level} reason="${reason}" ` +
        `failures=${this.consecutiveFailures} staleAge=${Math.round(staleAge / 1000)}s ` +
        `selfHealCount=${this.selfHealCount + 1}`,
    );

    // Track self-heal event
    this.selfHealCount++;
    this.lastSelfHealAt = now;

    // A) Cancel in-flight work
    if (this.refreshAbortController) {
      this.refreshAbortController.abort();
      this.refreshAbortController = null;
    }
    this.currentRefreshPromise = null;
    this.isRefreshing = false;
    this.lastRefreshCyclePromise = null;

    // B) Reset throttling/backoff - allow immediate retry
    this.consecutiveFailures = 0;
    this.currentBackoffMs = 0;
    this.lastRefreshCompletedAt = 0; // Allow immediate refresh

    // C) Clear transient caches (SOFT_RESET)
    this.orderbookCache.clear();
    this.missingOrderbooks.clear();
    this.loggedFallbackPrices.clear();
    this.lastLoggedState.clear();

    // Clear outcome cache TTLs (mark as stale so they refresh)
    for (const [, entry] of this.outcomeCache) {
      if (entry.status === "ACTIVE") {
        entry.lastCheckedMs = 0; // Force refresh on next access
      }
    }

    // D) Reset recovery tracking
    this.degradedModeEnteredAt = 0;
    this.recoveryMode = true; // Enter recovery mode to relax validation
    this.recoveryCycleCount = 0;
    this.allowBootstrapAfterAutoRecovery = true;

    // E) Reset sticky address tracking on SOFT_RESET (force re-probe)
    this.consecutiveZeroRefreshes = 0;
    this.addressProbeCompleted = false;

    if (level === "HARD_RESET") {
      // F) HARD_RESET: Clear all mapping caches
      this.marketOutcomeCache.clear();
      this.outcomeCache.clear();
      this.marketEndTimeCache.clear();
      this.circuitBreaker.clear();

      // G) Reset address probe to force re-detection
      this.addressProbeCompleted = false;
      this.cachedHoldingAddress = null;
      this.cachedEOAAddress = null;
      this.holdingAddressCacheMs = 0;
      this.addressStickySince = 0; // Also reset sticky timestamp on HARD_RESET

      // H) Clear lastGoodSnapshot to accept fresh data
      this.lastGoodSnapshot = null;
      this.lastGoodAtMs = 0;
      this.lastSnapshot = null;

      this.logger.info(
        `[PositionTracker] 🔄 HARD_RESET complete: Cleared all caches and address probe. ` +
          `Next refresh will re-probe addresses and accept fresh snapshot.`,
      );
    } else {
      this.logger.info(
        `[PositionTracker] 🔄 SOFT_RESET complete: Cleared transient caches. ` +
          `Recovery mode enabled for next ${PositionTracker.RECOVERY_MODE_MAX_CYCLES} cycles.`,
      );
    }
  }

  /**
   * Check if self-heal should be triggered based on current state.
   * Returns the recommended reset level, or null if no reset needed.
   */
  checkSelfHealNeeded(): { level: ResetLevel; reason: string } | null {
    const now = Date.now();
    const staleAge = this.lastGoodAtMs > 0 ? now - this.lastGoodAtMs : 0;
    const degradedDuration =
      this.degradedModeEnteredAt > 0 ? now - this.degradedModeEnteredAt : 0;

    // Rule 1: Too many consecutive failures -> SOFT_RESET
    if (this.consecutiveFailures >= PositionTracker.MAX_CONSECUTIVE_FAILURES) {
      return {
        level: "SOFT_RESET",
        reason: `consecutiveFailures=${this.consecutiveFailures} >= ${PositionTracker.MAX_CONSECUTIVE_FAILURES}`,
      };
    }

    // Rule 2: Stale age exceeded -> SOFT_RESET
    if (staleAge >= PositionTracker.MAX_STALE_AGE_MS && this.lastGoodAtMs > 0) {
      return {
        level: "SOFT_RESET",
        reason: `staleAge=${Math.round(staleAge / 1000)}s >= ${Math.round(PositionTracker.MAX_STALE_AGE_MS / 1000)}s`,
      };
    }

    // Rule 3: In degraded mode too long -> HARD_RESET
    if (degradedDuration >= PositionTracker.MAX_DEGRADED_DURATION_MS) {
      return {
        level: "HARD_RESET",
        reason: `degradedDuration=${Math.round(degradedDuration / 1000)}s >= ${Math.round(PositionTracker.MAX_DEGRADED_DURATION_MS / 1000)}s`,
      };
    }

    return null;
  }

  /**
   * Get self-healing status for external monitoring (Watchdog).
   */
  getSelfHealStatus(): {
    consecutiveFailures: number;
    staleAgeMs: number;
    degradedDurationMs: number;
    recoveryMode: boolean;
    recoveryCycleCount: number;
    selfHealCount: number;
    lastSelfHealAt: number;
    isHealthy: boolean;
  } {
    const now = Date.now();
    const staleAgeMs = this.lastGoodAtMs > 0 ? now - this.lastGoodAtMs : 0;
    const degradedDurationMs =
      this.degradedModeEnteredAt > 0 ? now - this.degradedModeEnteredAt : 0;

    return {
      consecutiveFailures: this.consecutiveFailures,
      staleAgeMs,
      degradedDurationMs,
      recoveryMode: this.recoveryMode,
      recoveryCycleCount: this.recoveryCycleCount,
      selfHealCount: this.selfHealCount,
      lastSelfHealAt: this.lastSelfHealAt,
      isHealthy: this.consecutiveFailures === 0 && !this.recoveryMode,
    };
  }

  /**
   * Invalidate orderbook cache for a specific token
   * Call this after a trade fill to ensure fresh pricing on next lookup
   */
  invalidateOrderbookCache(tokenId: string): void {
    this.orderbookCache.delete(tokenId);
    this.logger.debug(
      `[PositionTracker] Invalidated orderbook cache for ${tokenId.slice(0, 16)}...`,
    );
  }

  /**
   * Invalidate all orderbook caches
   * Call this when a significant market event occurs
   */
  invalidateAllOrderbookCaches(): void {
    const count = this.orderbookCache.size;
    this.orderbookCache.clear();
    this.logger.debug(
      `[PositionTracker] Invalidated ${count} orderbook cache entries`,
    );
  }

  /**
   * Get statistics about the current refresh cycle
   */
  getStats(): {
    resolved: number;
    active: number;
    skipped: number;
    cachedMarkets: number;
  } {
    return {
      ...this.lastRefreshStats,
      cachedMarkets: this.marketOutcomeCache.size,
    };
  }

  /**
   * Get detailed metrics from the most recent refresh cycle
   * Includes cache hits/misses, Gamma requests, etc.
   */
  getRefreshMetrics(): RefreshMetrics {
    return { ...this.currentRefreshMetrics };
  }

  /**
   * Await the current refresh if one is in progress, or trigger a new one.
   * This allows strategies to share a single refresh call rather than each
   * triggering their own (which would be blocked by isRefreshing anyway).
   *
   * SINGLE-FLIGHT GUARANTEE:
   * - If a refresh is in progress, returns the existing promise
   * - If no refresh is in progress, starts a new one and returns that promise
   * - All callers await the same promise, ensuring refresh runs exactly once
   *
   * WATCHDOG TIMEOUT (HFT):
   * - Refresh is wrapped with a timeout (REFRESH_WATCHDOG_TIMEOUT_MS = 15s)
   * - If refresh exceeds timeout, abort and count as failure
   * - Prevents stuck refreshes from blocking the system indefinitely
   */
  async awaitCurrentRefresh(): Promise<void> {
    // If a refresh is already in progress, await it with timeout
    if (this.currentRefreshPromise) {
      return this.awaitWithWatchdog(this.currentRefreshPromise);
    }

    // Create an AbortController for this refresh cycle
    this.refreshAbortController = new AbortController();

    // Start a new refresh and track the promise
    this.currentRefreshPromise = this.refresh().finally(() => {
      // Clear the promise when done so next caller can start a fresh refresh
      this.currentRefreshPromise = null;
      this.refreshAbortController = null;
    });

    return this.awaitWithWatchdog(this.currentRefreshPromise);
  }

  /**
   * Await a promise with a watchdog timeout.
   * If the promise doesn't resolve within REFRESH_WATCHDOG_TIMEOUT_MS,
   * abort and treat as a failure.
   */
  private async awaitWithWatchdog(promise: Promise<void>): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        // Abort any in-flight requests
        if (this.refreshAbortController) {
          this.refreshAbortController.abort();
        }
        reject(
          new Error(
            `REFRESH_WATCHDOG_TIMEOUT: refresh exceeded ${PositionTracker.REFRESH_WATCHDOG_TIMEOUT_MS}ms`,
          ),
        );
      }, PositionTracker.REFRESH_WATCHDOG_TIMEOUT_MS);
    });

    try {
      await Promise.race([promise, timeoutPromise]);
    } catch (err) {
      // If it was a watchdog timeout, log and handle as failure
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("REFRESH_WATCHDOG_TIMEOUT")) {
        this.logger.error(
          `[PositionTracker] ⏱️ REFRESH_WATCHDOG_TIMEOUT: Refresh exceeded ${PositionTracker.REFRESH_WATCHDOG_TIMEOUT_MS}ms - aborting and counting as failure`,
        );
        // handleRefreshFailure is called by refresh() itself on error
      }
      throw err;
    }
  }

  /**
   * Cycle-aware version of awaitCurrentRefresh.
   * If called multiple times within the same orchestrator cycle, returns the same promise
   * without re-running the refresh (single-flight per cycle).
   *
   * @param cycleId Current orchestrator cycle ID
   * @returns Promise that resolves when refresh completes
   */
  async awaitCurrentRefreshForCycle(cycleId: number): Promise<void> {
    // If we already refreshed in this cycle, return the cached promise
    if (this.lastRefreshCycleId === cycleId && this.lastRefreshCyclePromise) {
      return this.lastRefreshCyclePromise;
    }

    // Start a new refresh for this cycle
    this.lastRefreshCycleId = cycleId;
    this.lastRefreshCyclePromise = this.awaitCurrentRefresh().finally(() => {
      // Don't clear - keep promise cached for same cycle
    });

    return this.lastRefreshCyclePromise;
  }

  /**
   * Refresh positions from API
   *
   * SINGLE-FLIGHT: Only one refresh runs at a time.
   * If called while refresh is in progress, returns immediately.
   * Callers wanting to await the current refresh should use awaitCurrentRefresh().
   *
   * MIN REFRESH INTERVAL: Enforces minimum time between refreshes to prevent API hammering.
   *
   * CRASH-PROOF RECOVERY (Jan 2025):
   * - Two-phase commit: Build new snapshot in local variables, validate before publish
   * - Never replace a good snapshot with an empty/zero snapshot due to refresh error
   * - On failure, keep serving the last known-good snapshot (marked as stale)
   * - Automatic recovery with exponential backoff
   */
  async refresh(): Promise<void> {
    // Prevent concurrent refreshes (race condition protection)
    if (this.isRefreshing) {
      // Rate-limit the "refresh already in progress" log using LogDeduper
      if (
        this.logDeduper.shouldLog(
          "Tracker:skip_refresh_in_progress",
          PositionTracker.SKIP_REFRESH_LOG_INTERVAL_MS,
        )
      ) {
        this.logger.debug(
          "[PositionTracker] Refresh already in progress, skipping",
        );
      }
      return;
    }

    // Enforce minimum refresh interval to prevent API hammering
    // Also account for backoff if we're in recovery mode
    const effectiveMinInterval = Math.max(
      PositionTracker.MIN_REFRESH_INTERVAL_MS,
      this.currentBackoffMs,
    );
    const timeSinceLastRefresh = Date.now() - this.lastRefreshCompletedAt;
    if (
      timeSinceLastRefresh < effectiveMinInterval &&
      this.lastRefreshCompletedAt > 0
    ) {
      // Rate-limit this log too - only log when skipping starts or periodically
      if (
        this.logDeduper.shouldLog(
          "Tracker:skip_refresh_interval",
          PositionTracker.SKIP_REFRESH_LOG_INTERVAL_MS,
        )
      ) {
        this.logger.debug(
          `[PositionTracker] Skipping refresh - throttled (interval: ${effectiveMinInterval}ms${this.currentBackoffMs > 0 ? ` backoff=${this.currentBackoffMs}ms` : ""})`,
        );
      }
      return;
    }

    this.isRefreshing = true;

    // Reset metrics for this refresh cycle
    this.currentRefreshMetrics = {
      gammaRequestsPerRefresh: 0,
      tokenIdsFetched: 0,
      cacheHits: 0,
      cacheMisses: 0,
      resolvedCacheHits: 0,
    };

    try {
      // Note: We no longer clear marketOutcomeCache here to avoid redundant Gamma API calls
      // Resolved markets don't change their outcome, so caching is safe across refreshes

      // Get current positions from Data API and enrich with current market prices
      // Note: "Refreshing positions" log removed to reduce noise - the summary log provides refresh status

      // === PHASE 1: FETCH POSITIONS (local variables only) ===
      // Never mutate this.positions during fetch
      const positions = await this.fetchPositionsFromAPI();

      // === PHASE 2: BUILD NEW POSITION MAP (local variable) ===
      // Never clear this.positions - build replacement map in local variable
      const newPositions = new Map<string, Position>();
      const now = Date.now();

      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        newPositions.set(key, position);
        this.positionLastSeen.set(key, now);

        // Preserve entry time if position already existed (from historical data or previous refresh)
        // Only set to "now" for genuinely new positions (bought after startup)
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, now);
          this.logger.debug(
            `[PositionTracker] New position detected (no historical entry time): ${key.slice(0, 30)}...`,
          );
        }
      }

      // === PHASE 3: CREATE CANDIDATE SNAPSHOT (not published yet) ===
      // Build snapshot from newPositions without modifying this.lastSnapshot
      const candidateSnapshot = this.buildCandidateSnapshot(newPositions);

      // === PHASE 4: VALIDATE CANDIDATE SNAPSHOT ===
      // Check for ACTIVE_COLLAPSE_BUG, FETCH_REGRESSION, ADDRESS_FLIP_COLLAPSE, SUSPICIOUS_SHRINK, ACTIVE_WIPEOUT
      const validationResult = this.validateSnapshot(
        candidateSnapshot,
        this.lastGoodSnapshot,
      );

      if (!validationResult.ok) {
        // Validation failed - DO NOT publish the new snapshot
        // Log diagnostic (rate-limited)
        const shouldLog =
          this.lastValidationFailureReason !== validationResult.reason ||
          Date.now() - this.lastValidationFailureLoggedAt >=
            PositionTracker.VALIDATION_FAILURE_LOG_INTERVAL_MS;

        if (shouldLog) {
          this.lastValidationFailureLoggedAt = Date.now();
          this.lastValidationFailureReason = validationResult.reason ?? null;

          // Build classification reasons string for diagnostics
          const reasonCounts: string[] = [];
          if (candidateSnapshot.classificationReasons) {
            for (const [
              reason,
              count,
            ] of candidateSnapshot.classificationReasons) {
              reasonCounts.push(`${reason}=${count}`);
            }
          }
          const reasonsStr = reasonCounts.join(", ") || "none";

          this.logger.error(
            `[PositionTracker] ❌ snapshot_rejected: ${validationResult.reason} ` +
              `${validationResult.diagnostics} ` +
              `reasons=[${reasonsStr}]`,
          );
        }

        // === RECOVERY BEHAVIOR (Jan 2025) ===
        // On SUSPICIOUS_SHRINK or ACTIVE_WIPEOUT, trigger immediate recovery:
        // 1. Clear mapping/outcome caches
        // 2. Force address re-probe on next cycle
        // 3. Log recovery message with lastGood info
        if (
          validationResult.reason === "SUSPICIOUS_SHRINK" ||
          validationResult.reason === "ACTIVE_WIPEOUT"
        ) {
          const lastGoodAge =
            this.lastGoodAtMs > 0
              ? Math.round((Date.now() - this.lastGoodAtMs) / 1000)
              : 0;
          const lastGoodActive =
            this.lastGoodSnapshot?.activePositions.length ?? 0;
          const lastGoodRaw = this.lastGoodSnapshot?.rawCounts?.rawTotal ?? 0;

          this.logger.warn(
            `[PositionTracker] 🔄 RECOVERY: rejecting suspicious snapshot (${validationResult.reason}); ` +
              `forcing address re-probe on next cycle; using lastGood age=${lastGoodAge}s ` +
              `(active=${lastGoodActive} raw=${lastGoodRaw})`,
          );

          // Force address re-probe without doing a HARD_RESET (preserve lastGoodSnapshot)
          this.addressProbeCompleted = false;
          this.consecutiveZeroRefreshes = 0;
          this.addressStickySince = 0; // Reset sticky to allow immediate switch

          // Clear outcome caches that might be stale
          this.marketOutcomeCache.clear();
          this.outcomeCache.clear();
        }

        // Fall back to lastGoodSnapshot
        this.handleRefreshFailure(
          new Error(`snapshot_rejected: ${validationResult.reason}`),
        );
        return;
      }

      // === PHASE 5: ATOMIC COMMIT (validation passed) ===
      // Only now do we modify this.positions and this.lastSnapshot
      this.positions = newPositions;
      this.lastSnapshot = candidateSnapshot;
      this.lastSnapshotCycleId = candidateSnapshot.cycleId;

      // Clean up stale entry times for positions that have disappeared.
      // Use a grace window to avoid clearing on transient API glitches.
      const staleThresholdMs = this.refreshIntervalMs * 2;
      for (const [key, lastSeen] of this.positionLastSeen.entries()) {
        if (newPositions.has(key)) {
          continue;
        }
        if (now - lastSeen > staleThresholdMs) {
          this.positionLastSeen.delete(key);
          this.positionEntryTimes.delete(key);
        }
      }

      // Note: Positions that temporarily disappear are handled by keeping their
      // entry times in positionEntryTimes Map for a short grace window. This
      // provides resilience against temporary API glitches without treating
      // re-buys as long-held positions.

      // === RECOVERY: Mark success and reset backoff ===
      this.handleRefreshSuccess();
    } catch (err) {
      // Refresh failed - use crash-proof recovery
      this.handleRefreshFailure(
        err instanceof Error ? err : new Error(String(err)),
      );
      // Don't throw - we've fallen back to lastGoodSnapshot if available
    } finally {
      this.isRefreshing = false;
      this.lastRefreshCompletedAt = Date.now();
    }
  }

  /**
   * CRASH-PROOF RECOVERY: Build a candidate snapshot from a position map.
   *
   * This method creates a snapshot WITHOUT modifying this.lastSnapshot.
   * Used during two-phase commit to build a candidate for validation.
   *
   * @param positionMap The position map to build snapshot from
   * @returns A candidate PortfolioSnapshot (not yet published)
   */
  private buildCandidateSnapshot(
    positionMap: Map<string, Position>,
  ): PortfolioSnapshot {
    const allPositions = Array.from(positionMap.values());
    const activePositions = allPositions.filter((p) => !p.redeemable);
    const redeemablePositions = allPositions.filter((p) => p.redeemable);

    // Calculate summary using pnlClassification for proper categorization
    const prof = activePositions.filter(
      (p) => p.pnlClassification === "PROFITABLE",
    ).length;
    const lose = activePositions.filter(
      (p) => p.pnlClassification === "LOSING",
    ).length;
    const neutral = activePositions.filter(
      (p) => p.pnlClassification === "NEUTRAL",
    ).length;
    const unknown = activePositions.filter(
      (p) => p.pnlClassification === "UNKNOWN",
    ).length;

    const snapshotCycleId = this.lastSnapshotCycleId + 1;
    const addressUsed = this.cachedHoldingAddress ?? "address-not-resolved";

    // Build the candidate snapshot with frozen arrays
    const candidate: PortfolioSnapshot = {
      cycleId: snapshotCycleId,
      addressUsed,
      fetchedAtMs: Date.now(),
      activePositions: Object.freeze([...activePositions]),
      redeemablePositions: Object.freeze([...redeemablePositions]),
      summary: {
        activeTotal: activePositions.length,
        prof,
        lose,
        neutral,
        unknown,
        redeemableTotal: redeemablePositions.length,
      },
      rawCounts: { ...this.lastRawCounts },
      classificationReasons: new Map(this.lastClassificationReasons),
    };

    return candidate;
  }

  /**
   * @deprecated This method is no longer called directly.
   * Snapshot creation is now done via buildCandidateSnapshot() as part of the
   * two-phase commit pattern in refresh(). This method is kept for reference
   * and may be removed in a future cleanup.
   *
   * Legacy: Create an immutable portfolio snapshot from current positions.
   * Called after each refresh to ensure strategies see consistent data.
   *
   * INVARIANT CHECK: ACTIVE_COLLAPSE_BUG
   * If raw_total > 0 AND raw_active_candidates > 0 BUT activePositions.length === 0,
   * log ERROR with diagnostic dump (once per TTL to avoid spam).
   *
   * @param cycleId Optional orchestrator cycle ID to tag the snapshot
   */
  private createSnapshot(cycleId?: number): void {
    const allPositions = this.getPositions();
    const activePositions = allPositions.filter((p) => !p.redeemable);
    const redeemablePositions = allPositions.filter((p) => p.redeemable);

    // Calculate summary using pnlClassification for proper categorization
    const prof = activePositions.filter(
      (p) => p.pnlClassification === "PROFITABLE",
    ).length;
    const lose = activePositions.filter(
      (p) => p.pnlClassification === "LOSING",
    ).length;
    const neutral = activePositions.filter(
      (p) => p.pnlClassification === "NEUTRAL",
    ).length;
    const unknown = activePositions.filter(
      (p) => p.pnlClassification === "UNKNOWN",
    ).length;

    const snapshotCycleId = cycleId ?? this.lastSnapshotCycleId + 1;
    const addressUsed = this.cachedHoldingAddress ?? "address-not-resolved";

    // === INVARIANT CHECK: ACTIVE_COLLAPSE_BUG ===
    // If raw_total > 0 AND raw_active_candidates > 0 BUT activePositions.length === 0,
    // this is a regression bug - log ERROR with diagnostic dump (rate-limited)
    const rawTotal = this.lastRawCounts.rawTotal;
    const rawActiveCandidates = this.lastRawCounts.rawActiveCandidates;

    if (
      rawTotal > 0 &&
      rawActiveCandidates > 0 &&
      activePositions.length === 0
    ) {
      // ACTIVE_COLLAPSE_BUG detected - log with diagnostic dump (rate-limited)
      if (
        this.logDeduper.shouldLog(
          "Tracker:ACTIVE_COLLAPSE_BUG",
          60_000, // TTL: 60 seconds to avoid spam
        )
      ) {
        // Build classification reason counts string
        const reasonCounts: string[] = [];
        for (const [reason, count] of this.lastClassificationReasons) {
          reasonCounts.push(`${reason}=${count}`);
        }
        const reasonsStr = reasonCounts.join(", ") || "none";

        // Helper to safely truncate tokenId
        const truncateTokenId = (tokenId: string): string => {
          if (tokenId.length > 16) {
            return tokenId.slice(0, 16) + "...";
          }
          return tokenId;
        };

        // Get first 3 positions for diagnostic dump (sanitized)
        const firstThreePositions = allPositions.slice(0, 3).map((p) => ({
          tokenId: truncateTokenId(p.tokenId),
          side: p.side,
          size: p.size.toFixed(2),
          pnlPct: p.pnlPct.toFixed(2),
          redeemable: p.redeemable,
          positionState: p.positionState,
          pnlClassification: p.pnlClassification,
        }));

        this.logger.error(
          `[PositionTracker] 🐛 ACTIVE_COLLAPSE_BUG: cycleId=${snapshotCycleId} ` +
            `addressUsed=${addressUsed.slice(0, 10)}... ` +
            `raw_total=${rawTotal} raw_active_candidates=${rawActiveCandidates} ` +
            `BUT final_active=0. ` +
            `Classification reasons: [${reasonsStr}]. ` +
            `First 3 positions: ${JSON.stringify(firstThreePositions)}`,
        );
      }
    }

    // === ADDRESS STABILITY CHECK ===
    // Warn if address selection flips between cycles
    if (
      this.lastSelectedAddress !== null &&
      this.lastSelectedAddress !== addressUsed
    ) {
      const now = Date.now();
      if (
        now - this.addressChangeLoggedAt >=
        PositionTracker.ADDRESS_CHANGE_LOG_COOLDOWN_MS
      ) {
        this.logger.warn(
          `[PositionTracker] ⚠️ ADDRESS_CHANGED: Holding address changed from ${this.lastSelectedAddress.slice(0, 10)}... -> ${addressUsed.slice(0, 10)}... (cycleId=${snapshotCycleId})`,
        );
        this.addressChangeLoggedAt = now;
      }
    }
    this.lastSelectedAddress = addressUsed;

    // Create immutable snapshot with frozen arrays
    this.lastSnapshot = {
      cycleId: snapshotCycleId,
      addressUsed,
      fetchedAtMs: Date.now(),
      activePositions: Object.freeze([...activePositions]),
      redeemablePositions: Object.freeze([...redeemablePositions]),
      summary: {
        activeTotal: activePositions.length,
        prof,
        lose,
        neutral,
        unknown,
        redeemableTotal: redeemablePositions.length,
      },
      // Include raw counts for downstream diagnostics
      rawCounts: { ...this.lastRawCounts },
      classificationReasons: new Map(this.lastClassificationReasons),
    };

    this.lastSnapshotCycleId = this.lastSnapshot.cycleId;
  }

  /**
   * CRASH-PROOF RECOVERY: Validate a new snapshot before publishing.
   *
   * Validation rules:
   * A) ACTIVE_COLLAPSE_BUG: If newSnap.rawTotal > 0 AND rawActiveCandidates > 0
   *    AND activePositions.length === 0, REJECT (unless in recovery/bootstrap mode).
   * B) FETCH_REGRESSION: If newSnap.rawTotal < 20% of prevSnap.rawTotal
   *    (and prevSnap had > 0 positions), REJECT as suspicious.
   * C) ADDRESS_FLIP_COLLAPSE: If address changed AND position counts collapsed
   *    simultaneously, REJECT.
   *
   * RECOVERY MODE RELAXATION:
   * - In recovery mode, ACTIVE_COLLAPSE_BUG is logged but not rejected
   * - Snapshot is published with pnlTrusted=false for affected positions
   * - This prevents indefinite stale mode from false positive detections
   *
   * @param newSnap The candidate snapshot to validate
   * @param prevSnap The previous known-good snapshot (for comparison)
   * @returns Validation result with ok flag and reason if failed
   */
  private validateSnapshot(
    newSnap: PortfolioSnapshot,
    prevSnap: PortfolioSnapshot | null,
  ): SnapshotValidationResult {
    const rawTotal = newSnap.rawCounts?.rawTotal ?? 0;
    const rawActiveCandidates = newSnap.rawCounts?.rawActiveCandidates ?? 0;
    const finalActiveCount = newSnap.activePositions.length;

    // Build classification reasons string for diagnostics
    const reasonCounts: string[] = [];
    if (
      newSnap.classificationReasons &&
      newSnap.classificationReasons.size > 0
    ) {
      for (const [reason, count] of newSnap.classificationReasons) {
        reasonCounts.push(`${reason}=${count}`);
      }
    }
    // CRITICAL FIX: Never allow "none" for reasons - always have at least one entry
    // If no skip reasons were recorded, add PROCESSED_OK count
    if (reasonCounts.length === 0) {
      const processedOk = rawActiveCandidates - finalActiveCount;
      if (processedOk > 0) {
        reasonCounts.push(`FILTERED_NO_REASON=${processedOk}`);
      } else {
        reasonCounts.push(`ALL_ACTIVE=${finalActiveCount}`);
      }
    }
    const reasonsStr = reasonCounts.join(", ");

    // Rule A: ACTIVE_COLLAPSE_BUG
    // If raw total > 0 AND raw active candidates > 0 BUT final active = 0, this may be a bug
    // EXCEPTIONS that allow acceptance:
    // 1. Bootstrap mode (after auto-recovery)
    // 2. Recovery mode (relaxed validation)
    // 3. Minimal acceptance rule: small raw counts with no real reasons
    // 4. ORDERBOOK_FAILURE: If the reason is orderbook 404/empty (NOT_TRADABLE_ON_CLOB scenario)
    if (rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0) {
      // Check for minimal acceptance rule:
      // If rawTotal==rawActiveCandidates (no redeemable) and both are small,
      // and no real skip reasons were logged, this is likely a classifier bug
      // Accept the snapshot but log a warning
      const isMinimalAcceptanceCase =
        rawTotal === rawActiveCandidates &&
        rawTotal <= PositionTracker.MINIMAL_ACCEPTANCE_MAX_RAW_COUNT &&
        (reasonsStr.includes("FILTERED_NO_REASON") ||
          reasonsStr.includes("ALL_ACTIVE"));

      // NEW: Check if the collapse is due to orderbook failures (404, empty book, etc.)
      // If ALL filtered positions are due to enrichment/orderbook failures, this is NOT a bug
      // but rather a temporary network/API issue. Accept the snapshot with UNKNOWN pnl positions.
      // Check the actual classification reasons Map for more reliable detection.
      const classificationReasons = newSnap.classificationReasons;
      const hasOrderbookFailureReasons =
        classificationReasons &&
        (classificationReasons.has("ENRICH_FAILED") ||
          classificationReasons.has("NO_BOOK") ||
          classificationReasons.has("BOOK_404") ||
          classificationReasons.has("PRICING_FETCH_FAILED"));
      // Fallback to string matching for backward compatibility (if Map not available)
      const isOrderbookFailureCase =
        hasOrderbookFailureReasons ||
        reasonsStr.includes("ENRICH_FAILED=") ||
        reasonsStr.includes("NO_BOOK=") ||
        reasonsStr.includes("BOOK_404=") ||
        reasonsStr.includes("PRICING_FETCH_FAILED=");

      if (this.allowBootstrapAfterAutoRecovery) {
        // Bootstrap mode: log and accept the snapshot despite ACTIVE_COLLAPSE_BUG
        this.logger.warn(
          `[PositionTracker] 🚀 BOOTSTRAP_RECOVERY: Accepting snapshot despite ACTIVE_COLLAPSE_BUG ` +
            `(bootstrap mode). rawTotal=${rawTotal} rawActiveCandidates=${rawActiveCandidates} ` +
            `finalActive=${finalActiveCount} reasons=[${reasonsStr}]`,
        );
        // Continue to other validations (don't return early)
      } else if (this.recoveryMode) {
        // Recovery mode: log and accept with warning
        this.logger.warn(
          `[PositionTracker] 🔄 RECOVERY_MODE: Accepting snapshot despite ACTIVE_COLLAPSE_BUG ` +
            `(recovery mode active). rawTotal=${rawTotal} rawActiveCandidates=${rawActiveCandidates} ` +
            `finalActive=${finalActiveCount} reasons=[${reasonsStr}]`,
        );
        // Continue to other validations (don't return early)
      } else if (isMinimalAcceptanceCase) {
        // Minimal acceptance rule: small counts with no clear reason
        // This prevents classifier bugs from blocking indefinitely
        this.logger.warn(
          `[PositionTracker] ⚠️ MINIMAL_ACCEPTANCE: Accepting snapshot despite zero active ` +
            `(small raw counts, no clear skip reasons). rawTotal=${rawTotal} rawActiveCandidates=${rawActiveCandidates} ` +
            `finalActive=${finalActiveCount} reasons=[${reasonsStr}] - positions may have UNKNOWN pnl`,
        );
        // Continue to other validations (don't return early)
      } else if (isOrderbookFailureCase) {
        // ORDERBOOK_FAILURE: Positions filtered due to orderbook 404/empty/enrichment issues
        // This is NOT a bug - treat orderbook failures as non-fatal metadata
        // Accept the snapshot with positions marked as NOT_TRADABLE_ON_CLOB
        this.logger.warn(
          `[PositionTracker] 📚 ORDERBOOK_FAILURE: Accepting snapshot despite zero active ` +
            `(orderbook/enrichment failures - NOT_TRADABLE_ON_CLOB scenario). ` +
            `rawTotal=${rawTotal} rawActiveCandidates=${rawActiveCandidates} ` +
            `finalActive=${finalActiveCount} reasons=[${reasonsStr}] - positions have executionStatus=NOT_TRADABLE_ON_CLOB`,
        );
        // Continue to other validations (don't return early)
      } else {
        return {
          ok: false,
          reason: "ACTIVE_COLLAPSE_BUG",
          diagnostics: `rawTotal=${rawTotal} rawActiveCandidates=${rawActiveCandidates} finalActive=${finalActiveCount} reasons=[${reasonsStr}]`,
        };
      }
    }

    // Rule B: FETCH_REGRESSION
    // If new snapshot has dramatically fewer positions than previous (< 20%), reject
    // EXCEPTION: Skip in recovery mode to allow gradual restoration
    if (prevSnap && !this.recoveryMode) {
      const prevRawTotal = prevSnap.rawCounts?.rawTotal ?? 0;
      if (
        prevRawTotal > 0 &&
        rawTotal < prevRawTotal * PositionTracker.FETCH_REGRESSION_THRESHOLD
      ) {
        return {
          ok: false,
          reason: "FETCH_REGRESSION",
          diagnostics: `newRawTotal=${rawTotal} prevRawTotal=${prevRawTotal} threshold=${PositionTracker.FETCH_REGRESSION_THRESHOLD * 100}%`,
        };
      }
    }

    // Rule C: ADDRESS_FLIP_COLLAPSE
    // If address changed AND position counts collapsed, reject
    // EXCEPTION: Skip in recovery mode
    if (prevSnap && !this.recoveryMode) {
      const addressChanged = newSnap.addressUsed !== prevSnap.addressUsed;
      const prevActiveCount = prevSnap.activePositions.length;
      const countsCollapsed =
        prevActiveCount > 0 &&
        finalActiveCount === 0 &&
        newSnap.redeemablePositions.length === 0;

      if (addressChanged && countsCollapsed) {
        return {
          ok: false,
          reason: "ADDRESS_FLIP_COLLAPSE",
          diagnostics: `prevAddress=${prevSnap.addressUsed.slice(0, 10)}... newAddress=${newSnap.addressUsed.slice(0, 10)}... prevActive=${prevActiveCount} newActive=${finalActiveCount}`,
        };
      }
    }

    // Rule D: SUSPICIOUS_SHRINK (Jan 2025)
    // If lastGood had >= MIN_POSITIONS_FOR_SHRINK_CHECK positions AND new rawTotal < 25% of lastGood,
    // this is a catastrophic shrink that should NOT overwrite lastGood snapshot
    // EXCEPTION: Skip in recovery mode or bootstrap mode
    if (
      prevSnap &&
      !this.recoveryMode &&
      !this.allowBootstrapAfterAutoRecovery
    ) {
      const prevRawTotal = prevSnap.rawCounts?.rawTotal ?? 0;
      if (
        prevRawTotal >= PositionTracker.MIN_POSITIONS_FOR_SHRINK_CHECK &&
        rawTotal <= prevRawTotal * PositionTracker.SUSPICIOUS_SHRINK_THRESHOLD
      ) {
        return {
          ok: false,
          reason: "SUSPICIOUS_SHRINK",
          diagnostics:
            `newRawTotal=${rawTotal} prevRawTotal=${prevRawTotal} (shrink to ${((rawTotal / prevRawTotal) * 100).toFixed(1)}% < 25% threshold). ` +
            `Proxy returning tiny snapshot must not overwrite healthy lastGood.`,
        };
      }
    }

    // Rule E: ACTIVE_WIPEOUT (Jan 2025)
    // If lastGood had >= MIN_ACTIVE_FOR_WIPEOUT_CHECK active positions AND new.active == 0 AND new.rawTotal > 0,
    // this is suspicious - all positions became inactive while raw data still exists
    // EXCEPTION: Skip in recovery mode or bootstrap mode
    if (
      prevSnap &&
      !this.recoveryMode &&
      !this.allowBootstrapAfterAutoRecovery
    ) {
      const prevActiveCount = prevSnap.activePositions.length;
      if (
        prevActiveCount >= PositionTracker.MIN_ACTIVE_FOR_WIPEOUT_CHECK &&
        finalActiveCount === 0 &&
        rawTotal > 0
      ) {
        return {
          ok: false,
          reason: "ACTIVE_WIPEOUT",
          diagnostics:
            `prevActive=${prevActiveCount} newActive=${finalActiveCount} newRawTotal=${rawTotal}. ` +
            `All positions went inactive while raw data exists - likely enrichment failure.`,
        };
      }
    }

    // All validations passed
    return { ok: true };
  }

  /**
   * CRASH-PROOF RECOVERY: Create a stale snapshot from lastGoodSnapshot.
   *
   * Called when refresh fails or validation rejects the new snapshot.
   * Returns a copy of lastGoodSnapshot with stale=true and staleAgeMs set.
   *
   * @param reason Why this snapshot is stale
   * @returns A stale copy of the lastGoodSnapshot, or null if no good snapshot exists
   */
  private createStaleSnapshot(reason: string): PortfolioSnapshot | null {
    if (!this.lastGoodSnapshot) {
      return null;
    }

    const now = Date.now();
    const staleAgeMs = now - this.lastGoodSnapshot.fetchedAtMs;

    // Create a new snapshot object with stale markers
    // Keep the same data but update cycleId and mark as stale
    const staleSnapshot: PortfolioSnapshot = {
      ...this.lastGoodSnapshot,
      cycleId: this.lastSnapshotCycleId + 1,
      stale: true,
      staleAgeMs,
      staleReason: reason,
    };

    return staleSnapshot;
  }

  /**
   * CRASH-PROOF RECOVERY: Handle refresh failure with backoff and fallback.
   *
   * When refresh fails:
   * 1. Increment consecutiveFailures
   * 2. Enter degraded mode if not already
   * 3. Calculate exponential backoff
   * 4. Fall back to lastGoodSnapshot (marked as stale)
   * 5. Check if self-heal is needed and trigger it
   * 6. AUTO-RECOVERY: If stale age exceeds MAX_STALE_AGE_MS, trigger self-heal
   *
   * @param error The error that caused the failure
   */
  private handleRefreshFailure(error: Error): void {
    const now = Date.now();
    this.consecutiveFailures++;
    this.lastErrorAtMs = now;

    // Enter degraded mode if this is the first failure
    if (this.degradedModeEnteredAt === 0) {
      this.degradedModeEnteredAt = now;
      this.logger.warn(
        `[PositionTracker] ⚠️ DEGRADED_MODE_ENTERED: First failure, starting degraded mode tracking`,
      );
    }

    // Check if self-heal is needed BEFORE calculating backoff
    const selfHealCheck = this.checkSelfHealNeeded();
    if (selfHealCheck) {
      // Trigger self-heal - this will reset state and allow immediate retry
      this.resetState(selfHealCheck.level, selfHealCheck.reason);
      // After self-heal, don't apply backoff - allow immediate retry
      return;
    }

    // Calculate exponential backoff: base * 2^failures, capped at max
    this.currentBackoffMs = Math.min(
      PositionTracker.BASE_BACKOFF_MS *
        Math.pow(2, this.consecutiveFailures - 1),
      PositionTracker.MAX_BACKOFF_MS,
    );

    // Create stale snapshot from lastGoodSnapshot
    const staleSnapshot = this.createStaleSnapshot(
      `refresh_failed: ${error.message}`,
    );

    if (staleSnapshot) {
      // Use the stale snapshot
      this.lastSnapshot = staleSnapshot;
      this.lastSnapshotCycleId = staleSnapshot.cycleId;

      const staleAgeMs = staleSnapshot.staleAgeMs ?? 0;
      const staleAgeSec = Math.round(staleAgeMs / 1000);
      const activeCount = staleSnapshot.activePositions.length;
      const redeemableCount = staleSnapshot.redeemablePositions.length;
      const backoffSec = Math.round(this.currentBackoffMs / 1000);

      // AUTO-RECOVERY: If snapshot is too stale, trigger SOFT_RESET
      // This allows the next refresh to accept a fresh snapshot
      if (staleAgeMs >= PositionTracker.MAX_STALE_AGE_MS) {
        this.logger.warn(
          `[PositionTracker] 🔄 AUTO-RECOVERY: Stale age exceeded (age=${staleAgeSec}s >= ${Math.round(PositionTracker.MAX_STALE_AGE_MS / 1000)}s threshold). ` +
            `Triggering SOFT_RESET. reason="${error.message}" active=${activeCount} redeemable=${redeemableCount}`,
        );
        this.resetState(
          "SOFT_RESET",
          `staleAge=${staleAgeSec}s exceeded threshold`,
        );
        return;
      }

      // Log diagnostic (rate-limited)
      if (
        this.logDeduper.shouldLog(
          "Tracker:refresh_failed",
          PositionTracker.VALIDATION_FAILURE_LOG_INTERVAL_MS,
        )
      ) {
        this.logger.error(
          `[PositionTracker] ❌ refresh_failed: reason="${error.message}" ` +
            `using lastGoodSnapshot active=${activeCount} redeemable=${redeemableCount} ` +
            `staleAge=${staleAgeSec}s failures=${this.consecutiveFailures} backoff=${backoffSec}s`,
        );
      }
    } else {
      // No good snapshot to fall back to - this is critical
      // Trigger HARD_RESET to attempt full recovery
      this.logger.error(
        `[PositionTracker] ❌ refresh_failed: reason="${error.message}" ` +
          `NO lastGoodSnapshot available! failures=${this.consecutiveFailures} - triggering HARD_RESET`,
      );
      this.resetState(
        "HARD_RESET",
        `no lastGoodSnapshot after ${this.consecutiveFailures} failures`,
      );
    }
  }

  /**
   * CRASH-PROOF RECOVERY: Handle successful refresh (reset backoff).
   *
   * When refresh succeeds:
   * 1. Reset consecutiveFailures to 0
   * 2. Clear backoff
   * 3. Update lastGoodSnapshot
   * 4. Exit degraded mode
   * 5. Track recovery mode cycles and exit when stable
   * 6. Log recovery if we were in failed state
   * 7. Clear bootstrap mode flag if it was set
   */
  private handleRefreshSuccess(): void {
    const wasInFailedState = this.consecutiveFailures > 0;
    const wasInBootstrapMode = this.allowBootstrapAfterAutoRecovery;
    const wasInRecoveryMode = this.recoveryMode;
    const previousFailures = this.consecutiveFailures;

    // Reset failure tracking
    this.consecutiveFailures = 0;
    this.currentBackoffMs = 0;

    // Exit degraded mode
    this.degradedModeEnteredAt = 0;

    // Clear bootstrap mode flag
    this.allowBootstrapAfterAutoRecovery = false;

    // Update lastGoodSnapshot (only if current snapshot is valid)
    if (this.lastSnapshot && !this.lastSnapshot.stale) {
      this.lastGoodSnapshot = this.lastSnapshot;
      this.lastGoodAtMs = Date.now();
    }

    // Track recovery mode cycles
    if (this.recoveryMode) {
      this.recoveryCycleCount++;
      const activeCount = this.lastSnapshot?.activePositions.length ?? 0;

      // Exit recovery mode if:
      // 1. We have active positions (snapshot is useful), OR
      // 2. We've completed enough successful cycles
      if (
        activeCount > 0 ||
        this.recoveryCycleCount >= PositionTracker.RECOVERY_MODE_MAX_CYCLES
      ) {
        this.recoveryMode = false;
        this.recoveryCycleCount = 0;
        this.logger.info(
          `[PositionTracker] ✅ RECOVERY_MODE_EXIT: Exiting recovery mode after ${this.recoveryCycleCount} cycles; ` +
            `active=${activeCount} - normal validation resumed`,
        );
      }
    }

    // Log recovery if we were in a failed state or bootstrap mode
    if (
      (wasInFailedState || wasInBootstrapMode || wasInRecoveryMode) &&
      this.lastSnapshot
    ) {
      const activeCount = this.lastSnapshot.activePositions.length;
      const redeemableCount = this.lastSnapshot.redeemablePositions.length;

      if (wasInBootstrapMode) {
        this.logger.info(
          `[PositionTracker] ✅ BOOTSTRAP_RECOVERY complete: Service restored via bootstrap mode; ` +
            `snapshot accepted active=${activeCount}, redeemable=${redeemableCount}`,
        );
      } else if (wasInFailedState) {
        this.logger.info(
          `[PositionTracker] ✅ RECOVERED: recovered after ${previousFailures} failures; ` +
            `snapshot updated active=${activeCount}, redeemable=${redeemableCount}`,
        );
      }
    }

    // Periodic health status logging (every 5 minutes)
    const now = Date.now();
    if (
      now - this.lastHealthStatusLogAt >=
      PositionTracker.HEALTH_STATUS_LOG_INTERVAL_MS
    ) {
      this.lastHealthStatusLogAt = now;
      const status = this.getSelfHealStatus();
      const snapshot = this.lastSnapshot;
      this.logger.info(
        `[PositionTracker] health: snapshotAge=${Math.round(status.staleAgeMs / 1000)}s ` +
          `failures=${status.consecutiveFailures} recoveryMode=${status.recoveryMode} ` +
          `selfHealCount=${status.selfHealCount} active=${snapshot?.activePositions.length ?? 0} ` +
          `redeemable=${snapshot?.redeemablePositions.length ?? 0}`,
      );
    }
  }

  /**
   * Get the current portfolio snapshot.
   *
   * This is the ONLY way strategies should access position data during a cycle.
   * The snapshot is immutable and consistent within a single orchestrator cycle.
   *
   * CRASH-PROOF RECOVERY: If the snapshot is stale (from lastGoodSnapshot fallback),
   * the stale flag will be true. Strategies should still operate but may log a warning.
   *
   * @returns The last created snapshot, or null if no refresh has completed
   */
  getSnapshot(): PortfolioSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * CRASH-PROOF RECOVERY: Get the last known-good snapshot.
   *
   * Returns the most recent snapshot that passed validation.
   * Useful for downstream strategies that need to detect upstream failures.
   *
   * @returns The last known-good snapshot, or null if none exists
   */
  getLastGoodSnapshot(): PortfolioSnapshot | null {
    return this.lastGoodSnapshot;
  }

  /**
   * CRASH-PROOF RECOVERY: Get recovery status information.
   *
   * Returns current failure/recovery state for diagnostics.
   */
  getRecoveryStatus(): {
    consecutiveFailures: number;
    currentBackoffMs: number;
    lastGoodAtMs: number;
    lastErrorAtMs: number;
    isHealthy: boolean;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      currentBackoffMs: this.currentBackoffMs,
      lastGoodAtMs: this.lastGoodAtMs,
      lastErrorAtMs: this.lastErrorAtMs,
      isHealthy: this.consecutiveFailures === 0,
    };
  }

  /**
   * Set the current orchestrator cycle ID.
   * Called by the orchestrator before refresh to tag the snapshot.
   *
   * @param cycleId The current orchestrator cycle ID
   */
  setCycleId(cycleId: number): void {
    this.lastSnapshotCycleId = cycleId;
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by market and token ID
   */
  getPosition(marketId: string, tokenId: string): Position | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positions.get(key);
  }

  /**
   * Get position by token ID only (searches all positions)
   * Used to check if we already own a specific token before buying
   * NOTE: This does NOT block hedging - hedges use a different tokenId (opposite outcome)
   */
  getPositionByTokenId(tokenId: string): Position | undefined {
    for (const position of this.positions.values()) {
      if (position.tokenId === tokenId) {
        return position;
      }
    }
    return undefined;
  }

  /**
   * Get positions with P&L above threshold
   */
  getPositionsAboveTarget(targetPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get positions below stop loss threshold
   */
  getPositionsBelowStopLoss(stopLossPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct <= -stopLossPct);
  }

  /**
   * Get positions near resolution (price >= threshold)
   *
   * CRITICAL FIX (Jan 2025): Uses currentBidPrice (executable price) when available,
   * falling back to currentPrice. This ensures positions with live executable bids
   * at 99.9¢+ are eligible for auto-sell even when Data-API currentPrice is lower.
   *
   * The executable bid price is what we can actually sell at, so it should drive
   * the "near resolution" determination for capital efficiency.
   *
   * @param threshold Price threshold in decimal (e.g., 0.999 for 99.9¢)
   * @returns Positions where best bid or current price is at or above threshold
   */
  getPositionsNearResolution(threshold: number): Position[] {
    return this.getPositions().filter((pos) => {
      // Use executable bid price if available, otherwise fall back to currentPrice
      const effectivePrice = pos.currentBidPrice ?? pos.currentPrice;
      return effectivePrice >= threshold;
    });
  }

  /**
   * Get only active (non-redeemable) positions
   * Use this for strategies that can only trade on open markets (scalping, selling, etc.)
   */
  getActivePositions(): Position[] {
    return this.getPositions().filter((pos) => !pos.redeemable);
  }

  /**
   * Get active positions that are profitable (pnlPct > 0)
   * This is the source of truth for scalping candidates
   */
  getActiveProfitablePositions(): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct > 0);
  }

  /**
   * Get active positions that are losing (pnlPct < 0)
   * Use this for stop-loss or hedging strategies
   */
  getActiveLosingPositions(): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct < 0);
  }

  /**
   * Get active positions above a profit threshold
   * Use this for scalping with minimum profit requirements
   */
  getActivePositionsAboveTarget(targetPct: number): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get active positions with TRUSTED P&L.
   *
   * CRITICAL: Strategies should use this to ensure they only act on positions
   * where the P&L calculation can be verified.
   */
  getActiveTrustedPositions(): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlTrusted);
  }

  /**
   * Get active profitable positions with TRUSTED P&L.
   * Use this for scalping - only takes profit when we're sure it's actually profit.
   */
  getActiveTrustedProfitablePositions(): Position[] {
    return this.getActivePositions().filter(
      (pos) => pos.pnlTrusted && pos.pnlClassification === "PROFITABLE",
    );
  }

  /**
   * Get active losing positions with TRUSTED P&L.
   * Use this for hedging/stop-loss - only hedge when we're sure it's actually losing.
   */
  getActiveTrustedLosingPositions(): Position[] {
    return this.getActivePositions().filter(
      (pos) => pos.pnlTrusted && pos.pnlClassification === "LOSING",
    );
  }

  /**
   * Get active positions with UNKNOWN (untrusted) P&L.
   * These positions should NOT be acted upon by strategies.
   * Use for diagnostics and rate-limited logging.
   */
  getActiveUnknownPositions(): Position[] {
    return this.getActivePositions().filter((pos) => !pos.pnlTrusted);
  }

  /**
   * Get positions that are candidates for liquidation when funds are insufficient.
   * Used by Smart Hedging to determine what positions to sell to free up funds
   * for hedging other positions.
   *
   * Returns active losing positions sorted by loss percentage (worst losses first),
   * filtered to only include positions with valid side info (required for selling).
   *
   * @param minLossPct - Minimum loss percentage to consider for liquidation (default: DEFAULT_LIQUIDATION_MIN_LOSS_PCT)
   * @param minHoldSeconds - Minimum hold time in seconds before a position can be liquidated (default: DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS)
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  getLiquidationCandidates(
    minLossPct = DEFAULT_LIQUIDATION_MIN_LOSS_PCT,
    minHoldSeconds = DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS,
  ): Position[] {
    const now = Date.now();

    return (
      this.getActiveLosingPositions()
        .filter((pos) => {
          // Must have valid side info for selling
          if (!pos.side || pos.side.trim() === "") {
            return false;
          }

          // Must meet minimum loss threshold
          if (Math.abs(pos.pnlPct) < minLossPct) {
            return false;
          }

          // Must have been held for minimum time (prevent immediate sells on new positions)
          const entryTime = this.getPositionEntryTime(
            pos.marketId,
            pos.tokenId,
          );
          if (entryTime) {
            const holdSeconds = (now - entryTime) / 1000;
            if (holdSeconds < minHoldSeconds) {
              return false;
            }
          }
          // If no entry time, be conservative and include it (may be externally acquired)

          return true;
        })
        // Sort by worst loss first (most negative pnlPct)
        .sort((a, b) => a.pnlPct - b.pnlPct)
    );
  }

  /**
   * Get the total current value (in USD) of positions that could be liquidated.
   * This represents the approximate funds that could be recovered by liquidating
   * losing positions.
   *
   * @param minLossPct - Minimum loss percentage to consider for liquidation (default: DEFAULT_LIQUIDATION_MIN_LOSS_PCT)
   * @param minHoldSeconds - Minimum hold time before a position can be liquidated (default: DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS)
   * @returns Total USD value that could be recovered from liquidation candidates
   */
  getLiquidationCandidatesValue(
    minLossPct = DEFAULT_LIQUIDATION_MIN_LOSS_PCT,
    minHoldSeconds = DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS,
  ): number {
    const candidates = this.getLiquidationCandidates(
      minLossPct,
      minHoldSeconds,
    );
    return candidates.reduce(
      (total, pos) => total + pos.size * pos.currentPrice,
      0,
    );
  }

  /**
   * Threshold for excluding positions near resolution (price >= 90¢).
   * These positions are likely to resolve soon and should not be sold for liquidity.
   */
  private static readonly NEAR_RESOLUTION_THRESHOLD = 0.9;

  /**
   * Get positions that are candidates for profit-based liquidation to free up funds.
   * Used by Smart Hedging to sell *profitable* positions (lowest profit first) when
   * wallet balance is insufficient for hedging, before resorting to selling losing positions.
   *
   * Returns active, non-redeemable, **profitable** positions sorted by lowest profit
   * (pnlPct ascending), excluding:
   * - Positions near resolution (currentPrice >= 0.9)
   * - Positions without a valid side
   * - Positions failing the minimum hold time gate
   *
   * @param minProfitPct - Minimum profit percentage to consider (default: 0 = any profit)
   * @param minHoldSeconds - Minimum hold time in seconds before a position can be sold (default: 60)
   * @returns Array of profitable positions suitable for liquidation, sorted by lowest profit first
   */
  getProfitLiquidationCandidates(
    minProfitPct = 0,
    minHoldSeconds = DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS,
  ): Position[] {
    const now = Date.now();

    return (
      this.getActiveProfitablePositions()
        .filter((pos) => {
          // Must have valid side info for selling
          if (!pos.side || pos.side.trim() === "") {
            return false;
          }

          // Must meet minimum profit threshold
          if (pos.pnlPct < minProfitPct) {
            return false;
          }

          // Exclude positions near resolution (price >= 90¢)
          // These are likely to resolve soon and should be held for redemption
          if (pos.currentPrice >= PositionTracker.NEAR_RESOLUTION_THRESHOLD) {
            return false;
          }

          // Must have been held for minimum time (prevent immediate sells on new positions)
          const entryTime = this.getPositionEntryTime(
            pos.marketId,
            pos.tokenId,
          );
          if (entryTime) {
            const holdSeconds = (now - entryTime) / 1000;
            if (holdSeconds < minHoldSeconds) {
              return false;
            }
          }
          // If no entry time, be conservative and include it (may be externally acquired)

          return true;
        })
        // Sort by lowest profit first (ascending pnlPct) - sell smallest winners first
        .sort((a, b) => a.pnlPct - b.pnlPct)
    );
  }

  /**
   * Get a summary of position counts for logging
   * Provides consistent breakdown across all strategies
   *
   * FORMAT (required by enterprise spec):
   * ACTIVE: total=N (prof=X lose=Y neutral=Z unknown=W) | REDEEMABLE: M
   *
   * CRITICAL: If ACTIVE > 0, we MUST have prof + lose + neutral + unknown = total
   * Otherwise there's a BUG in P&L classification.
   */
  getPositionSummary(): {
    total: number;
    active: number;
    redeemable: number;
    activeProfitable: number;
    activeLosing: number;
    activeBreakeven: number;
    activeUnknown: number;
  } {
    const positions = this.getPositions();
    const active = positions.filter((p) => !p.redeemable);
    const redeemable = positions.filter((p) => p.redeemable);

    // Use pnlClassification for proper categorization
    const activeProfitable = active.filter(
      (p) => p.pnlClassification === "PROFITABLE",
    );
    const activeLosing = active.filter((p) => p.pnlClassification === "LOSING");
    const activeBreakeven = active.filter(
      (p) => p.pnlClassification === "NEUTRAL",
    );
    const activeUnknown = active.filter(
      (p) => p.pnlClassification === "UNKNOWN",
    );

    return {
      total: positions.length,
      active: active.length,
      redeemable: redeemable.length,
      activeProfitable: activeProfitable.length,
      activeLosing: activeLosing.length,
      activeBreakeven: activeBreakeven.length,
      activeUnknown: activeUnknown.length,
    };
  }

  /**
   * Format position summary for logging
   * Uses the new enterprise-required format:
   * ACTIVE: total=N (prof=X lose=Y neutral=Z unknown=W) | REDEEMABLE: M
   */
  formatPositionSummary(): string {
    const summary = this.getPositionSummary();
    return `ACTIVE: total=${summary.active} (prof=${summary.activeProfitable} lose=${summary.activeLosing} neutral=${summary.activeBreakeven} unknown=${summary.activeUnknown}) | REDEEMABLE: ${summary.redeemable}`;
  }

  /**
   * Fetch positions from Polymarket API
   * Fetches user positions from Data API and enriches with current prices
   *
   * OPTIMIZATIONS:
   * - Batches Gamma API calls for outcome fetching (reduces per-token requests)
   * - Uses outcomeCache with TTL management
   * - Logs only on state changes (prevents log spam)
   *
   * DATA-API-DRIVEN P&L (Jan 2025 Refactor):
   * - Uses Data API P&L fields (cashPnl, percentPnl, currentValue, curPrice) as primary source
   * - These fields match what Polymarket UI shows to users (UI-truth)
   * - CLOB orderbook is used for executable mark (what we can actually sell at)
   * - pnlSource indicates where P&L values came from
   */
  private async fetchPositionsFromAPI(): Promise<Position[]> {
    try {
      // STEP 1: Resolve holding address (proxy wallet preferred)
      // NON-NEGOTIABLE RULE #1: Address correctness (proxy-first)
      const holdingAddress = await this.resolveHoldingAddress();

      // Validate holding address
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(holdingAddress);
      if (!isValidAddress) {
        this.logger.error(
          `[PositionTracker] Invalid holding address "${holdingAddress}" - cannot fetch positions`,
        );
        return [];
      }

      // Fetch positions from Data API using holding address
      // Updated Jan 2025 to match the current Data API positions response format.
      // Supports both the new format (introduced in late 2024) and the legacy format for backward compatibility.
      interface ApiPosition {
        // New API format fields (Jan 2025 Data API)
        asset?: string; // Token/asset identifier (replaces token_id/asset_id)
        conditionId?: string; // Market identifier (replaces market/id)
        size?: string | number; // Position size (shares)
        avgPrice?: string | number; // Average entry price (0-1 scale)
        outcome?: string; // "YES" or "NO" outcome
        redeemable?: boolean; // True if market is resolved/closed (no orderbook available)

        // === Data-API P&L fields (UI-TRUTH) ===
        // These fields match what Polymarket UI shows
        cashPnl?: string | number; // Unrealized P&L in USD
        percentPnl?: string | number; // Unrealized P&L percentage
        curPrice?: string | number; // Current market price (0-1 scale)
        currentValue?: string | number; // Current position value (size * curPrice)
        initialValue?: string | number; // Initial cost (size * avgPrice)

        // Legacy fields for backwards compatibility
        id?: string;
        market?: string;
        asset_id?: string;
        token_id?: string;
        side?: string;
        initial_cost?: string | number;
        initial_average_price?: string | number;
      }

      // Build positions URL and log it once per refresh
      const positionsUrl = POLYMARKET_API.POSITIONS_ENDPOINT(holdingAddress);
      if (
        this.logDeduper.shouldLog(
          "Tracker:positions_url",
          HEARTBEAT_INTERVAL_MS,
          positionsUrl,
        )
      ) {
        this.logger.info(`[PositionTracker] positions_url=${positionsUrl}`);
      }

      // === ADDRESS INVARIANT CHECK (D) ===
      // Verify positions_url user param matches cachedHoldingAddress (addressUsed).
      // If mismatch occurs, reject snapshot, log high-severity diagnostic, and retry.
      let urlAddress: string | null = null;
      try {
        // Use URL API for robust parameter extraction
        const parsedUrl = new URL(positionsUrl);
        urlAddress = parsedUrl.searchParams.get("user");
      } catch {
        // Fall back to regex if URL parsing fails (shouldn't happen in practice)
        const urlAddressMatch = positionsUrl.match(/user=([^&]+)/);
        urlAddress = urlAddressMatch ? urlAddressMatch[1] : null;
      }
      if (
        urlAddress &&
        urlAddress.toLowerCase() !== holdingAddress.toLowerCase()
      ) {
        this.logger.error(
          `[PositionTracker] 🐛 ADDRESS_INVARIANT_VIOLATION: positions_url user param (${urlAddress.slice(0, 10)}...) != holdingAddress (${holdingAddress.slice(0, 10)}...)`,
        );
        this.logger.error(
          `[PositionTracker] This is a critical bug that risks the "portfolio collapse" issue. Rejecting fetch, forcing re-probe.`,
        );
        // Force re-probe on next cycle
        this.addressProbeCompleted = false;
        this.cachedHoldingAddress = null;
        this.holdingAddressCacheMs = 0;
        return [];
      }

      let apiPositions = await httpGet<ApiPosition[]>(positionsUrl, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      // === STICKY ADDRESS SELECTION WITH SANITY CHECKS (Jan 2025) ===
      // Prevents address flip-flop by keeping address sticky for ADDRESS_STICKY_DURATION_MS
      // unless specific conditions are met for switching
      const initialPositionCount = apiPositions?.length ?? 0;
      const now = Date.now();

      // Track consecutive zero refreshes for address switching logic
      if (initialPositionCount === 0) {
        this.consecutiveZeroRefreshes++;
      } else {
        this.consecutiveZeroRefreshes = 0;
      }

      // Determine if we should run an address probe based on:
      // 1. Low position count (suspicious shrink)
      // 2. Consecutive zero refreshes exceeded threshold
      // 3. Address hasn't been sticky for minimum duration yet
      const lastGoodRawTotal = this.lastGoodSnapshot?.rawCounts?.rawTotal ?? 0;
      const isUnexpectedlyLow =
        lastGoodRawTotal > 0 &&
        initialPositionCount <
          Math.min(
            5,
            lastGoodRawTotal * PositionTracker.SUSPICIOUS_SHRINK_THRESHOLD,
          );
      const shouldProbeForSwitch =
        this.consecutiveZeroRefreshes >=
          PositionTracker.CONSECUTIVE_ZERO_THRESHOLD || isUnexpectedlyLow;

      // Check if address is still within sticky duration
      const addressIsSticky =
        this.addressStickySince > 0 &&
        now - this.addressStickySince <
          PositionTracker.ADDRESS_STICKY_DURATION_MS;

      // ADDRESS PROBE: Run probe if:
      // - Low count detected and probe hasn't been completed this cycle, OR
      // - Conditions for switching are met (even if probe was done before)
      if (
        (shouldProbeForSwitch ||
          (initialPositionCount <= 2 && !this.addressProbeCompleted)) &&
        this.cachedEOAAddress &&
        this.cachedHoldingAddress
      ) {
        const eoaAddress = this.cachedEOAAddress;
        const proxyAddress = this.cachedHoldingAddress;

        // Only probe if EOA and proxy are different
        if (eoaAddress !== proxyAddress) {
          this.logger.info(
            `[PositionTracker] ADDRESS_PROBE: triggering probe. reason=${isUnexpectedlyLow ? "SUSPICIOUS_SHRINK" : shouldProbeForSwitch ? "CONSECUTIVE_ZERO" : "LOW_COUNT"} ` +
              `currentCount=${initialPositionCount} lastGoodTotal=${lastGoodRawTotal} consecutiveZeros=${this.consecutiveZeroRefreshes}`,
          );

          try {
            // Fetch from both addresses in parallel
            const [eoaPositions, proxyPositions] = await Promise.all([
              httpGet<ApiPosition[]>(
                POLYMARKET_API.POSITIONS_ENDPOINT(eoaAddress),
                { timeout: PositionTracker.API_TIMEOUT_MS },
              ).catch(() => [] as ApiPosition[]),
              httpGet<ApiPosition[]>(
                POLYMARKET_API.POSITIONS_ENDPOINT(proxyAddress),
                { timeout: PositionTracker.API_TIMEOUT_MS },
              ).catch(() => [] as ApiPosition[]),
            ]);

            const eoaCount = eoaPositions?.length ?? 0;
            const proxyCount = proxyPositions?.length ?? 0;

            // Log the probe results with both counts (always)
            this.logger.info(
              `[PositionTracker] address_probe: eoa_positions=${eoaCount} proxy_positions=${proxyCount} ` +
                `currentUsing=${holdingAddress === eoaAddress ? "EOA" : "PROXY"} addressSticky=${addressIsSticky}`,
            );

            // Determine if we should switch addresses
            // Switch if:
            // 1. Not within sticky duration, OR
            // 2. Alternate returns >= ADDRESS_SWITCH_RATIO_THRESHOLD times more positions
            const currentCount =
              holdingAddress === eoaAddress ? eoaCount : proxyCount;
            const alternateCount =
              holdingAddress === eoaAddress ? proxyCount : eoaCount;
            const shouldSwitchDueToRatio =
              alternateCount >=
              currentCount * PositionTracker.ADDRESS_SWITCH_RATIO_THRESHOLD;
            const shouldSwitchDueToZero =
              currentCount === 0 &&
              alternateCount > 0 &&
              this.consecutiveZeroRefreshes >=
                PositionTracker.CONSECUTIVE_ZERO_THRESHOLD;

            if (
              !addressIsSticky ||
              shouldSwitchDueToRatio ||
              shouldSwitchDueToZero
            ) {
              // Pick the address with more positions
              if (eoaCount > proxyCount && eoaCount > initialPositionCount) {
                apiPositions = eoaPositions;
                const previousAddress = this.cachedHoldingAddress;
                this.cachedHoldingAddress = eoaAddress;
                this.holdingAddressCacheMs = now;
                this.addressStickySince = now;
                this.consecutiveZeroRefreshes = 0;
                this.logger.warn(
                  `[PositionTracker] ADDRESS_SWITCH: ${previousAddress?.slice(0, 10)}...->EOA (${eoaCount} positions vs ${proxyCount} proxy). ` +
                    `reason=${shouldSwitchDueToRatio ? "RATIO_THRESHOLD" : shouldSwitchDueToZero ? "ZERO_THRESHOLD" : "BETTER_COUNT"}`,
                );
              } else if (
                proxyCount > eoaCount &&
                proxyCount > initialPositionCount
              ) {
                apiPositions = proxyPositions;
                const previousAddress = this.cachedHoldingAddress;
                this.cachedHoldingAddress = proxyAddress;
                this.holdingAddressCacheMs = now;
                this.addressStickySince = now;
                this.consecutiveZeroRefreshes = 0;
                this.logger.warn(
                  `[PositionTracker] ADDRESS_SWITCH: ${previousAddress?.slice(0, 10)}...->PROXY (${proxyCount} positions vs ${eoaCount} EOA). ` +
                    `reason=${shouldSwitchDueToRatio ? "RATIO_THRESHOLD" : shouldSwitchDueToZero ? "ZERO_THRESHOLD" : "BETTER_COUNT"}`,
                );
              } else if (
                eoaCount === proxyCount &&
                eoaCount > initialPositionCount
              ) {
                // Equal counts but better than initial - prefer current address
                this.logger.info(
                  `[PositionTracker] ADDRESS_PROBE: Equal counts (${eoaCount}), keeping current address`,
                );
              }
            } else {
              this.logger.info(
                `[PositionTracker] ADDRESS_PROBE: Address is sticky (${Math.round((now - this.addressStickySince) / 1000)}s < ${Math.round(PositionTracker.ADDRESS_STICKY_DURATION_MS / 1000)}s), not switching. ` +
                  `current=${currentCount} alternate=${alternateCount}`,
              );
            }

            // Set sticky timestamp if not already set
            if (this.addressStickySince === 0) {
              this.addressStickySince = now;
            }
            this.addressProbeCompleted = true;
          } catch (probeErr) {
            this.logger.warn(
              `[PositionTracker] Address probe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`,
            );
          }
        } else {
          this.addressProbeCompleted = true; // No point probing if both addresses are same
        }
      }

      // === RAW COUNTS BEFORE ANY FILTERING ===
      // Log raw counts to diagnose where positions are being lost
      const rawTotal = apiPositions?.length ?? 0;
      const rawActiveCandidates =
        apiPositions?.filter((p) => {
          const size =
            typeof p.size === "string" ? parseFloat(p.size) : (p.size ?? 0);
          return size > 0;
        }).length ?? 0;
      const rawRedeemableCandidates =
        apiPositions?.filter((p) => p.redeemable === true).length ?? 0;

      // Store raw counts for ACTIVE_COLLAPSE_BUG detection in createSnapshot
      this.lastRawCounts = {
        rawTotal,
        rawActiveCandidates,
        rawRedeemableCandidates,
      };
      // Clear classification reasons for this cycle
      this.lastClassificationReasons.clear();

      // Log raw counts once per refresh or when counts change
      const rawCountsFingerprint = `${rawTotal}-${rawActiveCandidates}-${rawRedeemableCandidates}`;
      if (
        this.logDeduper.shouldLog(
          "Tracker:raw_counts",
          HEARTBEAT_INTERVAL_MS,
          rawCountsFingerprint,
        )
      ) {
        this.logger.info(
          `[PositionTracker] raw_total=${rawTotal} raw_active_candidates=${rawActiveCandidates} raw_redeemable_candidates=${rawRedeemableCandidates}`,
        );
      }

      if (!apiPositions || apiPositions.length === 0) {
        // Rate-limit "no positions" log
        if (
          this.logDeduper.shouldLog(
            "Tracker:no_positions",
            HEARTBEAT_INTERVAL_MS,
          )
        ) {
          this.logger.debug(
            `[PositionTracker] No positions found for ${holdingAddress.slice(0, 10)}...`,
          );
        }
        return [];
      }

      // Rate-limit "fetched N positions" log - log on count change or heartbeat
      const countFingerprint = String(apiPositions.length);
      if (
        this.logDeduper.shouldLog(
          "Tracker:fetched_count",
          HEARTBEAT_INTERVAL_MS,
          countFingerprint,
        )
      ) {
        this.logger.debug(
          `[PositionTracker] Fetched ${apiPositions.length} positions from Data API (addr=${holdingAddress.slice(0, 10)}...)`,
        );
      }

      // PHASE 1: Pre-process positions and collect tokenIds needing outcome fetch
      // This allows us to batch the Gamma API calls
      interface ParsedPosition {
        apiPos: ApiPosition;
        tokenId: string;
        marketId: string;
        conditionId: string; // Store separately for clarity
        size: number;
        entryPrice: number;
        side: string;
        isRedeemable: boolean;
        // Data-API P&L fields (may be undefined if not provided)
        dataApiPnlUsd?: number;
        dataApiPnlPct?: number;
        dataApiCurPrice?: number;
        dataApiCurrentValue?: number;
        dataApiInitialValue?: number;
      }

      const parsedPositions: ParsedPosition[] = [];
      const skippedPositions: Array<{ reason: string; data: ApiPosition }> = [];
      const tokenIdsNeedingOutcome: string[] = [];

      // Helper to track classification reasons
      const trackSkipReason = (reason: string) => {
        // Extract reason category (e.g., "Missing required fields" -> "MISSING_FIELDS")
        let category = "OTHER";
        if (reason.includes("Missing required fields"))
          category = "MISSING_FIELDS";
        else if (reason.includes("Invalid size/price"))
          category = "INVALID_SIZE_PRICE";
        else if (reason.includes("Missing or invalid side"))
          category = "MISSING_SIDE";
        else if (reason.includes("Failed to enrich"))
          category = "ENRICH_FAILED";

        this.lastClassificationReasons.set(
          category,
          (this.lastClassificationReasons.get(category) ?? 0) + 1,
        );
      };

      for (const apiPos of apiPositions) {
        // Try new API format first, then fall back to legacy format
        const tokenId = apiPos.asset ?? apiPos.token_id ?? apiPos.asset_id;
        const marketId = apiPos.conditionId ?? apiPos.market ?? apiPos.id;

        if (!tokenId || !marketId) {
          const reason = `Missing required fields - tokenId: ${tokenId || "MISSING"}, marketId: ${marketId || "MISSING"}`;
          skippedPositions.push({ reason, data: apiPos });
          trackSkipReason(reason);
          this.logger.debug(`[PositionTracker] ${reason}`);
          continue;
        }

        const size =
          typeof apiPos.size === "string"
            ? parseFloat(apiPos.size)
            : (apiPos.size ?? 0);

        const entryPrice = this.parseEntryPrice(apiPos);

        if (size <= 0 || entryPrice <= 0) {
          const reason = `Invalid size/price - size: ${size}, entryPrice: ${entryPrice}`;
          skippedPositions.push({ reason, data: apiPos });
          trackSkipReason(reason);
          this.logger.debug(`[PositionTracker] ${reason}`);
          continue;
        }

        const sideValue = apiPos.outcome ?? apiPos.side;

        if (
          !sideValue ||
          typeof sideValue !== "string" ||
          sideValue.trim() === ""
        ) {
          const reason = `Missing or invalid side/outcome value for tokenId ${tokenId}`;
          skippedPositions.push({ reason, data: apiPos });
          trackSkipReason(reason);
          this.logger.warn(`[PositionTracker] ${reason}`);
          continue;
        }

        const side = sideValue.trim();
        const isRedeemable = apiPos.redeemable === true;

        // Parse Data-API P&L fields (UI-truth)
        // These fields match what Polymarket UI shows to users
        const dataApiPnlUsd = this.parseNumericField(apiPos.cashPnl);
        const dataApiPnlPct = this.parseNumericField(apiPos.percentPnl);
        const dataApiCurPrice = this.parseNumericField(apiPos.curPrice);
        const dataApiCurrentValue = this.parseNumericField(apiPos.currentValue);
        const dataApiInitialValue = this.parseNumericField(apiPos.initialValue);

        parsedPositions.push({
          apiPos,
          tokenId,
          marketId,
          conditionId: marketId, // Store conditionId explicitly (same as marketId from Data API)
          size,
          entryPrice,
          side,
          isRedeemable,
          // Include Data-API P&L fields
          dataApiPnlUsd,
          dataApiPnlPct,
          dataApiCurPrice,
          dataApiCurrentValue,
          dataApiInitialValue,
        });

        // Check if we need to fetch outcome from Gamma
        // Only for redeemable positions that don't have a valid cached outcome
        if (isRedeemable) {
          const cachedEntry = this.getOutcomeCacheEntry(tokenId);
          if (!cachedEntry) {
            // Also check the legacy marketOutcomeCache
            const legacyCached = this.marketOutcomeCache.get(marketId);
            if (!legacyCached) {
              tokenIdsNeedingOutcome.push(tokenId);
              this.currentRefreshMetrics.cacheMisses++;
            } else {
              this.currentRefreshMetrics.cacheHits++;
            }
          }
        }
      }

      // PHASE 2: Batch fetch outcomes from Gamma API for all tokenIds needing outcome
      let batchedOutcomes = new Map<string, string | null>();
      if (tokenIdsNeedingOutcome.length > 0) {
        batchedOutcomes = await this.fetchMarketOutcomesBatch(
          tokenIdsNeedingOutcome,
        );

        // Update caches with fetched results
        const now = Date.now();
        for (const [tokenId, winner] of batchedOutcomes) {
          if (winner !== null) {
            // Store in enhanced outcomeCache
            this.setOutcomeCacheEntry(tokenId, {
              winner,
              resolvedPrice: -1, // Will be calculated based on side match
              resolvedAtMs: now,
              lastCheckedMs: now,
              status: "RESOLVED",
            });

            // Also store in legacy cache by marketId for backward compatibility
            const parsed = parsedPositions.find((p) => p.tokenId === tokenId);
            if (parsed) {
              if (
                this.marketOutcomeCache.size >=
                PositionTracker.MAX_OUTCOME_CACHE_SIZE
              ) {
                const firstKey = this.marketOutcomeCache.keys().next().value;
                if (firstKey) {
                  this.marketOutcomeCache.delete(firstKey);
                }
              }
              this.marketOutcomeCache.set(parsed.marketId, winner);
            }
          }
        }
      }

      // PHASE 3: Process positions with pricing and P&L calculation
      const positions: Position[] = [];
      const maxConcurrent = 5; // Rate limit concurrent orderbook fetches

      // Track stats for summary logging
      let resolvedCount = 0;
      let activeCount = 0;
      let newlyCachedMarkets = batchedOutcomes.size;

      for (let i = 0; i < parsedPositions.length; i += maxConcurrent) {
        const batch = parsedPositions.slice(i, i + maxConcurrent);
        const batchResults = await Promise.allSettled(
          batch.map(async (parsed) => {
            try {
              const {
                tokenId,
                marketId,
                conditionId,
                size,
                entryPrice,
                side,
                apiPos,
                // Data-API P&L fields (UI-truth)
                dataApiPnlUsd,
                dataApiPnlPct,
                dataApiCurPrice,
                dataApiCurrentValue,
                dataApiInitialValue,
              } = parsed;

              // Skip orderbook fetch for resolved/closed markets (no orderbook available)
              let currentPrice: number;
              let bestBidPrice: number | undefined;
              let bestAskPrice: number | undefined;
              let positionStatus: PositionStatus = "ACTIVE";
              let cacheAgeMs: number | undefined;

              // === NEW: Book status tracking (Jan 2025 - Decouple from snapshot) ===
              // Track orderbook availability separately from position state.
              // SAFE DEFAULTS: Initialize to "not tradable" state.
              // - bookStatus = NOT_FETCHED: We haven't attempted to fetch the orderbook yet
              // - executionStatus = NOT_TRADABLE_ON_CLOB: Default to non-tradable until proven otherwise
              // - execPriceTrusted = false: Don't trust the executable price until we have valid orderbook data
              // These will be updated to AVAILABLE/TRADABLE/true if orderbook fetch succeeds.
              let bookStatus: BookStatus = "NOT_FETCHED";
              let executionStatus: ExecutionStatus = "NOT_TRADABLE_ON_CLOB";
              let execPriceTrusted = false;

              // P&L source tracking: where did the P&L values come from?
              let pnlSource: PnLSource = "FALLBACK";
              // Track if pricing fetch completely failed (for pnlUntrustedReason)
              let pricingFetchFailed = false;

              // === SIMPLIFIED REDEEMABLE DETECTION (Jan 2025 Refactor) ===
              // ONLY trust explicit sources - NO internal inference/guessing:
              // 1. Data API explicitly says redeemable: true (DATA_API_FLAG)
              // 2. On-chain payoutDenominator > 0 (ONCHAIN_DENOM)
              // We do NOT infer redeemability from:
              // - Missing orderbook
              // - Gamma API closed/resolved flags
              // - Price being near 100¢ or 0¢
              const apiRedeemable = apiPos.redeemable === true;
              let isRedeemable = apiRedeemable; // Trust Data API directly

              if (isRedeemable) {
                // Data API says position is redeemable - set status accordingly
                positionStatus = "REDEEMABLE";

                // Fetch winning outcome from cache or API (for P&L calculation)
                let winningOutcome: string | null | undefined =
                  this.marketOutcomeCache.get(marketId);
                const wasCached =
                  winningOutcome !== undefined && winningOutcome !== null;

                if (!wasCached) {
                  winningOutcome = await this.fetchMarketOutcome(tokenId);
                  // Only cache definite outcomes; avoid caching null/undefined that may come from transient API errors
                  if (winningOutcome !== null && winningOutcome !== undefined) {
                    // Enforce maximum cache size to prevent unbounded memory growth
                    if (
                      this.marketOutcomeCache.size >=
                      PositionTracker.MAX_OUTCOME_CACHE_SIZE
                    ) {
                      // Remove oldest entry (first key in Map iteration order)
                      const firstKey = this.marketOutcomeCache
                        .keys()
                        .next().value;
                      if (firstKey) {
                        this.marketOutcomeCache.delete(firstKey);
                      }
                    }
                    this.marketOutcomeCache.set(marketId, winningOutcome);
                    newlyCachedMarkets++;
                  }
                }

                if (!winningOutcome) {
                  // Cannot determine outcome from Gamma API, but position is marked redeemable
                  // Try to fetch actual price from orderbook or price API first
                  // This is important for profit calculation - don't default to entryPrice which makes pnlPct=0%
                  try {
                    // First try orderbook
                    if (!this.missingOrderbooks.has(tokenId)) {
                      try {
                        const orderbook =
                          await this.client.getOrderBook(tokenId);
                        // Use safe extraction to ensure bestBid = max(bids), bestAsk = min(asks)
                        const priceExtraction =
                          extractOrderbookPrices(orderbook);
                        if (
                          priceExtraction.bestBid !== null &&
                          priceExtraction.bestAsk !== null &&
                          !priceExtraction.hasAnomaly
                        ) {
                          currentPrice =
                            (priceExtraction.bestBid +
                              priceExtraction.bestAsk) /
                            2;
                          this.logger.debug(
                            `[PositionTracker] Redeemable with unknown outcome: using orderbook price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                          );
                        } else if (priceExtraction.hasAnomaly) {
                          // Orderbook has anomaly (crossed book, extreme spread), use fallback
                          this.logger.debug(
                            `[PositionTracker] Redeemable with orderbook anomaly for tokenId=${tokenId.slice(0, 16)}...: ${priceExtraction.anomalyReason}, using fallback`,
                          );
                          currentPrice = await this.fetchPriceFallback(tokenId);
                        } else {
                          // Empty orderbook, try price fallback
                          this.missingOrderbooks.add(tokenId);
                          currentPrice = await this.fetchPriceFallback(tokenId);
                          this.logger.debug(
                            `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                          );
                        }
                      } catch {
                        // Orderbook fetch failed, try price fallback
                        this.missingOrderbooks.add(tokenId);
                        currentPrice = await this.fetchPriceFallback(tokenId);
                        this.logger.debug(
                          `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                        );
                      }
                    } else {
                      // Already know orderbook is missing, use price fallback
                      currentPrice = await this.fetchPriceFallback(tokenId);
                      this.logger.debug(
                        `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                      );
                    }
                  } catch (priceErr) {
                    // All pricing methods failed - use entryPrice as last resort
                    // This prevents silent position drops but may show 0% profit
                    currentPrice = entryPrice;
                    this.logger.warn(
                      `[PositionTracker] ⚠️ Redeemable with unknown outcome AND price fetch failed for tokenId=${tokenId.slice(0, 16)}..., using entryPrice=${entryPrice} (will show 0% profit)`,
                    );
                  }
                  resolvedCount++;
                } else {
                  // Calculate settlement price based on whether position won or lost
                  // Normalize both strings for comparison (case-insensitive, trimmed)
                  const normalizedSide = side.toLowerCase().trim();
                  const normalizedWinner = winningOutcome.toLowerCase().trim();
                  currentPrice =
                    normalizedSide === normalizedWinner ? 1.0 : 0.0;
                  resolvedCount++;

                  // Log only on state change (prevents repeated "Detected resolved position" logs)
                  this.logResolvedPositionIfChanged(
                    tokenId,
                    side,
                    winningOutcome,
                    currentPrice,
                    "RESOLVED",
                  );
                }
              } else {
                // Active market - fetch current orderbook with fallback to price API
                // CRITICAL: Use BEST BID as mark price for P&L (what we can actually sell at)
                // This fixes the previous bug where mid-price caused 0.0% P&L readings

                try {
                  // Check TTL cache first
                  const cached = this.orderbookCache.get(tokenId);
                  const now = Date.now();

                  if (
                    cached &&
                    now - cached.fetchedAt <
                      PositionTracker.ORDERBOOK_CACHE_TTL_MS
                  ) {
                    // Use cached values
                    bestBidPrice = cached.bestBid;
                    bestAskPrice = cached.bestAsk;
                    cacheAgeMs = now - cached.fetchedAt;
                    currentPrice = bestBidPrice; // Use BEST BID as mark price
                    // === BookStatus: AVAILABLE (from cache) ===
                    bookStatus = "AVAILABLE";
                    executionStatus = "TRADABLE";
                    execPriceTrusted = true;
                  } else if (this.missingOrderbooks.has(tokenId)) {
                    // Skip orderbook fetch if we know it's missing (cached)
                    positionStatus = "NO_BOOK";
                    currentPrice = await this.fetchPriceFallback(tokenId);
                    // === BookStatus: NO_BOOK_404 (cached from previous 404) ===
                    bookStatus = "NO_BOOK_404";
                    executionStatus = "NOT_TRADABLE_ON_CLOB";
                    execPriceTrusted = false;
                  } else {
                    try {
                      const orderbook = await this.client.getOrderBook(tokenId);

                      // Use safe extraction to ensure bestBid = max(bids), bestAsk = min(asks)
                      const priceExtraction = extractOrderbookPrices(orderbook);

                      if (
                        priceExtraction.bestBid === null ||
                        priceExtraction.bestAsk === null
                      ) {
                        // Orderbook is empty - cache and use fallback
                        this.missingOrderbooks.add(tokenId);
                        positionStatus = "NO_BOOK";
                        this.logger.debug(
                          `[PositionTracker] Empty orderbook for tokenId: ${tokenId}, using fallback price API`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                        // === BookStatus: EMPTY_BOOK ===
                        bookStatus = "EMPTY_BOOK";
                        executionStatus = "NOT_TRADABLE_ON_CLOB";
                        execPriceTrusted = false;
                      } else if (priceExtraction.hasAnomaly) {
                        // Orderbook has anomaly (crossed book, extreme spread) - use fallback
                        positionStatus = "NO_BOOK";
                        this.logger.warn(
                          `[PositionTracker] INVALID_BOOK for tokenId=${tokenId.slice(0, 16)}...: ${priceExtraction.anomalyReason} ` +
                            `bestBid=${(priceExtraction.bestBid * 100).toFixed(2)}¢ bestAsk=${(priceExtraction.bestAsk * 100).toFixed(2)}¢ ` +
                            `bidCount=${priceExtraction.bidCount} askCount=${priceExtraction.askCount} - using fallback`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                        // === BookStatus: BOOK_ANOMALY ===
                        bookStatus = "BOOK_ANOMALY";
                        executionStatus = "NOT_TRADABLE_ON_CLOB";
                        execPriceTrusted = false;
                      } else {
                        bestBidPrice = priceExtraction.bestBid;
                        bestAskPrice = priceExtraction.bestAsk;

                        // CRITICAL FIX: Use BEST BID as mark price for P&L
                        // This is what we can actually sell at, not the mid-price
                        currentPrice = bestBidPrice;
                        cacheAgeMs = 0; // Fresh fetch
                        // === BookStatus: AVAILABLE ===
                        bookStatus = "AVAILABLE";
                        executionStatus = "TRADABLE";
                        execPriceTrusted = true;

                        // Cache the orderbook data with proper eviction
                        // Remove entries until we're under the limit before adding new one
                        while (
                          this.orderbookCache.size >=
                          PositionTracker.MAX_ORDERBOOK_CACHE_SIZE
                        ) {
                          // Remove oldest entry (first key in Map iteration order - FIFO)
                          const firstKey = this.orderbookCache
                            .keys()
                            .next().value;
                          if (firstKey) {
                            this.orderbookCache.delete(firstKey);
                          } else {
                            break; // Safety: exit if no keys found
                          }
                        }
                        this.orderbookCache.set(tokenId, {
                          bestBid: bestBidPrice,
                          bestAsk: bestAskPrice,
                          fetchedAt: Date.now(),
                        });

                        // P&L SANITY CHECK: Validate computed price against UI-like expectations
                        // If computed bid is near 0 but market looks liquid, flag potential mismatch
                        const spread = bestAskPrice - bestBidPrice;
                        const midPrice = (bestBidPrice + bestAskPrice) / 2;
                        if (
                          bestBidPrice <
                            PositionTracker.SANITY_CHECK_BID_NEAR_ZERO &&
                          midPrice >
                            PositionTracker.SANITY_CHECK_MID_PRICE_MIN &&
                          spread < PositionTracker.SANITY_CHECK_MAX_SPREAD
                        ) {
                          // Bid near zero but market appears liquid - likely a bug
                          this.logger.error(
                            `[PositionTracker] ⚠️ TOKEN_MISMATCH_OR_BOOK_FETCH_BUG: tokenId=${tokenId.slice(0, 16)}..., ` +
                              `bid=${(bestBidPrice * 100).toFixed(2)}¢, ask=${(bestAskPrice * 100).toFixed(2)}¢, ` +
                              `mid=${(midPrice * 100).toFixed(2)}¢, spread=${(spread * 100).toFixed(2)}¢ - ` +
                              `Book appears liquid but bid near zero`,
                          );
                          // Log first 3 levels for debugging
                          this.logger.debug(
                            `[PositionTracker] Book levels for ${tokenId.slice(0, 16)}...: ` +
                              `bids=[${(orderbook.bids ?? [])
                                .slice(0, 3)
                                .map((b) => `${b.price}@${b.size}`)
                                .join(", ")}], ` +
                              `asks=[${(orderbook.asks ?? [])
                                .slice(0, 3)
                                .map((a) => `${a.price}@${a.size}`)
                                .join(", ")}]`,
                          );
                        }
                      }
                    } catch (orderbookErr) {
                      const orderbookErrMsg =
                        orderbookErr instanceof Error
                          ? orderbookErr.message
                          : String(orderbookErr);
                      if (
                        orderbookErrMsg.includes("404") ||
                        orderbookErrMsg.includes("not found") ||
                        orderbookErrMsg.includes("No orderbook exists")
                      ) {
                        // 404 or not found - cache and use fallback
                        this.missingOrderbooks.add(tokenId);
                        positionStatus = "NO_BOOK";
                        this.logger.debug(
                          `[PositionTracker] Orderbook not found for tokenId: ${tokenId}, using fallback price API`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                        // === BookStatus: NO_BOOK_404 ===
                        bookStatus = "NO_BOOK_404";
                        executionStatus = "NOT_TRADABLE_ON_CLOB";
                        execPriceTrusted = false;
                      } else {
                        // Other error - rethrow
                        throw orderbookErr;
                      }
                    }
                  }
                } catch (err) {
                  // CRITICAL FIX: If all pricing methods fail, DO NOT drop the position.
                  // Keep it as ACTIVE with unknown P&L instead of removing it.
                  // This prevents positions from disappearing just because orderbook is missing.
                  const errMsg =
                    err instanceof Error ? err.message : String(err);
                  this.logger.debug(
                    `[PositionTracker] Failed to fetch price data for ${tokenId.slice(0, 16)}...: ${errMsg} - keeping as ACTIVE with unknown P&L`,
                  );
                  // Use entry price as current price (will show 0% P&L but position is preserved)
                  currentPrice = entryPrice;
                  positionStatus = "NO_BOOK";
                  pricingFetchFailed = true;
                  // === BookStatus: NO_BOOK_404 (pricing fetch failed) ===
                  bookStatus = "NO_BOOK_404";
                  executionStatus = "NOT_TRADABLE_ON_CLOB";
                  execPriceTrusted = false;
                }
                // Increment activeCount only after successful pricing
                activeCount++;
              }

              // === STRICT STATE MACHINE: REDEEMABLE DETERMINATION ===
              // NON-NEGOTIABLE: Do NOT infer REDEEMABLE from:
              // - Price near 1.0 or 0.0
              // - Empty orderbook
              // - Gamma winner metadata alone
              //
              // ONLY mark REDEEMABLE if:
              // (a) Data-API explicitly returned redeemable=true, OR
              // (b) On-chain payoutDenominator > 0
              //
              // TODO: Implement on-chain ConditionalTokens.payoutDenominator check
              // for positions where Data-API is stale but on-chain resolution exists.
              // This would require: tokenId -> conditionId mapping, then calling
              // ConditionalTokens contract on Polygon.
              //
              // REMOVED: The old "FALLBACK REDEMPTION DETECTION" that incorrectly inferred
              // redeemable status from prices at 99¢+ or 1¢-. This caused the bug where
              // raw_redeemable_candidates=10 but final output showed 33 resolved positions.

              let finalRedeemable = isRedeemable; // Trust ONLY Data-API flag
              let redeemableProofSource: RedeemableProofSource = "NONE";
              let positionState: PositionState = "ACTIVE";
              let marketClosed = false;

              if (isRedeemable) {
                // Data-API explicitly flagged this position as redeemable
                positionState = "REDEEMABLE";
                redeemableProofSource = "DATA_API_FLAG";
                finalRedeemable = true;

                // Log the promotion with proof source
                this.logger.debug(
                  `[PositionTracker] promote->REDEEMABLE tokenId=${tokenId.slice(0, 16)}... reason=DATA_API_FLAG`,
                );
              } else {
                // Position is NOT redeemable per Data-API
                // Check if market might be CLOSED_NOT_REDEEMABLE (Gamma says closed but not on-chain yet)
                //
                // NOTE: We do NOT use price or Gamma winner to infer REDEEMABLE.
                // If Gamma says market is closed but Data-API doesn't say redeemable,
                // it's CLOSED_NOT_REDEEMABLE (waiting for on-chain resolution).

                // For diagnostic purposes, check if price suggests the market might be near resolution
                // This is used for logging/diagnostics only, NOT to change state
                // UPDATED: Use centralized isNearResolution() with safety guard (price >= 50¢)
                const priceNearResolution = isNearResolution(currentPrice);

                // Safety guard: NEVER classify prices < 50¢ as near-resolution
                // This prevents false positives from broken/stale orderbook data
                if (priceNearResolution) {
                  // Log diagnostic: price suggests resolved but Data-API says NOT redeemable
                  // This is EXPECTED behavior - we keep it ACTIVE until Data-API confirms
                  // RENAMED: "price_near_resolution" -> "near_resolution_candidate" for clarity
                  this.logger.debug(
                    `[PositionTracker] near_resolution_candidate tokenId=${tokenId.slice(0, 16)}... price=${formatCents(currentPrice)} but redeemable=false, keeping ACTIVE`,
                  );

                  // === ON-CHAIN REDEEMABLE CHECK ===
                  // When position has:
                  // 1. Price near 100¢ (or 0¢) - suggesting resolution
                  // 2. NO_BOOK status (no orderbook bids) - can't sell via SellEarly
                  // 3. Data-API hasn't flagged as redeemable yet
                  //
                  // Check on-chain payoutDenominator to confirm if actually redeemable.
                  // This fixes the gap where high-profit positions at 100¢ get stuck.
                  const hasNoBids =
                    positionStatus === "NO_BOOK" ||
                    bestBidPrice === undefined ||
                    bestBidPrice === 0;

                  if (hasNoBids && marketId) {
                    // Condition: price at 99%+, no bids available, check on-chain
                    const isOnChainResolved =
                      await this.checkOnChainRedeemable(marketId);

                    if (isOnChainResolved) {
                      // On-chain confirms resolved - promote to REDEEMABLE
                      positionState = "REDEEMABLE";
                      redeemableProofSource = "ONCHAIN_DENOM";
                      finalRedeemable = true;

                      // Set appropriate current price for winner/loser
                      // Price >= 99¢ means winner, price <= 1¢ means loser
                      if (
                        currentPrice >=
                        PositionTracker.RESOLVED_PRICE_HIGH_THRESHOLD
                      ) {
                        currentPrice = 1.0; // Winner
                      } else {
                        currentPrice = 0.0; // Loser
                      }

                      this.logger.info(
                        `[PositionTracker] 🎯 ONCHAIN_DENOM: promote->REDEEMABLE tokenId=${tokenId.slice(0, 16)}... ` +
                          `(price=${(currentPrice * 100).toFixed(1)}¢, no_bids=true, on-chain payoutDenominator > 0)`,
                      );
                    }
                  }

                  // If not promoted to REDEEMABLE via on-chain, check Gamma for market closed status
                  if (!finalRedeemable) {
                    // Check Gamma for market closed status (NOT redeemable)
                    // This helps strategies know to stop trading, but position is NOT redeemable yet
                    const cached = this.outcomeCache.get(tokenId);
                    if (cached?.status === "RESOLVED") {
                      // Gamma previously said this market is resolved
                      // Mark as CLOSED_NOT_REDEEMABLE (trading should stop, but NOT redeemable)
                      positionState = "CLOSED_NOT_REDEEMABLE";
                      marketClosed = true;
                      this.logger.debug(
                        `[PositionTracker] state=CLOSED_NOT_REDEEMABLE tokenId=${tokenId.slice(0, 16)}... (Gamma cached resolved, Data-API not redeemable yet)`,
                      );
                    }
                  }
                }

                // Position stays ACTIVE (or CLOSED_NOT_REDEEMABLE if Gamma says closed)
                // unless promoted to REDEEMABLE via ONCHAIN_DENOM check above
              }

              // === MULTI-SOURCE P&L PIPELINE ===
              // NON-NEGOTIABLE RULE #2: Use Data-API positions as canonical portfolio truth
              // NON-NEGOTIABLE RULE #3: Only use CLOB orderbook to compute "executable" mark
              //
              // Priority order:
              // 1. Data-API P&L fields (cashPnl, percentPnl) - UI-truth
              // 2. CLOB orderbook best bid (executable mark)
              // 3. Fallback price API (least accurate)

              // Final P&L values to use
              let pnlUsd: number;
              let pnlPct: number;

              // Executable P&L from CLOB (optional enhancement)
              let executablePnlUsd: number | undefined;
              let executableMarkCents: number | undefined;

              // === SCENARIO 1: Data-API has P&L values (UI-TRUTH) ===
              // This is the CANONICAL source that matches Polymarket UI
              const hasDataApiPnl =
                dataApiPnlPct !== undefined && dataApiPnlUsd !== undefined;

              // WHY !finalRedeemable: Redeemable positions are handled separately because:
              // 1. Their settlement price is CERTAIN (1.0 for winner, 0.0 for loser)
              // 2. Data-API P&L may lag behind actual resolution status
              // 3. We've already computed the definitive settlement price above
              // For ACTIVE positions, Data-API P&L is preferred as it matches UI.
              if (hasDataApiPnl && !finalRedeemable) {
                // Use Data-API P&L as primary (matches UI)
                pnlUsd = dataApiPnlUsd;
                pnlPct = dataApiPnlPct;
                pnlSource = "DATA_API";

                // Use curPrice from Data-API as currentPrice if available
                if (dataApiCurPrice !== undefined) {
                  currentPrice = dataApiCurPrice;
                }

                // Additionally compute executable P&L from CLOB best bid (what we can actually sell at)
                if (bestBidPrice !== undefined && bestBidPrice > 0) {
                  executableMarkCents = bestBidPrice * 100;
                  executablePnlUsd = (bestBidPrice - entryPrice) * size;
                }
              } else if (finalRedeemable) {
                // Redeemable positions: P&L is settlement-based (100% certainty)
                // currentPrice was already set above to 1.0 (winner) or 0.0 (loser)
                pnlUsd = (currentPrice - entryPrice) * size;
                pnlPct =
                  entryPrice > 0
                    ? ((currentPrice - entryPrice) / entryPrice) * 100
                    : 0;
                pnlSource = "DATA_API"; // Redeemable always trusted (settlement is certain)
              } else if (bestBidPrice !== undefined && bestBidPrice > 0) {
                // === SCENARIO 2: No Data-API P&L, but CLOB orderbook available ===
                // Use CLOB best bid as mark price (executable P&L)
                currentPrice = bestBidPrice;
                pnlUsd = (currentPrice - entryPrice) * size;
                pnlPct =
                  entryPrice > 0
                    ? ((currentPrice - entryPrice) / entryPrice) * 100
                    : 0;
                pnlSource = "EXECUTABLE_BOOK";
                executableMarkCents = bestBidPrice * 100;
                executablePnlUsd = pnlUsd;
              } else {
                // === SCENARIO 3: Fallback - neither Data-API nor CLOB available ===
                // Use fallback price (mid-price from /price endpoint)
                pnlUsd = (currentPrice - entryPrice) * size;
                pnlPct =
                  entryPrice > 0
                    ? ((currentPrice - entryPrice) / entryPrice) * 100
                    : 0;
                pnlSource = "FALLBACK";
              }

              // === P&L TRUST DETERMINATION (UPDATED) ===
              // NON-NEGOTIABLE RULE #3: If Data-API provides P&L, trust it even if CLOB book missing
              // P&L is TRUSTED when:
              // 1. Data-API has valid P&L values (pnlSource === "DATA_API")
              // 2. CLOB orderbook has valid bid price (pnlSource === "EXECUTABLE_BOOK")
              // 3. Position is redeemable (settlement price is certain)
              let pnlTrusted = true;
              let pnlUntrustedReason: string | undefined;

              if (finalRedeemable) {
                // Redeemable positions always trusted
                pnlTrusted = true;
              } else if (pnlSource === "DATA_API") {
                // Data-API P&L is trusted (matches UI)
                pnlTrusted = true;
              } else if (pnlSource === "EXECUTABLE_BOOK") {
                // CLOB orderbook P&L is trusted (executable)
                pnlTrusted = true;
              } else if (pnlSource === "FALLBACK") {
                // Fallback P&L is NOT fully trusted - no reliable orderbook mark price
                // HOWEVER: If Data-API provided pricing info, we can still trust the P&L.
                //
                // WHY curPrice OR currentValue is sufficient:
                // - curPrice: The Data-API's market price - same source as Polymarket UI
                // - currentValue: size * curPrice - if this exists, curPrice was used internally
                // Either field indicates Data-API has pricing info, so our P&L calculation
                // using that price is as trustworthy as the UI's display.
                const hasDataApiPricing =
                  dataApiCurPrice !== undefined ||
                  dataApiCurrentValue !== undefined;
                if (hasDataApiPricing) {
                  pnlTrusted = true; // Data-API provided pricing info
                } else {
                  pnlTrusted = false;
                  // Use more descriptive reason based on what actually failed
                  pnlUntrustedReason = pricingFetchFailed
                    ? "PRICING_FETCH_FAILED"
                    : "NO_ORDERBOOK_BIDS";
                }
              }

              // === P&L CLASSIFICATION ===
              // CRITICAL: Classification is UNKNOWN when pnlTrusted is false
              let pnlClassification: PnLClassification;
              if (!pnlTrusted) {
                pnlClassification = "UNKNOWN";
              } else if (pnlPct > 0) {
                pnlClassification = "PROFITABLE";
              } else if (pnlPct < 0) {
                pnlClassification = "LOSING";
              } else {
                pnlClassification = "NEUTRAL";
              }

              // === P&L CONSISTENCY CHECK ===
              // Compare price-derived (implied) P&L against reported pnlPct.
              // This catches cases where Data-API P&L and price sources diverge.
              //
              // WHY THIS MATTERS:
              // 1. Tiny rounding differences (e.g., 0.8599 vs 0.86) should NOT trigger warnings
              // 2. Material discrepancies (>10%) may indicate stale data or API bugs
              // 3. Scalper must not act on spurious P&L values
              //
              // THRESHOLDS:
              // - < 0.5%: Rounding noise, ignore silently
              // - 0.5-2%: Acceptable variance, no action
              // - 2-10%: Log warning but trust Data-API (UI-truth)
              // - > 10%: Mark as untrusted, explain why
              if (entryPrice > 0 && !finalRedeemable) {
                const impliedPnlPct =
                  ((currentPrice - entryPrice) / entryPrice) * 100;
                const pnlDiscrepancy = Math.abs(pnlPct - impliedPnlPct);

                // Only check discrepancy when pnlSource is DATA_API (price vs API comparison)
                // For EXECUTABLE_BOOK and FALLBACK, pnlPct is derived from currentPrice so no discrepancy.
                if (pnlSource === "DATA_API" && pnlDiscrepancy > 0) {
                  if (
                    pnlDiscrepancy >
                    PositionTracker.PNL_UNTRUSTED_THRESHOLD_PCT
                  ) {
                    // SEVERE DISCREPANCY: Data-API P&L materially disagrees with price-derived P&L
                    // Mark as untrusted to prevent scalper from acting on spurious values
                    pnlTrusted = false;
                    pnlUntrustedReason = `DATA_API_PRICE_DISCREPANCY: pnlPct=${pnlPct.toFixed(2)}% vs implied=${impliedPnlPct.toFixed(2)}% (diff=${pnlDiscrepancy.toFixed(2)}%)`;
                    pnlClassification = "UNKNOWN";
                    this.logger.warn(
                      `[PositionTracker] ⚠️ P&L UNTRUSTED - Material discrepancy: tokenId=${tokenId.slice(0, 16)}..., ` +
                        `entry=${(entryPrice * 100).toFixed(2)}¢, current=${(currentPrice * 100).toFixed(2)}¢, ` +
                        `pnlPct=${pnlPct.toFixed(2)}%, implied=${impliedPnlPct.toFixed(2)}%, ` +
                        `diff=${pnlDiscrepancy.toFixed(2)}%, source=${pnlSource}`,
                    );
                  } else if (
                    pnlDiscrepancy > PositionTracker.PNL_WARNING_THRESHOLD_PCT
                  ) {
                    // MODERATE DISCREPANCY: Log warning but still trust Data-API (UI-truth)
                    this.logger.debug(
                      `[PositionTracker] P&L variance detected: tokenId=${tokenId.slice(0, 16)}..., ` +
                        `entry=${(entryPrice * 100).toFixed(2)}¢, current=${(currentPrice * 100).toFixed(2)}¢, ` +
                        `pnlPct=${pnlPct.toFixed(2)}%, implied=${impliedPnlPct.toFixed(2)}%, ` +
                        `diff=${pnlDiscrepancy.toFixed(2)}%, source=${pnlSource}`,
                    );
                  }
                  // Discrepancy <= PNL_WARNING_THRESHOLD_PCT: Silent (acceptable variance)
                  // Discrepancy <= PNL_ROUNDING_TOLERANCE_PCT: Rounding noise, fully ignored
                }

                // LEGACY CHECK (improved): currentPrice > entryPrice but pnlPct shows loss/neutral
                // Only warn if the discrepancy is material (above rounding tolerance)
                const priceGainPct =
                  ((currentPrice - entryPrice) / entryPrice) * 100;
                if (
                  priceGainPct > PositionTracker.PNL_ROUNDING_TOLERANCE_PCT &&
                  pnlPct <= 0 &&
                  pnlSource === "DATA_API"
                ) {
                  // This is a genuine anomaly: prices show profit but P&L shows loss/neutral
                  this.logger.warn(
                    `[PositionTracker] ⚠️ P&L calculation anomaly: tokenId=${tokenId.slice(0, 16)}..., ` +
                      `entry=${(entryPrice * 100).toFixed(2)}¢, current=${(currentPrice * 100).toFixed(2)}¢, ` +
                      `pnlPct=${pnlPct.toFixed(2)}%, implied=${impliedPnlPct.toFixed(2)}%, source=${pnlSource}`,
                  );
                }
              }

              // Log significant profits at DEBUG level for monitoring
              if (pnlPct >= 10 && !finalRedeemable) {
                this.logger.debug(
                  `[PositionTracker] 💰 High profit position: ${side} entry=${(entryPrice * 100).toFixed(1)}¢ → current=${(currentPrice * 100).toFixed(1)}¢ = +${pnlPct.toFixed(1)}% ($${pnlUsd.toFixed(2)}) [source=${pnlSource}]`,
                );
              }

              // Fetch market end time for active positions (needed for near-close hedging)
              // Skip for redeemable positions since they're already resolved
              let marketEndTime: number | undefined;
              if (!finalRedeemable) {
                marketEndTime = await this.fetchMarketEndTime(tokenId);
              }

              // Determine final position status
              const finalStatus: PositionStatus = finalRedeemable
                ? "REDEEMABLE"
                : positionStatus;

              // Compute nearResolutionCandidate flag using centralized logic
              // CRITICAL: This uses isNearResolution() which has the 50¢ safety guard
              const nearResolutionCandidate =
                !finalRedeemable && isNearResolution(currentPrice);

              return {
                marketId,
                tokenId,
                side,
                size,
                entryPrice,
                currentPrice,
                pnlPct,
                pnlUsd,
                pnlTrusted,
                pnlClassification,
                pnlUntrustedReason,
                redeemable: finalRedeemable,
                marketEndTime,
                currentBidPrice: bestBidPrice,
                currentAskPrice: bestAskPrice,
                status: finalStatus,
                cacheAgeMs,
                // New Data-API fields
                pnlSource,
                dataApiPnlUsd,
                dataApiPnlPct,
                dataApiCurPrice,
                dataApiCurrentValue,
                dataApiInitialValue,
                executablePnlUsd,
                executableMarkCents,
                conditionId,
                // Strict state machine fields (Jan 2025)
                positionState,
                redeemableProofSource,
                marketClosed,
                // Near-resolution candidate flag (Jan 2025 fix)
                nearResolutionCandidate,
                // === NEW: Book status fields (Jan 2025 - Decouple from snapshot) ===
                // These fields track orderbook availability WITHOUT affecting position classification
                bookStatus,
                executionStatus,
                execPriceTrusted,
              };
            } catch (err) {
              const reason = `Failed to enrich position: ${err instanceof Error ? err.message : String(err)}`;
              skippedPositions.push({ reason, data: parsed.apiPos });
              trackSkipReason(reason);
              this.logger.debug(`[PositionTracker] ${reason}`);
              return null;
            }
          }),
        );

        // Collect successful results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            positions.push(result.value);
          }
        }

        // Small delay between batches to avoid rate limiting
        if (i + maxConcurrent < apiPositions.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Log comprehensive summary of position processing
      const successCount = positions.length;
      const skippedCount = skippedPositions.length;
      const totalCount = apiPositions.length;

      // Store stats for external access
      this.lastRefreshStats = {
        resolved: resolvedCount,
        active: activeCount,
        skipped: skippedCount,
      };

      if (successCount > 0) {
        // === CYCLE-AWARE PROCESSED LOG (rate-limited) ===
        // Compute fingerprint for deduplication
        const processedFingerprint = JSON.stringify({
          success: successCount,
          total: totalCount,
          resolved: resolvedCount,
          active: activeCount,
          newMarkets: newlyCachedMarkets,
        });

        const processedLogNow = Date.now();
        const fingerprintChanged =
          processedFingerprint !== this.lastProcessedLogFingerprint;
        const heartbeatElapsed =
          processedLogNow - this.lastProcessedLoggedAt >= TRACKER_HEARTBEAT_MS;

        // Log only if fingerprint changed or heartbeat elapsed
        if (fingerprintChanged || heartbeatElapsed) {
          const indicator = fingerprintChanged ? "Δ" : "♥";
          // Only use INFO for new market lookups; otherwise DEBUG for steady-state
          if (newlyCachedMarkets > 0) {
            this.logger.info(
              `[PositionTracker] ✓ Processed ${successCount}/${totalCount} positions (${resolvedCount} resolved, ${activeCount} active, ${newlyCachedMarkets} new market lookups) (${indicator})`,
            );
          } else {
            // Quieter log for steady-state operation (all markets already cached)
            this.logger.debug(
              `[PositionTracker] ✓ Processed ${successCount} positions (${resolvedCount} resolved, ${activeCount} active) - all outcomes cached (${indicator})`,
            );
          }
          this.lastProcessedLogFingerprint = processedFingerprint;
          this.lastProcessedLoggedAt = processedLogNow;
        }

        // P&L summary logging with rate-limiting to avoid log spam
        // Sort by P&L% descending to show most profitable first
        const sortedByPnl = [...positions].sort((a, b) => b.pnlPct - a.pnlPct);
        const redeemablePositions = sortedByPnl.filter((p) => p.redeemable);
        // Active positions = non-redeemable (can be traded/scalped)
        const activePositions = sortedByPnl.filter((p) => !p.redeemable);

        // Use pnlClassification for proper categorization
        const activeProfitable = activePositions.filter(
          (p) => p.pnlClassification === "PROFITABLE",
        );
        const activeLosing = activePositions.filter(
          (p) => p.pnlClassification === "LOSING",
        );
        const activeNeutral = activePositions.filter(
          (p) => p.pnlClassification === "NEUTRAL",
        );
        const activeUnknown = activePositions.filter(
          (p) => p.pnlClassification === "UNKNOWN",
        );

        // Rate-limit: log at most once per minute or when counts change
        const now = Date.now();
        const countsChanged =
          this.lastLoggedPnlCounts.profitable !== activeProfitable.length ||
          this.lastLoggedPnlCounts.losing !== activeLosing.length ||
          this.lastLoggedPnlCounts.neutral !== activeNeutral.length ||
          this.lastLoggedPnlCounts.unknown !== activeUnknown.length ||
          this.lastLoggedPnlCounts.redeemable !== redeemablePositions.length;
        const shouldLogPnlSummary =
          countsChanged ||
          now - this.lastPnlSummaryLogAt >=
            PositionTracker.PNL_SUMMARY_LOG_INTERVAL_MS;

        if (shouldLogPnlSummary) {
          this.lastPnlSummaryLogAt = now;
          this.lastLoggedPnlCounts = {
            profitable: activeProfitable.length,
            losing: activeLosing.length,
            neutral: activeNeutral.length,
            unknown: activeUnknown.length,
            redeemable: redeemablePositions.length,
          };

          // Log summary using new enterprise format:
          // ACTIVE: total=N (prof=X lose=Y neutral=Z unknown=W) | REDEEMABLE: M
          this.logger.info(
            `[PositionTracker] 📊 P&L Summary: ACTIVE: total=${activePositions.length} (prof=${activeProfitable.length} lose=${activeLosing.length} neutral=${activeNeutral.length} unknown=${activeUnknown.length}) | REDEEMABLE: ${redeemablePositions.length}`,
          );

          // === STRICT STATE MACHINE DIAGNOSTIC ===
          // Log detailed state breakdown using positionState field
          const stateActive = positions.filter(
            (p) => p.positionState === "ACTIVE",
          ).length;
          const stateRedeemable = positions.filter(
            (p) => p.positionState === "REDEEMABLE",
          ).length;
          const stateClosedNotRedeemable = positions.filter(
            (p) => p.positionState === "CLOSED_NOT_REDEEMABLE",
          ).length;
          const stateUnknown = positions.filter(
            (p) => p.positionState === "UNKNOWN",
          ).length;

          // Count redeemable by proof source
          const redeemableByDataApi = positions.filter(
            (p) => p.redeemableProofSource === "DATA_API_FLAG",
          ).length;
          const redeemableByOnchain = positions.filter(
            (p) => p.redeemableProofSource === "ONCHAIN_DENOM",
          ).length;

          // Final diagnostic: raw vs final counts
          this.logger.info(
            `[PositionTracker] 📈 State Diagnostic: raw_total=${rawTotal} raw_redeemable=${rawRedeemableCandidates} | final_active=${stateActive} final_redeemable=${stateRedeemable} final_closed_not_redeemable=${stateClosedNotRedeemable}`,
          );

          // Log redeemable proof sources (helps audit correct classification)
          if (stateRedeemable > 0) {
            this.logger.info(
              `[PositionTracker] 🔍 Redeemable Proof: DATA_API_FLAG=${redeemableByDataApi} ONCHAIN_DENOM=${redeemableByOnchain}`,
            );
          }

          // INTERNAL BUG CHECK: Redeemable without valid proof source is a BUG
          // Use positionState instead of redeemable field to align with strict state machine
          const redeemableWithoutProof = positions.filter(
            (p) =>
              p.positionState === "REDEEMABLE" &&
              p.redeemableProofSource === "NONE",
          );
          if (redeemableWithoutProof.length > 0) {
            this.logger.error(
              `[PositionTracker] 🐛 INTERNAL BUG: ${redeemableWithoutProof.length} positions marked redeemable without valid proof source! tokenIds: ${redeemableWithoutProof.map((p) => p.tokenId.slice(0, 8)).join(", ")}`,
            );
          }

          // Log active profitable positions at DEBUG level (scalping candidates)
          if (activeProfitable.length > 0) {
            const profitSummary = activeProfitable
              .slice(0, 10) // Top 10 profitable
              .map(
                (p) =>
                  `${p.tokenId.slice(0, 8)}...+${p.pnlPct.toFixed(1)}%/$${p.pnlUsd.toFixed(2)}`,
              )
              .join(", ");
            this.logger.debug(
              `[PositionTracker] 💰 Active Profitable (${activeProfitable.length}): ${profitSummary}${activeProfitable.length > 10 ? "..." : ""}`,
            );
          }

          // Log unknown positions at DEBUG level for diagnostics
          if (activeUnknown.length > 0) {
            const unknownSummary = activeUnknown
              .slice(0, 5)
              .map(
                (p) =>
                  `${p.tokenId.slice(0, 8)}...(${p.pnlUntrustedReason ?? "UNKNOWN"})`,
              )
              .join(", ");
            this.logger.debug(
              `[PositionTracker] ⚠️ Unknown P&L (${activeUnknown.length}): ${unknownSummary}${activeUnknown.length > 5 ? "..." : ""}`,
            );
          }

          // Log redeemable positions at INFO level (critical for redemption)
          if (redeemablePositions.length > 0) {
            const redeemSummary = redeemablePositions
              .slice(0, 5)
              .map(
                (p) =>
                  `${p.tokenId.slice(0, 8)}...(${p.currentPrice > 0 ? "WIN" : "LOSS"})`,
              )
              .join(", ");
            this.logger.info(
              `[PositionTracker] 🎯 Redeemable (${redeemablePositions.length}): ${redeemSummary}${redeemablePositions.length > 5 ? "..." : ""}`,
            );
          }
        }
      }

      if (skippedCount > 0) {
        this.logger.warn(
          `[PositionTracker] ⚠ Skipped ${skippedCount}/${totalCount} positions`,
        );

        // Group skipped positions by reason for better diagnostics
        const reasonGroups = new Map<string, number>();
        for (const { reason } of skippedPositions) {
          const count = reasonGroups.get(reason) || 0;
          reasonGroups.set(reason, count + 1);
        }

        const breakdownLines = [
          "[PositionTracker] Skipped position breakdown:",
        ];
        for (const [reason, count] of reasonGroups.entries()) {
          breakdownLines.push(`[PositionTracker]   - ${count}x: ${reason}`);
        }
        this.logger.warn(breakdownLines.join("\n"));

        // Log first few skipped positions for debugging
        const sampleSize = Math.min(3, skippedCount);
        this.logger.warn(
          `[PositionTracker] Sample of skipped positions (first ${sampleSize}):`,
        );
        for (let i = 0; i < sampleSize; i++) {
          const { reason, data } = skippedPositions[i];
          this.logger.warn(`[PositionTracker]   [${i + 1}] ${reason}`);
          this.logger.warn(
            `[PositionTracker]       Data: ${JSON.stringify(data)}`,
          );
        }
      }

      return positions;
    } catch (err) {
      this.logger.error(
        `[PositionTracker] Failed to fetch positions from API: ${err instanceof Error ? err.message : String(err)}`,
        err as Error,
      );

      // Return empty array on error - caller handles retry logic
      return [];
    }
  }

  /**
   * Parse entry price from API response, supporting both new and legacy formats
   */
  private parseEntryPrice(apiPos: {
    avgPrice?: string | number;
    initial_average_price?: string | number;
  }): number {
    // Try new API field first
    if (apiPos.avgPrice !== undefined) {
      return typeof apiPos.avgPrice === "string"
        ? parseFloat(apiPos.avgPrice)
        : apiPos.avgPrice;
    }

    // Fall back to legacy field
    if (apiPos.initial_average_price !== undefined) {
      return typeof apiPos.initial_average_price === "string"
        ? parseFloat(apiPos.initial_average_price)
        : apiPos.initial_average_price;
    }

    return 0;
  }

  /**
   * Parse a numeric field that may be string or number.
   * Returns undefined if the field is not present or invalid.
   */
  private parseNumericField(
    value: string | number | undefined,
  ): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const parsed = typeof value === "string" ? parseFloat(value) : value;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  // Cache for on-chain payoutDenominator checks to avoid repeated RPC calls
  private payoutDenominatorCache: Map<
    string,
    { denominator: bigint; checkedAt: number }
  > = new Map();
  private static readonly PAYOUT_DENOM_CACHE_TTL_MS = 300_000; // 5 minutes (resolved markets won't change)

  /**
   * Check on-chain payoutDenominator for a conditionId.
   * Returns true if payoutDenominator > 0, indicating the market is resolved on-chain.
   *
   * This is used as a fallback when:
   * 1. Data-API hasn't marked position as redeemable yet
   * 2. Position has price near 100¢ or 0¢ (suggesting resolution)
   * 3. No orderbook/bids available (can't sell via SellEarly)
   *
   * @param conditionId - The conditionId (same as marketId in Polymarket)
   * @returns true if resolved on-chain (payoutDenominator > 0), false otherwise
   */
  // Bytes32 hex string length (0x + 64 hex chars) - same as AutoRedeemStrategy
  private static readonly BYTES32_HEX_LENGTH = 66;

  private async checkOnChainRedeemable(conditionId: string): Promise<boolean> {
    // Validate conditionId format (bytes32)
    if (
      !conditionId?.startsWith("0x") ||
      conditionId.length !== PositionTracker.BYTES32_HEX_LENGTH
    ) {
      return false;
    }

    // Check cache first
    const cached = this.payoutDenominatorCache.get(conditionId);
    const now = Date.now();
    if (
      cached &&
      now - cached.checkedAt < PositionTracker.PAYOUT_DENOM_CACHE_TTL_MS
    ) {
      return cached.denominator > 0n;
    }

    try {
      // Get wallet from CLOB client (standard pattern used across all strategies)
      // The ClobClient from @polymarket/clob-client attaches wallet property
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet?.provider) {
        // No wallet/provider available, can't check on-chain
        return false;
      }

      // Get CTF contract address
      const contracts = resolvePolymarketContracts();
      const ctfAddress = contracts.ctfAddress;
      if (!ctfAddress) {
        return false;
      }

      // Create CTF contract instance (read-only, using provider)
      const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet.provider);

      // Call payoutDenominator view function
      const denominator = (await ctfContract.payoutDenominator(
        conditionId,
      )) as bigint;

      // Cache the result
      this.payoutDenominatorCache.set(conditionId, {
        denominator,
        checkedAt: now,
      });

      // Clean up old cache entries if needed
      if (
        this.payoutDenominatorCache.size >
        PositionTracker.MAX_OUTCOME_CACHE_ENTRIES
      ) {
        const entriesToDelete: string[] = [];
        for (const [key, entry] of this.payoutDenominatorCache) {
          if (
            now - entry.checkedAt >
            PositionTracker.PAYOUT_DENOM_CACHE_TTL_MS * 2
          ) {
            entriesToDelete.push(key);
          }
        }
        for (const key of entriesToDelete) {
          this.payoutDenominatorCache.delete(key);
        }
      }

      if (denominator > 0n) {
        this.logger.info(
          `[PositionTracker] 🔗 ON-CHAIN RESOLVED: conditionId=${conditionId.slice(0, 16)}... payoutDenominator=${denominator}`,
        );
        return true;
      }

      return false;
    } catch (err) {
      // Log at debug level - RPC errors are expected for some conditions
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `[PositionTracker] checkOnChainRedeemable failed for ${conditionId.slice(0, 16)}...: ${errMsg}`,
      );
      return false;
    }
  }

  /**
   * Batch fetch market outcomes from Gamma API for multiple tokenIds.
   * Uses comma-separated clob_token_ids parameter to reduce API calls.
   * Results are stored in outcomeCache.
   *
   * RESILIENT BATCH FETCH (Jan 2025):
   * - On 422/429/5xx errors, falls back to single-token requests
   * - Failures are non-fatal: positions remain ACTIVE with pnlTrusted=false
   * - Does NOT cause positions to be dropped or ACTIVE count to collapse
   *
   * @param tokenIds - Array of tokenIds to fetch outcomes for
   * @returns Map of tokenId -> winner (or null if not resolved/error)
   */
  private async fetchMarketOutcomesBatch(
    tokenIds: string[],
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();

    if (tokenIds.length === 0) {
      return results;
    }

    const { httpGet } = await import("../utils/fetch-data.util");
    const { POLYMARKET_API } =
      await import("../constants/polymarket.constants");

    // Interface for Gamma market response
    interface GammaMarketResponse {
      outcomes?: string;
      outcomePrices?: string;
      tokens?: Array<{
        outcome?: string;
        winner?: boolean;
        token_id?: string;
      }>;
      clobTokenIds?: string[];
      clob_token_ids?: string[];
      resolvedOutcome?: string;
      resolved_outcome?: string;
      winningOutcome?: string;
      winning_outcome?: string;
      closed?: boolean;
      resolved?: boolean;
    }

    // Chunk tokenIds into batches to avoid URL length limits
    const chunks: string[][] = [];
    for (
      let i = 0;
      i < tokenIds.length;
      i += PositionTracker.GAMMA_BATCH_SIZE
    ) {
      chunks.push(tokenIds.slice(i, i + PositionTracker.GAMMA_BATCH_SIZE));
    }

    // Log batch fetch summary at DEBUG level (one log per refresh, not per tokenId)
    this.logger.debug(
      `[PositionTracker] Fetching outcomes for ${tokenIds.length} tokenIds in ${chunks.length} batch request(s)`,
    );

    // Track if we need to fall back to single-token requests (after 422/429/5xx)
    let fallbackToSingleRequests = false;
    const failedTokenIds: string[] = [];

    for (const chunk of chunks) {
      try {
        // Build comma-separated tokenIds for URL
        const encodedIds = chunk
          .map((id) => encodeURIComponent(id.trim()))
          .join(",");
        const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedIds}`;

        this.currentRefreshMetrics.gammaRequestsPerRefresh++;
        this.currentRefreshMetrics.tokenIdsFetched += chunk.length;

        const markets = await httpGet<GammaMarketResponse[]>(url, {
          timeout: PositionTracker.API_TIMEOUT_MS,
        });

        if (!markets || !Array.isArray(markets)) {
          // Mark all as null (not found) - but DON'T drop positions
          for (const tokenId of chunk) {
            results.set(tokenId, null);
          }
          continue;
        }

        // Build a map from tokenId -> market for efficient lookup
        const tokenIdToMarket = new Map<string, GammaMarketResponse>();
        for (const market of markets) {
          // Get all tokenIds associated with this market
          const marketTokenIds =
            market.clobTokenIds ?? market.clob_token_ids ?? [];
          for (const tid of marketTokenIds) {
            tokenIdToMarket.set(tid, market);
          }
          // Also check tokens array for tokenId
          if (market.tokens) {
            for (const token of market.tokens) {
              if (token.token_id) {
                tokenIdToMarket.set(token.token_id, market);
              }
            }
          }
        }

        // Process each tokenId in this chunk
        for (const tokenId of chunk) {
          const market = tokenIdToMarket.get(tokenId);
          if (!market) {
            results.set(tokenId, null);
            continue;
          }

          // Extract winner using same logic as fetchMarketOutcome
          const winner = this.extractWinnerFromMarket(market);
          results.set(tokenId, winner);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Check for 422/429/5xx errors that indicate batch request format issues
        const is422 =
          errMsg.includes("422") || errMsg.includes("Unprocessable");
        const is429 = errMsg.includes("429") || errMsg.includes("Too Many");
        // Match 5xx status codes (500-599) more explicitly
        const is5xx =
          /5[0-9]{2}/.test(errMsg) || errMsg.includes("Server Error");

        if (is422 || is429 || is5xx) {
          // Log at WARN level for batch failures that trigger fallback
          // Mark enrichment as DEGRADED - positions remain ACTIVE but outcome unknown
          this.logger.warn(
            `[PositionTracker] ⚠️ GAMMA_BATCH_FAILURE (enrichment degraded): ${is422 ? "422" : is429 ? "429" : "5xx"} error for batch of ${chunk.length} tokenIds. ` +
              `Auto-fallback to single-token requests. Positions remain ACTIVE. error="${errMsg.slice(0, 100)}"`,
          );
          fallbackToSingleRequests = true;
          failedTokenIds.push(...chunk);
        } else {
          // Other errors - log at debug level
          this.logger.debug(
            `[PositionTracker] Batch fetch failed for ${chunk.length} tokenIds: ${errMsg}`,
          );
          // Mark all tokenIds in this chunk as null (error) - but positions stay ACTIVE
          for (const tokenId of chunk) {
            results.set(tokenId, null);
          }
        }
      }
    }

    // FALLBACK: If batch request failed with 422/429/5xx, try single-token requests
    if (fallbackToSingleRequests && failedTokenIds.length > 0) {
      this.logger.info(
        `[PositionTracker] GAMMA_FALLBACK: Attempting single-token requests for ${failedTokenIds.length} tokenIds after batch failure`,
      );

      // Process failed tokenIds one at a time (with rate limiting)
      let successCount = 0;
      let failCount = 0;

      for (const tokenId of failedTokenIds) {
        try {
          // Use smaller batch size of 1 for fallback
          const encodedId = encodeURIComponent(tokenId.trim());
          const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedId}`;

          this.currentRefreshMetrics.gammaRequestsPerRefresh++;

          const markets = await httpGet<GammaMarketResponse[]>(url, {
            timeout: PositionTracker.API_TIMEOUT_MS,
          });

          if (markets && Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            const winner = this.extractWinnerFromMarket(market);
            results.set(tokenId, winner);
            successCount++;
          } else {
            results.set(tokenId, null);
            failCount++;
          }
        } catch (singleErr) {
          // Single request also failed - log at debug and move on
          // Position remains ACTIVE with pnlTrusted=false
          this.logger.debug(
            `[PositionTracker] Single-token fallback failed for ${tokenId.slice(0, 16)}...: ${singleErr instanceof Error ? singleErr.message : String(singleErr)}`,
          );
          results.set(tokenId, null);
          failCount++;
        }
      }

      this.logger.info(
        `[PositionTracker] GAMMA_FALLBACK complete: ${successCount} succeeded, ${failCount} failed (positions remain ACTIVE with unknown outcome)`,
      );
    }

    return results;
  }

  /**
   * Extract winner from a Gamma market response.
   * Shared logic used by both single and batch fetches.
   */
  private extractWinnerFromMarket(market: {
    outcomes?: string;
    outcomePrices?: string;
    tokens?: Array<{ outcome?: string; winner?: boolean }>;
    resolvedOutcome?: string;
    resolved_outcome?: string;
    winningOutcome?: string;
    winning_outcome?: string;
    closed?: boolean;
    resolved?: boolean;
  }): string | null {
    // Primary method: Parse outcomePrices to find winner
    if (market.outcomes && market.outcomePrices) {
      try {
        const outcomes: string[] = JSON.parse(market.outcomes);
        const prices: string[] = JSON.parse(market.outcomePrices);

        if (outcomes.length > 0 && outcomes.length === prices.length) {
          let winnerIndex = -1;
          let highestPrice = 0;

          for (let i = 0; i < prices.length; i++) {
            const price = parseFloat(prices[i]);
            if (Number.isFinite(price) && price > highestPrice) {
              highestPrice = price;
              winnerIndex = i;
            }
          }

          if (
            winnerIndex >= 0 &&
            highestPrice > PositionTracker.WINNER_THRESHOLD
          ) {
            return outcomes[winnerIndex].trim();
          }
        }
      } catch {
        // Parse error - try fallback methods
      }
    }

    // Fallback: Check for explicit winning outcome field
    const winningOutcome =
      market.resolvedOutcome ??
      market.resolved_outcome ??
      market.winningOutcome ??
      market.winning_outcome;

    if (winningOutcome && typeof winningOutcome === "string") {
      const trimmed = winningOutcome.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    // Fallback: Check tokens for winner flag
    if (market.tokens && Array.isArray(market.tokens)) {
      for (const token of market.tokens) {
        if (token.winner === true && token.outcome) {
          const trimmed = token.outcome.trim();
          if (trimmed) {
            return trimmed;
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if a tokenId has a cached resolved outcome.
   * Returns the cached entry if it exists and is valid, or undefined if not cached.
   */
  private getOutcomeCacheEntry(tokenId: string): OutcomeCacheEntry | undefined {
    const cached = this.outcomeCache.get(tokenId);
    if (!cached) {
      return undefined;
    }

    // RESOLVED outcomes never expire
    if (cached.status === "RESOLVED") {
      this.currentRefreshMetrics.resolvedCacheHits++;
      return cached;
    }

    // ACTIVE outcomes have TTL
    const now = Date.now();
    if (
      now - cached.lastCheckedMs <
      PositionTracker.ACTIVE_OUTCOME_CACHE_TTL_MS
    ) {
      this.currentRefreshMetrics.cacheHits++;
      return cached;
    }

    // TTL expired for ACTIVE outcome
    return undefined;
  }

  /**
   * Store outcome in cache.
   * Enforces max cache size by removing oldest entries.
   */
  private setOutcomeCacheEntry(
    tokenId: string,
    entry: OutcomeCacheEntry,
  ): void {
    // Enforce max cache size
    while (
      this.outcomeCache.size >= PositionTracker.MAX_OUTCOME_CACHE_ENTRIES
    ) {
      const firstKey = this.outcomeCache.keys().next().value;
      if (firstKey) {
        this.outcomeCache.delete(firstKey);
      } else {
        break;
      }
    }
    this.outcomeCache.set(tokenId, entry);
  }

  /**
   * Format price in cents for display in logs.
   * Returns readable strings like "100¢ (WIN)", "0¢ (LOSS)", or "50¢".
   */
  private formatPriceCentsForLog(priceCents: number): string {
    if (priceCents === 100) {
      return "100¢ (WIN)";
    }
    if (priceCents === 0) {
      return "0¢ (LOSS)";
    }
    return `${priceCents}¢`;
  }

  /**
   * Log resolved position detection only on state change.
   * Prevents repeated logging of the same resolved state.
   *
   * @returns true if logged, false if suppressed (no change)
   */
  private logResolvedPositionIfChanged(
    tokenId: string,
    side: string,
    winner: string | null,
    currentPrice: number,
    newStatus: "ACTIVE" | "RESOLVED",
  ): boolean {
    const priceCents = Math.round(currentPrice * 100);
    const lastState = this.lastLoggedState.get(tokenId);

    // Check if state actually changed
    const isFirstSeen = !lastState;
    const statusChanged =
      lastState !== undefined && lastState.status !== newStatus;
    const winnerChanged =
      lastState !== undefined && lastState.winner !== winner;
    // Only log price change if it crosses a meaningful boundary (0 <-> 100)
    const priceChangedMeaningfully =
      lastState !== undefined &&
      ((lastState.priceCents === 0 && priceCents === 100) ||
        (lastState.priceCents === 100 && priceCents === 0));

    const shouldLog =
      isFirstSeen || statusChanged || winnerChanged || priceChangedMeaningfully;

    if (shouldLog && newStatus === "RESOLVED") {
      // Only log at INFO level for RESOLVED state transitions
      const priceDisplay = this.formatPriceCentsForLog(priceCents);
      this.logger.info(
        `[PositionTracker] Detected resolved position: tokenId=${tokenId.slice(0, 16)}..., side=${side}, winner=${winner ?? "unknown"}, price=${priceDisplay}`,
      );
    }

    // Update last logged state
    this.lastLoggedState.set(tokenId, {
      status: newStatus,
      winner,
      priceCents,
    });

    // Clean up old entries to prevent unbounded growth
    if (this.lastLoggedState.size > PositionTracker.MAX_OUTCOME_CACHE_ENTRIES) {
      const firstKey = this.lastLoggedState.keys().next().value;
      if (firstKey) {
        this.lastLoggedState.delete(firstKey);
      }
    }

    return shouldLog;
  }

  /**
   * Fetch market resolution/outcome data from Gamma API using the tokenId.
   * Returns the winning outcome (e.g., "YES", "NO", "Medjedovic", "Under") or null if the outcome
   * cannot be determined (e.g. market unresolved, API/network error, or malformed response).
   *
   * Supports both binary markets (YES/NO) and multi-outcome markets.
   *
   * Uses the `clob_token_ids` query parameter to find the market, then parses
   * the `outcomePrices` array to determine which outcome won (price = 1 or ~1).
   */
  private async fetchMarketOutcome(tokenId: string): Promise<string | null> {
    // Validate tokenId input
    if (!tokenId || typeof tokenId !== "string" || tokenId.trim() === "") {
      this.logger.debug(
        `[PositionTracker] Invalid tokenId provided to fetchMarketOutcome: ${tokenId}`,
      );
      return null;
    }

    try {
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      // Fetch market details from Gamma API using clob_token_ids query
      // This correctly finds the market containing this token
      interface GammaMarketResponse {
        outcomes?: string; // JSON string like '["Yes", "No"]' or '["Medjedovic", "Minaur"]'
        outcomePrices?: string; // JSON string like '["0", "1"]' where 1 = winner
        tokens?: Array<{
          outcome?: string;
          winner?: boolean;
        }>;
        resolvedOutcome?: string;
        resolved_outcome?: string;
        winningOutcome?: string;
        winning_outcome?: string;
        closed?: boolean;
        resolved?: boolean;
      }

      // Encode tokenId for URL safety
      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      this.logger.debug(
        `[PositionTracker] Fetching market outcome from ${url}`,
      );

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        this.logger.debug(
          `[PositionTracker] No market data returned for tokenId ${tokenId}`,
        );
        return null;
      }

      const market = markets[0];

      // Use the shared winner extraction logic
      const winner = this.extractWinnerFromMarket(market);

      // Debug log only if winner found (reduces log spam)
      if (winner) {
        this.logger.debug(
          `[PositionTracker] Resolved market for tokenId ${tokenId}: winner="${winner}"`,
        );
      }

      return winner;
    } catch (err: unknown) {
      const anyErr = err as any;
      const message = err instanceof Error ? err.message : String(err);
      const status: number | undefined =
        typeof anyErr?.status === "number"
          ? anyErr.status
          : typeof anyErr?.statusCode === "number"
            ? anyErr.statusCode
            : typeof anyErr?.response?.status === "number"
              ? anyErr.response.status
              : undefined;
      const code: string | undefined =
        typeof anyErr?.code === "string" ? anyErr.code : undefined;

      if (status === 404) {
        this.logger.warn(
          `[PositionTracker] Market not found (404) for tokenId ${tokenId}: ${message}`,
        );
      } else if (status !== undefined && status >= 400 && status < 500) {
        this.logger.warn(
          `[PositionTracker] Client error (${status}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else if (status !== undefined && status >= 500) {
        this.logger.error(
          `[PositionTracker] Server error (${status}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else if (
        code === "ETIMEDOUT" ||
        code === "ECONNREFUSED" ||
        code === "ECONNRESET"
      ) {
        this.logger.error(
          `[PositionTracker] Network error (${code}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else {
        this.logger.error(
          `[PositionTracker] Unexpected error fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      }

      // Log raw error at debug level for troubleshooting (limited depth to avoid performance issues)
      if (anyErr && typeof anyErr === "object") {
        const errorSummary = {
          message: anyErr.message || message,
          code: anyErr.code,
          status: anyErr.status || anyErr.statusCode || anyErr.response?.status,
          name: anyErr.name,
        };
        this.logger.debug(
          `[PositionTracker] Raw error while fetching market outcome for tokenId ${tokenId}: ${JSON.stringify(errorSummary)}`,
        );
      } else {
        this.logger.debug(
          `[PositionTracker] Raw error while fetching market outcome for tokenId ${tokenId}: ${String(anyErr)}`,
        );
      }

      return null;
    }
  }

  /**
   * Check if a market is truly resolved via Gamma API.
   * Returns an object with:
   * - isResolved: true if Gamma confirms market is closed or resolved
   * - hasOrderbook: true if orderbook exists with valid bids/asks
   * - winningOutcome: the winning outcome if available
   *
   * This is used to gate redeemable detection - we only trust apiPos.redeemable === true
   * if Gamma confirms the market is resolved/closed OR no orderbook exists.
   */
  private async verifyMarketResolutionStatus(
    tokenId: string,
    marketId: string,
  ): Promise<{
    isResolved: boolean;
    hasOrderbook: boolean;
    winningOutcome: string | null;
  }> {
    // Default result - assume not resolved and no orderbook
    const result = {
      isResolved: false,
      hasOrderbook: false,
      winningOutcome: null as string | null,
    };

    try {
      // OPTIMIZATION: Check cached outcome FIRST to skip unnecessary orderbook fetches
      // If we already know the market outcome, we can trust the redeemable flag
      // and skip the orderbook check entirely.
      const cachedOutcome = this.marketOutcomeCache.get(marketId);
      if (cachedOutcome !== undefined) {
        result.winningOutcome = cachedOutcome;
        result.isResolved = true;
        // Skip orderbook fetch - already know market is resolved
        return result;
      }

      // Check if orderbook exists (indicates active market)
      // Skip if already known to be missing (avoid repeated 404s)
      if (!this.missingOrderbooks.has(tokenId)) {
        try {
          const orderbook = await this.client.getOrderBook(tokenId);
          if (orderbook.bids?.[0] && orderbook.asks?.[0]) {
            result.hasOrderbook = true;
          }
        } catch (orderbookErr) {
          const errMsg =
            orderbookErr instanceof Error
              ? orderbookErr.message
              : String(orderbookErr);
          // 404, 422, or not found means no orderbook - cache this to avoid repeated fetches
          const isExpectedError =
            errMsg.includes("404") ||
            errMsg.includes("422") ||
            errMsg.includes("not found") ||
            errMsg.includes("No orderbook exists");

          if (isExpectedError) {
            // Add to missingOrderbooks to prevent repeated API calls
            this.missingOrderbooks.add(tokenId);
            // Log at DEBUG level - expected for resolved/redeemable markets
            this.logger.debug(
              `[PositionTracker] verifyMarketResolutionStatus: No orderbook for tokenId=${tokenId.slice(0, 16)}... (expected for resolved market)`,
            );
          } else {
            // Log unexpected errors at debug level
            this.logger.debug(
              `[PositionTracker] verifyMarketResolutionStatus: Unexpected orderbook error for tokenId=${tokenId.slice(0, 16)}...: ${errMsg}`,
            );
          }
        }
      }

      // Fetch market details from Gamma API to check resolved/closed flags
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      interface GammaMarketResponse {
        outcomes?: string;
        outcomePrices?: string;
        tokens?: Array<{
          outcome?: string;
          winner?: boolean;
        }>;
        resolvedOutcome?: string;
        resolved_outcome?: string;
        winningOutcome?: string;
        winning_outcome?: string;
        closed?: boolean;
        resolved?: boolean;
      }

      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        return result;
      }

      const market = markets[0];

      // Check explicit closed/resolved flags from Gamma
      if (market.closed === true || market.resolved === true) {
        result.isResolved = true;
      }

      // Try to determine winning outcome
      // Method 1: Parse outcomePrices
      if (market.outcomes && market.outcomePrices) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const prices: string[] = JSON.parse(market.outcomePrices);

          if (outcomes.length > 0 && outcomes.length === prices.length) {
            let winnerIndex = -1;
            let highestPrice = 0;

            for (let i = 0; i < prices.length; i++) {
              const price = parseFloat(prices[i]);
              if (Number.isFinite(price) && price > highestPrice) {
                highestPrice = price;
                winnerIndex = i;
              }
            }

            if (
              winnerIndex >= 0 &&
              highestPrice > PositionTracker.WINNER_THRESHOLD
            ) {
              result.winningOutcome = outcomes[winnerIndex].trim();
              result.isResolved = true;
            }
          }
        } catch (_parseErr) {
          // Parse error, continue to other methods
          // Don't log here as this is an expected case for malformed API data
        }
      }

      // Method 2: Check explicit winning outcome fields
      if (!result.winningOutcome) {
        const winningOutcome =
          market.resolvedOutcome ??
          market.resolved_outcome ??
          market.winningOutcome ??
          market.winning_outcome;

        if (winningOutcome && typeof winningOutcome === "string") {
          const trimmed = winningOutcome.trim();
          if (trimmed) {
            result.winningOutcome = trimmed;
            result.isResolved = true;
          }
        }
      }

      // Method 3: Check tokens for winner flag
      if (
        !result.winningOutcome &&
        market.tokens &&
        Array.isArray(market.tokens)
      ) {
        for (const token of market.tokens) {
          if (token.winner === true && token.outcome) {
            const trimmed = token.outcome.trim();
            if (trimmed) {
              result.winningOutcome = trimmed;
              result.isResolved = true;
              break;
            }
          }
        }
      }

      return result;
    } catch (err) {
      this.logger.debug(
        `[PositionTracker] verifyMarketResolutionStatus: Error for tokenId=${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }
  }

  /**
   * Fetch market end time from Gamma API
   * Returns Unix timestamp in milliseconds, or undefined if not available
   * Uses cache to avoid redundant API calls
   */
  private async fetchMarketEndTime(
    tokenId: string,
  ): Promise<number | undefined> {
    // Check cache first
    const cached = this.marketEndTimeCache.get(tokenId);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      interface GammaMarketResponse {
        end_date?: string;
        end_time?: string;
        endDate?: string;
        endTime?: string;
      }

      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        return undefined;
      }

      const market = markets[0];
      const endDateStr =
        market.end_date ?? market.end_time ?? market.endDate ?? market.endTime;

      if (!endDateStr) {
        return undefined;
      }

      // Parse the date string to Unix timestamp (milliseconds)
      const endTime = new Date(endDateStr).getTime();
      if (!Number.isFinite(endTime) || endTime <= 0) {
        return undefined;
      }

      // Cache the result (enforce max size)
      if (
        this.marketEndTimeCache.size >= PositionTracker.MAX_END_TIME_CACHE_SIZE
      ) {
        const firstKey = this.marketEndTimeCache.keys().next().value;
        if (firstKey) {
          this.marketEndTimeCache.delete(firstKey);
        }
      }
      this.marketEndTimeCache.set(tokenId, endTime);

      return endTime;
    } catch (err) {
      this.logger.debug(
        `[PositionTracker] Failed to fetch market end time for tokenId ${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Get entry time for a position (when it was first seen)
   */
  getPositionEntryTime(marketId: string, tokenId: string): number | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positionEntryTimes.get(key);
  }

  /**
   * Check if historical entry times have been loaded from the API.
   * Strategies should check this before triggering sells on startup.
   */
  hasLoadedHistoricalEntryTimes(): boolean {
    return this.historicalEntryTimesLoaded;
  }

  /**
   * Load historical entry times from the Polymarket trades API.
   * This fetches the user's BUY trade history from their wallet and finds the earliest
   * BUY timestamp for each position, which represents when the position was acquired.
   *
   * This is critical for preventing mass sells on container restart - without
   * knowing when positions were actually bought, strategies might incorrectly
   * assume positions are "new" and trigger stop-loss or hedging immediately.
   *
   * IMPORTANT: This method paginates through the user's BUY trade history up to a
   * configured safety cap (TRADES_MAX_PAGES, currently ~20 pages / ~10k trades)
   * to find the earliest purchase date for each position. Without pagination, only
   * the most recent trades would be fetched, causing older positions to use container
   * start time (or first-seen time) instead of actual purchase date.
   *
   * If the safety cap is hit before the wallet's full history is exhausted, very old
   * positions whose BUY trades fall before the earliest fetched page may not have an
   * accurate historical entry time and will fall back to the tracker's default behavior
   * (treating them as newly seen). A warning is logged when this occurs.
   *
   * Uses the /trades endpoint with side=BUY filter, which directly queries
   * your wallet's purchase history on the blockchain up to the configured cap.
   */
  private async loadHistoricalEntryTimes(): Promise<void> {
    try {
      const { resolveSignerAddress } =
        await import("../utils/funds-allowance.util");
      const walletAddress = resolveSignerAddress(this.client);

      // Validate wallet address - must be a valid Ethereum address (0x + 40 hex chars)
      // resolveSignerAddress can return "unknown" if wallet is not available
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
      if (!isValidAddress) {
        this.logger.warn(
          `[PositionTracker] ⚠️ Invalid wallet address "${walletAddress}" - cannot load historical entry times`,
        );
        // Don't set historicalEntryTimesLoaded = true, strategies will be conservative
        return;
      }

      this.logger.info(
        `[PositionTracker] Loading purchase history from wallet ${walletAddress.slice(0, 10)}...`,
      );

      // Fetch user's BUY trades directly from the trades API
      // This queries the wallet's trade history on the blockchain
      interface TradeItem {
        timestamp: number; // Unix timestamp in seconds
        conditionId: string; // Market ID
        asset: string; // Token ID
        side: string; // "BUY" or "SELL"
        size: number;
        price: number;
      }

      // Build a map of earliest BUY timestamp per token
      // Key: "marketId-tokenId", Value: earliest BUY timestamp in ms
      const earliestBuyTimes = new Map<string, number>();
      let totalTrades = 0;
      let offset = 0;
      let pageCount = 0;

      // Paginate through all BUY trades from the wallet
      while (pageCount < PositionTracker.TRADES_MAX_PAGES) {
        pageCount++;

        // Build URL with side=BUY filter and pagination
        // TRADES_ENDPOINT already includes ?user=, so we use & for additional params
        const tradesUrl = `${POLYMARKET_API.TRADES_ENDPOINT(walletAddress)}&side=BUY&limit=${PositionTracker.TRADES_PAGE_LIMIT}&offset=${offset}`;

        const trades = await httpGet<TradeItem[]>(tradesUrl, {
          timeout: PositionTracker.API_TIMEOUT_MS,
        });

        // Stop if no more trades
        if (!trades || trades.length === 0) {
          break;
        }

        totalTrades += trades.length;

        // Process each trade in this page
        for (const trade of trades) {
          const marketId = trade.conditionId;
          const tokenId = trade.asset;

          if (!marketId || !tokenId) {
            continue;
          }

          const key = `${marketId}-${tokenId}`;

          // Convert timestamp from seconds to milliseconds
          // The trades API returns Unix timestamp in seconds
          const timestamp = trade.timestamp * 1000;

          // Skip trades with invalid timestamps
          if (!Number.isFinite(timestamp) || timestamp <= 0) {
            continue;
          }

          // Keep the earliest (oldest) BUY timestamp for each position
          // This represents when you first purchased this position
          const existing = earliestBuyTimes.get(key);
          if (!existing || timestamp < existing) {
            earliestBuyTimes.set(key, timestamp);
          }
        }

        // If we got fewer results than requested, we've reached the end
        if (trades.length < PositionTracker.TRADES_PAGE_LIMIT) {
          break;
        }

        // Move to next page
        offset += PositionTracker.TRADES_PAGE_LIMIT;
      }

      // Warn if we hit the max pages limit (may have truncated history)
      if (
        pageCount >= PositionTracker.TRADES_MAX_PAGES &&
        totalTrades > 0 &&
        totalTrades % PositionTracker.TRADES_PAGE_LIMIT === 0
      ) {
        this.logger.warn(
          `[PositionTracker] ⚠️ Hit max pages limit (${PositionTracker.TRADES_MAX_PAGES} pages / ${totalTrades} trades). ` +
            `Very old positions may not have accurate entry times. Consider increasing TRADES_MAX_PAGES if needed.`,
        );
      }

      if (totalTrades === 0) {
        this.logger.info(
          "[PositionTracker] No purchase history found in wallet",
        );
        this.historicalEntryTimesLoaded = true;
        return;
      }

      // Populate positionEntryTimes with historical data from wallet
      for (const [key, timestamp] of earliestBuyTimes) {
        // Only set if we don't already have an entry time
        // (shouldn't happen on startup, but be safe)
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, timestamp);
        }
      }

      this.historicalEntryTimesLoaded = true;

      // Log summary with detailed info for debugging
      this.logger.info(
        `[PositionTracker] ✅ Loaded ${earliestBuyTimes.size} position purchase dates from ${totalTrades} wallet trades (${pageCount} page(s))`,
      );

      // Log entry time range for debugging
      if (earliestBuyTimes.size > 0) {
        const entries = Array.from(earliestBuyTimes.entries());
        const sorted = entries.sort((a, b) => a[1] - b[1]);
        const oldest = sorted[0];
        const newest = sorted[sorted.length - 1];
        const oldestAge = Math.round((Date.now() - oldest[1]) / (60 * 1000));
        const newestAge = Math.round((Date.now() - newest[1]) / (60 * 1000));
        this.logger.info(
          `[PositionTracker] 📅 Purchase dates range: oldest ${oldestAge}min ago, newest ${newestAge}min ago`,
        );
      }
    } catch (err) {
      // Log the error but don't fail - strategies will be conservative without historical data
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PositionTracker] ⚠️ Could not load purchase history from wallet: ${errMsg}`,
      );
      // Do not set historicalEntryTimesLoaded = true on error - strategies should remain conservative
      // Do not re-throw: callers should treat missing historical data as non-fatal
    }
  }

  /**
   * Load historical entry times ONLY for current active/redeemable positions.
   *
   * OPTIMIZED STARTUP (Jan 2025):
   * Instead of loading the full wallet BUY history (which can be thousands of trades),
   * this method uses EntryMetaResolver.resolveEntryMetaBatch to fetch trade history
   * only for the tokenIds we currently hold.
   *
   * This is much faster than the full-history scan because:
   * 1. We only query trades for active positions (typically 10-50 tokenIds)
   * 2. EntryMetaResolver queries asset=tokenId directly (no filtering needed)
   * 3. Each tokenId is queried independently with pagination limits
   *
   * Safety behavior is preserved:
   * - If entry times aren't available, strategies remain conservative
   * - historicalEntryTimesLoaded is only set to true on success
   * - positionEntryTimes map is populated for successful lookups
   */
  private async loadHistoricalEntryTimesForPositions(): Promise<void> {
    try {
      const { resolveSignerAddress } =
        await import("../utils/funds-allowance.util");
      const walletAddress = resolveSignerAddress(this.client);

      // Validate wallet address
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
      if (!isValidAddress) {
        this.logger.warn(
          `[PositionTracker] ⚠️ Invalid wallet address "${walletAddress}" - cannot load historical entry times`,
        );
        return;
      }

      // Get current positions (ACTIVE + REDEEMABLE)
      const positions = this.getPositions();
      if (positions.length === 0) {
        this.logger.info(
          "[PositionTracker] No active positions found - skipping history load",
        );
        // Set flag to true because there's no history to load - this is intentional
        // When there are no positions, strategies don't need entry times, so we're "done"
        this.historicalEntryTimesLoaded = true;
        return;
      }

      this.logger.info(
        `[PositionTracker] Loading entry times for ${positions.length} active position(s)...`,
      );

      // Build list of positions to resolve
      const positionsToResolve = positions.map((p) => ({
        tokenId: p.tokenId,
        marketId: p.marketId,
      }));

      // Use EntryMetaResolver to fetch trade history for each tokenId
      const entryMetaMap = await this.entryMetaResolver.resolveEntryMetaBatch(
        walletAddress,
        positionsToResolve,
      );

      // Populate positionEntryTimes with historical data
      let loadedCount = 0;
      let skippedCount = 0;
      let alreadyLoadedCount = 0;

      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        const entryMeta = entryMetaMap.get(position.tokenId);

        if (entryMeta && entryMeta.firstAcquiredAt) {
          // Only set if we don't already have an entry time
          if (!this.positionEntryTimes.has(key)) {
            this.positionEntryTimes.set(key, entryMeta.firstAcquiredAt);
            loadedCount++;
          } else {
            alreadyLoadedCount++;
          }
        } else {
          skippedCount++;
        }
      }

      this.historicalEntryTimesLoaded = true;

      // Log summary - updated to reflect "loaded history for N active positions"
      const parts = [`✅ Loaded history for ${loadedCount} active position(s)`];
      if (alreadyLoadedCount > 0) {
        parts.push(`${alreadyLoadedCount} already had entry times`);
      }
      if (skippedCount > 0) {
        parts.push(`${skippedCount} skipped (no trade history)`);
      }
      this.logger.info(`[PositionTracker] ${parts.join(", ")}`);

      // Log entry time range for debugging
      if (loadedCount > 0) {
        const entries = Array.from(this.positionEntryTimes.entries());
        if (entries.length > 0) {
          const sorted = entries.sort((a, b) => a[1] - b[1]);
          const oldest = sorted[0];
          const newest = sorted[sorted.length - 1];
          const oldestAge = Math.round((Date.now() - oldest[1]) / (60 * 1000));
          const newestAge = Math.round((Date.now() - newest[1]) / (60 * 1000));
          this.logger.info(
            `[PositionTracker] 📅 Entry times range: oldest ${oldestAge}min ago, newest ${newestAge}min ago`,
          );
        }
      }
    } catch (err) {
      // Log the error but don't fail - strategies will be conservative without historical data
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PositionTracker] ⚠️ Could not load entry times for active positions: ${errMsg}`,
      );
      // Do not set historicalEntryTimesLoaded = true on error - strategies should remain conservative
    }
  }

  /**
   * Fetch price from CLOB API /price endpoint as fallback when orderbook is unavailable
   * Uses mid-price between BUY and SELL sides
   */
  private async fetchPriceFallback(tokenId: string): Promise<number> {
    try {
      // Properly encode tokenId for URL safety
      const encodedTokenId = encodeURIComponent(tokenId);

      // Fetch both BUY and SELL prices to calculate mid-price
      const [buyPriceData, sellPriceData] = await Promise.all([
        httpGet<{ price: string }>(
          `${POLYMARKET_API.BASE_URL}/price?token_id=${encodedTokenId}&side=BUY`,
          { timeout: 5000 },
        ),
        httpGet<{ price: string }>(
          `${POLYMARKET_API.BASE_URL}/price?token_id=${encodedTokenId}&side=SELL`,
          { timeout: 5000 },
        ),
      ]);

      const buyPrice = parseFloat(buyPriceData.price);
      const sellPrice = parseFloat(sellPriceData.price);

      // Validate prices are finite and non-negative
      if (
        !Number.isFinite(buyPrice) ||
        !Number.isFinite(sellPrice) ||
        buyPrice < 0 ||
        sellPrice < 0
      ) {
        throw new Error(
          `Invalid price data from fallback API: buy=${buyPrice}, sell=${sellPrice}`,
        );
      }

      // Return mid-price as best estimate of current value
      const midPrice = (buyPrice + sellPrice) / 2;

      // Only log fallback price on first fetch for this token (suppress repetitive logs)
      if (!this.loggedFallbackPrices.has(tokenId)) {
        this.loggedFallbackPrices.add(tokenId);
        this.logger.debug(
          `[PositionTracker] Fallback price for ${tokenId}: ${(midPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢ (buy: ${(buyPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢, sell: ${(sellPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢)`,
        );
      }
      return midPrice;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch fallback price for tokenId ${tokenId}: ${errMsg}`,
      );
    }
  }

  // ========================================================================
  // CRASH-PROOF RECOVERY: CIRCUIT BREAKER FOR SPAMMY FAILING CALLS
  // ========================================================================

  /**
   * CIRCUIT BREAKER: Check if a tokenId is in cooldown (circuit is open).
   *
   * Returns true if we should skip API calls for this tokenId.
   * When circuit is open:
   * - Use lastKnownPrice from cache (if available)
   * - Keep position ACTIVE (do not drop)
   * - Set pnlTrusted=false or mark as ENRICH_FAILED
   *
   * @param tokenId The tokenId to check
   * @returns true if circuit is open (should skip API calls), false otherwise
   */
  private isCircuitOpen(tokenId: string): boolean {
    const entry = this.circuitBreaker.get(tokenId);
    if (!entry) {
      return false;
    }

    const now = Date.now();

    // Check if cooldown has expired
    if (
      entry.openedAtMs > 0 &&
      now - entry.openedAtMs >= PositionTracker.CIRCUIT_BREAKER_COOLDOWN_MS
    ) {
      // Cooldown expired - close the circuit and allow retry
      this.circuitBreaker.delete(tokenId);
      return false;
    }

    // Circuit is open if we have enough failures and cooldown is active
    return entry.openedAtMs > 0;
  }

  /**
   * CIRCUIT BREAKER: Record a failure for a tokenId.
   *
   * Called when an API call fails (404, 422, timeout, etc.).
   * After reaching threshold failures within the window, opens the circuit.
   *
   * @param tokenId The tokenId that failed
   * @param errorType The type of error
   * @param lastKnownPrice Optional last known price to use during cooldown
   */
  private recordCircuitBreakerFailure(
    tokenId: string,
    errorType: CircuitBreakerEntry["errorType"],
    lastKnownPrice?: number,
  ): void {
    const now = Date.now();
    let entry = this.circuitBreaker.get(tokenId);

    if (!entry) {
      // Create new entry
      entry = {
        firstFailureAtMs: now,
        failureCount: 1,
        openedAtMs: 0,
        lastKnownPrice,
        errorType,
      };
    } else {
      // Check if we're in a new window
      if (
        now - entry.firstFailureAtMs >
        PositionTracker.CIRCUIT_BREAKER_WINDOW_MS
      ) {
        // New window - reset counter
        entry.firstFailureAtMs = now;
        entry.failureCount = 1;
      } else {
        // Same window - increment counter
        entry.failureCount++;
      }

      // Update error type and last known price
      entry.errorType = errorType;
      if (lastKnownPrice !== undefined) {
        entry.lastKnownPrice = lastKnownPrice;
      }
    }

    // Check if threshold reached - open circuit
    if (
      entry.failureCount >= PositionTracker.CIRCUIT_BREAKER_THRESHOLD &&
      entry.openedAtMs === 0
    ) {
      entry.openedAtMs = now;

      // Log circuit breaker opening (rate-limited per tokenId)
      if (
        this.logDeduper.shouldLog(
          `CircuitBreaker:open:${tokenId.slice(0, 16)}`,
          PositionTracker.CIRCUIT_BREAKER_COOLDOWN_MS,
        )
      ) {
        this.logger.warn(
          `[PositionTracker] ⚡ Circuit breaker OPEN for tokenId=${tokenId.slice(0, 16)}... ` +
            `reason=${errorType} failures=${entry.failureCount} cooldown=${Math.round(PositionTracker.CIRCUIT_BREAKER_COOLDOWN_MS / 1000)}s`,
        );
      }
    }

    // Enforce max entries
    if (
      this.circuitBreaker.size >= PositionTracker.MAX_CIRCUIT_BREAKER_ENTRIES
    ) {
      // Remove oldest entry
      const firstKey = this.circuitBreaker.keys().next().value;
      if (firstKey) {
        this.circuitBreaker.delete(firstKey);
      }
    }

    this.circuitBreaker.set(tokenId, entry);
  }

  /**
   * CIRCUIT BREAKER: Record a success for a tokenId.
   *
   * Called when an API call succeeds.
   * Clears the circuit breaker entry for this tokenId.
   *
   * @param tokenId The tokenId that succeeded
   */
  private recordCircuitBreakerSuccess(tokenId: string): void {
    if (this.circuitBreaker.has(tokenId)) {
      this.circuitBreaker.delete(tokenId);
    }
  }

  /**
   * CIRCUIT BREAKER: Get the last known price for a tokenId.
   *
   * Used when circuit is open to provide a fallback price.
   *
   * @param tokenId The tokenId to look up
   * @returns The last known price, or undefined if not available
   */
  private getCircuitBreakerLastKnownPrice(tokenId: string): number | undefined {
    return this.circuitBreaker.get(tokenId)?.lastKnownPrice;
  }

  // ========================================================================
  // ENTRY METADATA ENRICHMENT
  // ========================================================================

  /**
   * Enrich ACTIVE positions with entry metadata from trade history.
   *
   * WHY THIS EXISTS:
   * ScalpTakeProfit previously calculated "time held" based on container uptime.
   * After container restarts, the clock reset and the scalper missed valid
   * take-profit opportunities on positions already in the green.
   *
   * This method derives entry metadata (cost basis, timestamps) from the
   * Polymarket trade history API - data that survives container restarts.
   *
   * WHAT IT PROVIDES:
   * - avgEntryPriceCents: Weighted average entry price from trade history
   * - firstAcquiredAt: Timestamp of first BUY that contributes to position
   * - lastAcquiredAt: Timestamp of most recent BUY that increased position
   * - timeHeldSec: now - firstAcquiredAt (stable across restarts!)
   *
   * TOKENID-BASED:
   * All calculations use tokenId as primary key. This works for any binary
   * outcome type (YES/NO, Over/Under, TeamA/TeamB, etc.).
   *
   * @returns Array of ACTIVE positions with entry metadata fields populated
   */
  async enrichPositionsWithEntryMeta(): Promise<Position[]> {
    const { resolveSignerAddress } =
      await import("../utils/funds-allowance.util");
    const walletAddress = resolveSignerAddress(this.client);

    // Validate wallet address
    const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    if (!isValidAddress) {
      this.logger.warn(
        `[PositionTracker] Cannot enrich positions - invalid wallet address: ${walletAddress}`,
      );
      return this.getActivePositions();
    }

    // Get only ACTIVE positions (exclude redeemable/resolved)
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return [];
    }

    // Build list of positions to resolve
    const positionsToResolve = activePositions.map((p) => ({
      tokenId: p.tokenId,
      marketId: p.marketId,
    }));

    // Resolve entry metadata for all positions in batch
    const entryMetaMap = await this.entryMetaResolver.resolveEntryMetaBatch(
      walletAddress,
      positionsToResolve,
    );

    // Enrich positions with entry metadata
    const enrichedPositions: Position[] = [];
    let enrichedCount = 0;
    let skippedCount = 0;

    for (const position of activePositions) {
      const entryMeta = entryMetaMap.get(position.tokenId);

      if (entryMeta) {
        enrichedPositions.push({
          ...position,
          avgEntryPriceCents: entryMeta.avgEntryPriceCents,
          firstAcquiredAt: entryMeta.firstAcquiredAt,
          lastAcquiredAt: entryMeta.lastAcquiredAt,
          timeHeldSec: entryMeta.timeHeldSec,
          entryMetaCacheAgeMs: entryMeta.cacheAgeMs,
        });
        enrichedCount++;
      } else {
        // Entry metadata could not be resolved - include position without enrichment
        // This can happen if trade history is unavailable or incomplete
        enrichedPositions.push(position);
        skippedCount++;
      }
    }

    if (enrichedCount > 0 || skippedCount > 0) {
      this.logger.debug(
        `[PositionTracker] Enriched ${enrichedCount} positions with entry metadata, ${skippedCount} skipped (no trade history)`,
      );
    }

    return enrichedPositions;
  }

  /**
   * Get the EntryMetaResolver instance for direct access (e.g., for cache invalidation).
   */
  getEntryMetaResolver(): EntryMetaResolver {
    return this.entryMetaResolver;
  }

  /**
   * Invalidate entry metadata cache for a specific token.
   * Call this after a trade fill to ensure fresh entry data on next lookup.
   */
  async invalidateEntryMetaCache(tokenId: string): Promise<void> {
    const { resolveSignerAddress } =
      await import("../utils/funds-allowance.util");
    const walletAddress = resolveSignerAddress(this.client);
    this.entryMetaResolver.invalidateCache(walletAddress, tokenId);
  }
}
