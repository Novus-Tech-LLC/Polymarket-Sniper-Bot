/**
 * Rust Bridge CLOB Adapter
 *
 * This module adapts the Rust CLOB bridge to the existing ClobClient interface,
 * allowing it to be used as a drop-in replacement for authentication and trading.
 */

import {
  RustBridgeClient,
  createRustBridgeClient,
  type OrderSide,
} from "./client";
import type { Logger } from "../utils/logger.util";
import { Wallet, JsonRpcProvider } from "ethers";
import { resolveDerivedSignerAddress } from "../clob/addressing";

/**
 * Configuration for the Rust-backed CLOB client
 */
export interface RustClobClientConfig {
  rpcUrl: string;
  privateKey: string;
  signatureType?: number;
  funderAddress?: string;
  logger?: Logger;
}

/**
 * Partial ClobClient interface that we support via Rust bridge
 * Note: Interface method parameters are intentionally named for documentation
 */

export interface RustClobClientInterface {
  wallet: Wallet;
  derivedSignerAddress: string;
  effectivePolyAddress: string;
  executionDisabled: boolean;

  // Authentication status
  isAuthenticated(): boolean;
  getAuthStory(): unknown;

  // Balance operations
  getBalanceAllowance(): Promise<{ balance: string; allowance: string }>;

  // Market operations
  getMarket(marketId: string): Promise<unknown>;
  getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }>;

  // Order operations
  createMarketOrder(args: {
    side: number;
    tokenID: string;
    amount: number;
    price: number;
  }): Promise<unknown>;
  postOrder(signedOrder: unknown, orderType: unknown): Promise<unknown>;
  cancelOrder(orderId: string): Promise<void>;
}

/**
 * Adapter that wraps RustBridgeClient to provide ClobClient-like interface
 */
export class RustClobClientAdapter implements RustClobClientInterface {
  private bridge: RustBridgeClient;
  private config: RustClobClientConfig;
  private _wallet: Wallet;
  private _derivedSignerAddress: string;
  private _effectivePolyAddress: string;
  private _authenticated = false;
  private _authStory: unknown = null;
  private logger?: Logger;

  constructor(config: RustClobClientConfig) {
    this.config = config;
    this.logger = config.logger;

    // Create ethers wallet for compatibility
    const provider = new JsonRpcProvider(config.rpcUrl);
    this._wallet = new Wallet(config.privateKey, provider);
    this._derivedSignerAddress = resolveDerivedSignerAddress(config.privateKey);

    // Effective address is funder if set, otherwise signer
    this._effectivePolyAddress =
      config.funderAddress ?? this._derivedSignerAddress;

    // Create the Rust bridge
    this.bridge = createRustBridgeClient({
      privateKey: config.privateKey,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
      logger: config.logger,
    });
  }

  get wallet(): Wallet {
    return this._wallet;
  }

  get derivedSignerAddress(): string {
    return this._derivedSignerAddress;
  }

  get effectivePolyAddress(): string {
    return this._effectivePolyAddress;
  }

  get executionDisabled(): boolean {
    return !this._authenticated;
  }

  /**
   * Initialize authentication with the Rust bridge
   */
  async initialize(): Promise<boolean> {
    try {
      this.logger?.info("[RustClobAdapter] Initializing with Rust bridge...");

      // Start the bridge and probe for working configuration
      const result = await this.bridge.probe({
        funderAddress: this.config.funderAddress,
      });

      if (result.success && result.data?.working_config) {
        this._authenticated = true;
        this._authStory = result.auth_story;

        this.logger?.info(
          `[RustClobAdapter] Authentication successful: ${result.data.working_config.signature_type}`,
        );
        this.logger?.info(
          `[RustClobAdapter] Balance: ${result.data.balance} USDC`,
        );

        // Update effective address if funder was auto-derived
        if (result.data.working_config.funder_address) {
          this._effectivePolyAddress =
            result.data.working_config.funder_address;
        }

        return true;
      } else {
        this._authenticated = false;
        this.logger?.error("[RustClobAdapter] Authentication failed");

        if (result.data?.probe_results) {
          for (const probe of result.data.probe_results) {
            this.logger?.debug(
              `[RustClobAdapter] ${probe.signature_type}: ${probe.error ?? "success"}`,
            );
          }
        }

        return false;
      }
    } catch (error) {
      this._authenticated = false;
      this.logger?.error(
        `[RustClobAdapter] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  isAuthenticated(): boolean {
    return this._authenticated;
  }

  getAuthStory(): unknown {
    return this._authStory;
  }

  async getBalanceAllowance(): Promise<{ balance: string; allowance: string }> {
    const result = await this.bridge.getBalance({
      signatureType: this.config.signatureType,
      funderAddress: this.config.funderAddress,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error ?? "Failed to get balance");
    }

    return {
      balance: result.data.balance,
      allowance: result.data.allowance,
    };
  }

  async getMarket(marketId: string): Promise<unknown> {
    // For now, return a placeholder - markets can be fetched unauthenticated
    this.logger?.debug(
      `[RustClobAdapter] getMarket(${marketId}) - using JS client for this`,
    );
    // TODO: Implement via Rust bridge when needed
    return { id: marketId };
  }

  async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }> {
    // For now, this needs JS client - Rust bridge doesn't expose orderbook yet
    this.logger?.debug(
      `[RustClobAdapter] getOrderBook(${tokenId}) - using JS client for this`,
    );
    // TODO: Implement via Rust bridge when needed
    throw new Error(
      "getOrderBook not yet implemented via Rust bridge - use JS client for market data",
    );
  }

  async createMarketOrder(args: {
    side: number;
    tokenID: string;
    amount: number;
    price: number;
  }): Promise<unknown> {
    const side: OrderSide = args.side === 0 ? "buy" : "sell";

    const result = await this.bridge.placeOrder(
      {
        tokenId: args.tokenID,
        side,
        amount: args.amount,
        price: args.price,
      },
      {
        signatureType: this.config.signatureType,
        funderAddress: this.config.funderAddress,
      },
    );

    if (!result.success) {
      throw new Error(result.error ?? "Order failed");
    }

    return result.data;
  }

  async postOrder(signedOrder: unknown, _orderType: unknown): Promise<unknown> {
    // When using Rust bridge, orders are signed and posted in one step
    // This method exists for interface compatibility
    this.logger?.debug(
      "[RustClobAdapter] postOrder called - order already posted via createMarketOrder",
    );
    return signedOrder;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const result = await this.bridge.cancelOrder(orderId, {
      signatureType: this.config.signatureType,
      funderAddress: this.config.funderAddress,
    });

    if (!result.success) {
      throw new Error(result.error ?? "Cancel failed");
    }
  }

  /**
   * Stop the Rust bridge
   */
  async stop(): Promise<void> {
    await this.bridge.stop();
  }
}

/**
 * Create a Rust-backed CLOB client
 */
export async function createRustClobClient(
  config: RustClobClientConfig,
): Promise<RustClobClientAdapter> {
  const adapter = new RustClobClientAdapter(config);
  await adapter.initialize();
  return adapter;
}
