/**
 * Rust CLOB Bridge Client
 *
 * This module provides a TypeScript interface to the Polymarket Rust CLOB SDK.
 * It spawns a Rust binary that handles authentication and order operations,
 * communicating via JSON over stdin/stdout.
 *
 * The Rust SDK has proven to be more reliable for authentication, especially
 * with browser-wallet (GnosisSafe) configurations.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as readline from "readline";
import type { Logger } from "../utils/logger.util";

export interface RustBridgeConfig {
  /** Path to the Rust binary (default: auto-detect) */
  binaryPath?: string;
  /** Private key for signing */
  privateKey: string;
  /** Optional signature type (0=EOA, 1=Proxy, 2=GnosisSafe) */
  signatureType?: number;
  /** Optional funder/proxy address */
  funderAddress?: string;
  /** Logger instance */
  logger?: Logger;
}

export interface AuthStory {
  run_id: string;
  signer_address: string;
  funder_address?: string;
  signature_type: string;
  auth_status: string;
  balance_usdc?: string;
  error_details?: string;
}

export interface BridgeResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  auth_story?: AuthStory;
}

export interface AuthResult {
  authenticated: boolean;
  balance?: string;
  allowance?: string;
  balance_error?: string;
}

export interface ProbeResult {
  working_config?: {
    signature_type: string;
    funder_address?: string;
  };
  balance?: string;
  allowance?: string;
  probe_results: Array<{
    signature_type: string;
    success: boolean;
    balance?: string;
    error?: string;
  }>;
  recommendation?: string;
}

export interface BalanceResult {
  balance: string;
  allowance: string;
}

export interface OrderResult {
  order_type: string;
  response: string;
}

export type OrderSide = "buy" | "sell";

export interface OrderRequest {
  tokenId: string;
  side: OrderSide;
  amount: number;
  price?: number; // If provided, creates limit order; otherwise market order
}

/**
 * Client for communicating with the Rust CLOB bridge
 */
