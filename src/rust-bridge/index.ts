/**
 * Rust CLOB Bridge Module
 *
 * This module provides integration with the official Polymarket Rust CLOB SDK,
 * which has proven more reliable for authentication than the JavaScript SDK.
 */

export {
  RustBridgeClient,
  createRustBridgeClient,
  type RustBridgeConfig,
  type AuthStory,
  type BridgeResponse,
  type AuthResult,
  type ProbeResult,
  type BalanceResult,
  type OrderResult,
  type OrderSide,
  type OrderRequest,
} from "./client";

export {
  RustClobClientAdapter,
  createRustClobClient,
  type RustClobClientConfig,
  type RustClobClientInterface,
} from "./adapter";