export class RustBridgeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;

  private responseQueue: Array<{
    resolve: (value: BridgeResponse) => void;
    reject: (error: Error) => void;
  }> = [];

  private config: RustBridgeConfig;
  private logger?: Logger;
  private started = false;

  constructor(config: RustBridgeConfig) {
    super();
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Find the Rust binary path
   */
  private getBinaryPath(): string {
    if (this.config.binaryPath) {
      return this.config.binaryPath;
    }

    // In CommonJS (our compilation target), __dirname is available

    const currentDir =
      typeof __dirname !== "undefined" ? __dirname : process.cwd();

    // Try common locations
    const candidates = [
      // Local development builds
      path.join(
        currentDir,
        "..",
        "..",
        "rust-clob-bridge",
        "target",
        "release",
        "polymarket-bridge",
      ),
      path.join(
        currentDir,
        "..",
        "..",
        "rust-clob-bridge",
        "target",
        "debug",
        "polymarket-bridge",
      ),
      // Docker builds
      "/app/bin/polymarket-bridge",
      "/usr/local/bin/polymarket-bridge",
      // System PATH
      "polymarket-bridge",
    ];

    // For now, return the release path - the build step will create it
    return candidates[0];
  }

  /**
   * Start the Rust bridge process
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const binaryPath = this.getBinaryPath();
    this.logger?.info(`[RustBridge] Starting bridge: ${binaryPath}`);

    // Set up environment for the Rust process
    const env: Record<string, string | undefined> = {
      ...process.env,
      POLYMARKET_PRIVATE_KEY: this.config.privateKey,
      RUST_LOG: process.env.RUST_LOG ?? "info",
    };

    if (this.config.signatureType !== undefined) {
      env.POLYMARKET_SIGNATURE_TYPE = String(this.config.signatureType);
    }

    if (this.config.funderAddress) {
      env.POLYMARKET_PROXY_ADDRESS = this.config.funderAddress;
    }

    this.process = spawn(binaryPath, [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Handle stdout (JSON responses)
    this.rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      try {
        const response = JSON.parse(line) as BridgeResponse;
        const pending = this.responseQueue.shift();
        if (pending) {
          pending.resolve(response);
        } else {
          // Unsolicited message (e.g., from tracing)
          this.emit("message", response);
        }
      } catch {
        // Not JSON - probably a log line
        this.logger?.debug(`[RustBridge] stdout: ${line}`);
      }
    });

    // Handle stderr (logs)
    this.process.stderr?.on("data", (data) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        try {
          // Try parsing as JSON log (from tracing)
          const log = JSON.parse(line);
          const level = log.level?.toLowerCase() ?? "info";
          const msg = log.message ?? log.fields?.message ?? line;
          switch (level) {
            case "error":
              this.logger?.error(`[RustBridge] ${msg}`);
              break;
            case "warn":
              this.logger?.warn(`[RustBridge] ${msg}`);
              break;
            case "debug":
              this.logger?.debug(`[RustBridge] ${msg}`);
              break;
            default:
              this.logger?.info(`[RustBridge] ${msg}`);
          }
        } catch {
          // Plain text log
          this.logger?.debug(`[RustBridge] ${line}`);
        }
      }
    });

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      this.logger?.info(
        `[RustBridge] Process exited: code=${code}, signal=${signal}`,
      );
      this.started = false;
      this.emit("exit", { code, signal });

      // Reject any pending requests
      while (this.responseQueue.length > 0) {
        const pending = this.responseQueue.shift();
        pending?.reject(new Error("Bridge process exited"));
      }
    });

    this.process.on("error", (err) => {
      this.logger?.error(`[RustBridge] Process error: ${err.message}`);
      this.emit("error", err);
    });

    this.started = true;
    this.logger?.info("[RustBridge] Bridge process started");
  }

  /**
   * Send a command to the bridge and wait for response
   */
  private async sendCommand<T>(
    cmd: Record<string, unknown>,
  ): Promise<BridgeResponse<T>> {
    if (!this.started || !this.process?.stdin) {
      throw new Error("Bridge not started");
    }

    return new Promise((resolve, reject) => {
      this.responseQueue.push({
        resolve: resolve as (val: BridgeResponse) => void,
        reject,
      });

      const json = JSON.stringify(cmd) + "\n";
      this.process!.stdin!.write(json, (err) => {
        if (err) {
          this.responseQueue.pop();
          reject(err);
        }
      });
    });
  }

  /**
   * Authenticate with Polymarket and derive credentials
   */
  async authenticate(options?: {
    signatureType?: number;
    funderAddress?: string;
  }): Promise<BridgeResponse<AuthResult>> {
    await this.start();
    return this.sendCommand<AuthResult>({
      cmd: "auth",
      signature_type: options?.signatureType ?? this.config.signatureType,
      funder_address: options?.funderAddress ?? this.config.funderAddress,
    });
  }

  /**
   * Run authentication probe - tries all signature types
   */
  async probe(options?: {
    funderAddress?: string;
  }): Promise<BridgeResponse<ProbeResult>> {
    await this.start();
    return this.sendCommand<ProbeResult>({
      cmd: "probe",
      funder_address: options?.funderAddress ?? this.config.funderAddress,
    });
  }

  /**
   * Get balance and allowance
   */
  async getBalance(options?: {
    signatureType?: number;
    funderAddress?: string;
  }): Promise<BridgeResponse<BalanceResult>> {
    await this.start();
    return this.sendCommand<BalanceResult>({
      cmd: "balance",
      signature_type: options?.signatureType ?? this.config.signatureType,
      funder_address: options?.funderAddress ?? this.config.funderAddress,
    });
  }

  /**
   * Place an order
   */
  async placeOrder(
    order: OrderRequest,
    options?: {
      signatureType?: number;
      funderAddress?: string;
    },
  ): Promise<BridgeResponse<OrderResult>> {
    await this.start();
    return this.sendCommand<OrderResult>({
      cmd: "order",
      token_id: order.tokenId,
      side: order.side,
      amount: order.amount,
      price: order.price,
      signature_type: options?.signatureType ?? this.config.signatureType,
      funder_address: options?.funderAddress ?? this.config.funderAddress,
    });
  }

  /**
   * Cancel an order
   */
  async cancelOrder(
    orderId: string,
    options?: {
      signatureType?: number;
      funderAddress?: string;
    },
  ): Promise<BridgeResponse<{ cancelled: boolean; order_id: string }>> {
    await this.start();
    return this.sendCommand({
      cmd: "cancel",
      order_id: orderId,
      signature_type: options?.signatureType ?? this.config.signatureType,
      funder_address: options?.funderAddress ?? this.config.funderAddress,
    });
  }

  /**
   * List markets (unauthenticated)
   */
  async listMarkets(): Promise<
    BridgeResponse<{ count: number; markets: unknown[] }>
  > {
    await this.start();
    return this.sendCommand({
      cmd: "markets",
    });
  }

  /**
   * Gracefully stop the bridge
   */
  async stop(): Promise<void> {
    if (!this.started || !this.process) {
      return;
    }

    try {
      await this.sendCommand({ cmd: "exit" });
    } catch {
      // Process may have already exited
    }

    this.rl?.close();
    this.process.kill("SIGTERM");
    this.started = false;
  }

  /**
   * Check if bridge is running
   */
  isRunning(): boolean {
    return this.started && this.process !== null;
  }
}

/**
 * Create a Rust bridge client with the given configuration
 */
export function createRustBridgeClient(
  config: RustBridgeConfig,
): RustBridgeClient {
  return new RustBridgeClient(config);
}

export default RustBridgeClient;
