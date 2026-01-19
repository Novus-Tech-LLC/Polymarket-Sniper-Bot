//! Polymarket CLOB Bridge
//!
//! This binary provides a JSON-line based interface for the official Polymarket Rust SDK.
//! It reads commands from stdin and writes responses to stdout, making it easy to integrate
//! with Node.js or other languages.
//!
//! Commands are JSON objects with a "cmd" field:
//! - {"cmd": "auth"} - Authenticate and derive credentials
//! - {"cmd": "balance"} - Get balance and allowance
//! - {"cmd": "order", "token_id": "...", "side": "buy", "amount": 10.0, "price": 0.5} - Place order
//! - {"cmd": "cancel", "order_id": "..."} - Cancel an order
//! - {"cmd": "markets"} - List available markets
//! - {"cmd": "exit"} - Gracefully exit

use std::str::FromStr;
use std::env;
use std::io::{self, BufRead, Write};

use anyhow::{Context, Result, bail};
use polymarket_client_sdk::clob::{Client, Config};
use polymarket_client_sdk::clob::types::{SignatureType, Side, OrderType, Amount};
use polymarket_client_sdk::auth::LocalSigner;
use polymarket_client_sdk::types::{Address, Decimal, address};
use polymarket_client_sdk::POLYGON;
use rust_decimal_macros::dec;
use serde::{Deserialize, Serialize};
use tracing::{info, error, debug, warn};

const CLOB_BASE_URL: &str = "https://clob.polymarket.com";

/// Response sent back to the parent process
#[derive(Serialize)]
struct Response {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_story: Option<AuthStory>,
}

/// Structured auth diagnostic
#[derive(Serialize)]
struct AuthStory {
    run_id: String,
    signer_address: String,
    funder_address: Option<String>,
    signature_type: String,
    auth_status: String,
    balance_usdc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_details: Option<String>,
}

/// Input command from parent process
#[derive(Deserialize)]
struct Command {
    cmd: String,
    #[serde(default)]
    token_id: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    amount: Option<f64>,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    order_id: Option<String>,
    #[serde(default)]
    signature_type: Option<u8>,
    #[serde(default)]
    funder_address: Option<String>,
}

fn emit_response(response: &Response) {
    let json = serde_json::to_string(response).unwrap_or_else(|e| {
        format!(r#"{{"success":false,"error":"JSON serialization failed: {}"}}"#, e)
    });
    println!("{}", json);
    io::stdout().flush().ok();
}

fn success_response(data: serde_json::Value) -> Response {
    Response {
        success: true,
        data: Some(data),
        error: None,
        auth_story: None,
    }
}

fn error_response(error: &str) -> Response {
    Response {
        success: false,
        data: None,
        error: Some(error.to_string()),
        auth_story: None,
    }
}

fn auth_response(story: AuthStory, data: Option<serde_json::Value>) -> Response {
    let success = story.auth_status == "SUCCESS";
    Response {
        success,
        data,
        error: if !success { Some(story.auth_status.clone()) } else { None },
        auth_story: Some(story),
    }
}

fn parse_signature_type(value: Option<u8>) -> SignatureType {
    match value {
        Some(0) => SignatureType::Eoa,
        Some(1) => SignatureType::Proxy,
        Some(2) => SignatureType::GnosisSafe,
        _ => SignatureType::GnosisSafe, // Default to GnosisSafe for browser wallets
    }
}

fn signature_type_name(st: SignatureType) -> &'static str {
    match st {
        SignatureType::Eoa => "EOA",
        SignatureType::Proxy => "Proxy",
        SignatureType::GnosisSafe => "GnosisSafe",
    }
}

/// Generate a unique run ID
fn generate_run_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand: u32 = (ts as u32).wrapping_mul(1103515245).wrapping_add(12345);
    format!("run_{}_{:08x}", ts, rand)
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing with structured JSON output
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("polymarket_bridge=info".parse().unwrap())
                .add_directive("polymarket_client_sdk=info".parse().unwrap())
        )
        .json()
        .with_target(false)
        .with_current_span(false)
        .init();

    let run_id = generate_run_id();
    info!(run_id = %run_id, "Polymarket Bridge starting");

    // Read private key from environment
    let private_key = env::var("POLYMARKET_PRIVATE_KEY")
        .or_else(|_| env::var("PRIVATE_KEY"))
        .context("POLYMARKET_PRIVATE_KEY or PRIVATE_KEY environment variable must be set")?;

    // Parse optional configuration from environment
    let env_sig_type: Option<u8> = env::var("POLYMARKET_SIGNATURE_TYPE")
        .ok()
        .and_then(|s| s.parse().ok());
    let env_funder: Option<String> = env::var("POLYMARKET_PROXY_ADDRESS")
        .or_else(|_| env::var("CLOB_FUNDER_ADDRESS"))
        .ok();

    // Create signer from private key
    let signer = LocalSigner::from_str(&private_key)
        .context("Failed to parse private key")?
        .with_chain_id(Some(POLYGON));

    let signer_address = format!("{:?}", signer.address());
    info!(signer_address = %signer_address, "Signer initialized");

    // Read commands from stdin
    let stdin = io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l.trim().to_string(),
            Err(e) => {
                error!(error = %e, "Failed to read stdin");
                continue;
            }
        };

        if line.is_empty() {
            continue;
        }

        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                emit_response(&error_response(&format!("Invalid JSON: {}", e)));
                continue;
            }
        };

        match cmd.cmd.as_str() {
            "auth" => {
                let sig_type = parse_signature_type(cmd.signature_type.or(env_sig_type));
                let funder_str = cmd.funder_address.as_ref().or(env_funder.as_ref());

                info!(
                    signature_type = signature_type_name(sig_type),
                    funder = ?funder_str,
                    "Attempting authentication"
                );

                let mut auth_story = AuthStory {
                    run_id: run_id.clone(),
                    signer_address: signer_address.clone(),
                    funder_address: funder_str.cloned(),
                    signature_type: signature_type_name(sig_type).to_string(),
                    auth_status: "PENDING".to_string(),
                    balance_usdc: None,
                    error_details: None,
                };

                // Build client with authentication
                let client_result = async {
                    let config = Config::default();
                    let mut auth_builder = Client::new(CLOB_BASE_URL, config)?
                        .authentication_builder(&signer)
                        .signature_type(sig_type);

                    // Set funder address if provided (for Safe/Proxy wallets)
                    if let Some(funder) = funder_str {
                        let funder_addr: Address = funder.parse()
                            .context("Invalid funder address format")?;
                        auth_builder = auth_builder.funder(funder_addr);
                    }

                    let client = auth_builder.authenticate().await?;
                    Ok::<_, anyhow::Error>(client)
                }.await;

                match client_result {
                    Ok(client) => {
                        info!("Authentication successful");
                        auth_story.auth_status = "SUCCESS".to_string();

                        // Try to get balance to verify credentials work
                        match client.balance_allowance().await {
                            Ok(balance) => {
                                let balance_str = format!("{}", balance.balance);
                                auth_story.balance_usdc = Some(balance_str.clone());
                                emit_response(&auth_response(auth_story, Some(serde_json::json!({
                                    "authenticated": true,
                                    "balance": balance_str,
                                    "allowance": format!("{}", balance.allowance),
                                }))));
                            }
                            Err(e) => {
                                warn!(error = %e, "Failed to get balance after auth");
                                emit_response(&auth_response(auth_story, Some(serde_json::json!({
                                    "authenticated": true,
                                    "balance_error": format!("{}", e),
                                }))));
                            }
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "Authentication failed");
                        auth_story.auth_status = "FAILED".to_string();
                        auth_story.error_details = Some(format!("{:#}", e));
                        emit_response(&auth_response(auth_story, None));
                    }
                }
            }

            "probe" => {
                // Run authentication probe with all signature types
                info!("Running authentication probe (trying all signature types)");

                let sig_types = [SignatureType::Eoa, SignatureType::GnosisSafe, SignatureType::Proxy];
                let funder_str = cmd.funder_address.as_ref().or(env_funder.as_ref());
                let mut results = Vec::new();

                for sig_type in sig_types {
                    let mut story = AuthStory {
                        run_id: run_id.clone(),
                        signer_address: signer_address.clone(),
                        funder_address: funder_str.cloned(),
                        signature_type: signature_type_name(sig_type).to_string(),
                        auth_status: "PENDING".to_string(),
                        balance_usdc: None,
                        error_details: None,
                    };

                    let result = async {
                        let config = Config::default();
                        let mut auth_builder = Client::new(CLOB_BASE_URL, config)?
                            .authentication_builder(&signer)
                            .signature_type(sig_type);

                        if let Some(funder) = funder_str {
                            let funder_addr: Address = funder.parse()
                                .context("Invalid funder address format")?;
                            auth_builder = auth_builder.funder(funder_addr);
                        }

                        let client = auth_builder.authenticate().await?;
                        let balance = client.balance_allowance().await?;
                        Ok::<_, anyhow::Error>((client, balance))
                    }.await;

                    match result {
                        Ok((_, balance)) => {
                            story.auth_status = "SUCCESS".to_string();
                            story.balance_usdc = Some(format!("{}", balance.balance));
                            info!(
                                signature_type = signature_type_name(sig_type),
                                balance = %balance.balance,
                                "Auth probe succeeded"
                            );
                            results.push(serde_json::json!({
                                "signature_type": signature_type_name(sig_type),
                                "success": true,
                                "balance": format!("{}", balance.balance),
                            }));
                            // Found working config, emit success and stop
                            emit_response(&Response {
                                success: true,
                                data: Some(serde_json::json!({
                                    "working_config": {
                                        "signature_type": signature_type_name(sig_type),
                                        "funder_address": funder_str,
                                    },
                                    "balance": format!("{}", balance.balance),
                                    "allowance": format!("{}", balance.allowance),
                                    "probe_results": results,
                                })),
                                error: None,
                                auth_story: Some(story),
                            });
                            continue;
                        }
                        Err(e) => {
                            story.auth_status = "FAILED".to_string();
                            story.error_details = Some(format!("{:#}", e));
                            debug!(
                                signature_type = signature_type_name(sig_type),
                                error = %e,
                                "Auth probe failed"
                            );
                            results.push(serde_json::json!({
                                "signature_type": signature_type_name(sig_type),
                                "success": false,
                                "error": format!("{}", e),
                            }));
                        }
                    }
                }

                // All failed
                emit_response(&Response {
                    success: false,
                    data: Some(serde_json::json!({
                        "probe_results": results,
                        "recommendation": "Visit polymarket.com, connect your wallet, and make at least one trade. Then retry.",
                    })),
                    error: Some("All authentication methods failed".to_string()),
                    auth_story: None,
                });
            }

            "balance" => {
                let sig_type = parse_signature_type(cmd.signature_type.or(env_sig_type));
                let funder_str = cmd.funder_address.as_ref().or(env_funder.as_ref());

                let result = async {
                    let config = Config::default();
                    let mut auth_builder = Client::new(CLOB_BASE_URL, config)?
                        .authentication_builder(&signer)
                        .signature_type(sig_type);

                    if let Some(funder) = funder_str {
                        let funder_addr: Address = funder.parse()?;
                        auth_builder = auth_builder.funder(funder_addr);
                    }

                    let client = auth_builder.authenticate().await?;
                    let balance = client.balance_allowance().await?;
                    Ok::<_, anyhow::Error>(balance)
                }.await;

                match result {
                    Ok(balance) => {
                        emit_response(&success_response(serde_json::json!({
                            "balance": format!("{}", balance.balance),
                            "allowance": format!("{}", balance.allowance),
                        })));
                    }
                    Err(e) => {
                        emit_response(&error_response(&format!("Failed to get balance: {}", e)));
                    }
                }
            }

            "order" => {
                let token_id = match cmd.token_id {
                    Some(t) => t,
                    None => {
                        emit_response(&error_response("Missing token_id"));
                        continue;
                    }
                };
                let side_str = cmd.side.unwrap_or_else(|| "buy".to_string());
                let amount = cmd.amount.unwrap_or(10.0);
                let price = cmd.price;

                let sig_type = parse_signature_type(cmd.signature_type.or(env_sig_type));
                let funder_str = cmd.funder_address.as_ref().or(env_funder.as_ref());

                let side = if side_str.eq_ignore_ascii_case("buy") {
                    Side::Buy
                } else {
                    Side::Sell
                };

                info!(
                    token_id = %token_id,
                    side = %side_str,
                    amount = amount,
                    price = ?price,
                    "Placing order"
                );

                let result = async {
                    let config = Config::default();
                    let mut auth_builder = Client::new(CLOB_BASE_URL, config)?
                        .authentication_builder(&signer)
                        .signature_type(sig_type);

                    if let Some(funder) = funder_str {
                        let funder_addr: Address = funder.parse()?;
                        auth_builder = auth_builder.funder(funder_addr);
                    }

                    let client = auth_builder.authenticate().await?;

                    // Convert amount to Decimal
                    let amount_decimal = Decimal::from_str(&format!("{}", amount))
                        .context("Invalid amount")?;

                    if let Some(limit_price) = price {
                        // Limit order
                        let price_decimal = Decimal::from_str(&format!("{}", limit_price))
                            .context("Invalid price")?;
                        
                        let order = client
                            .limit_order()
                            .token_id(&token_id)
                            .size(amount_decimal)
                            .price(price_decimal)
                            .side(side)
                            .build()
                            .await?;
                        
                        let signed_order = client.sign(&signer, order).await?;
                        let response = client.post_order(signed_order).await?;
                        Ok::<_, anyhow::Error>(serde_json::json!({
                            "order_type": "limit",
                            "response": format!("{:?}", response),
                        }))
                    } else {
                        // Market order
                        let amount_usdc = Amount::usdc(amount_decimal)?;
                        
                        let order = client
                            .market_order()
                            .token_id(&token_id)
                            .amount(amount_usdc)
                            .side(side)
                            .order_type(OrderType::FOK)
                            .build()
                            .await?;
                        
                        let signed_order = client.sign(&signer, order).await?;
                        let response = client.post_order(signed_order).await?;
                        Ok::<_, anyhow::Error>(serde_json::json!({
                            "order_type": "market",
                            "response": format!("{:?}", response),
                        }))
                    }
                }.await;

                match result {
                    Ok(data) => {
                        info!("Order placed successfully");
                        emit_response(&success_response(data));
                    }
                    Err(e) => {
                        error!(error = %e, "Order failed");
                        emit_response(&error_response(&format!("Order failed: {}", e)));
                    }
                }
            }

            "cancel" => {
                let order_id = match cmd.order_id {
                    Some(id) => id,
                    None => {
                        emit_response(&error_response("Missing order_id"));
                        continue;
                    }
                };

                let sig_type = parse_signature_type(cmd.signature_type.or(env_sig_type));
                let funder_str = cmd.funder_address.as_ref().or(env_funder.as_ref());

                info!(order_id = %order_id, "Cancelling order");

                let result = async {
                    let config = Config::default();
                    let mut auth_builder = Client::new(CLOB_BASE_URL, config)?
                        .authentication_builder(&signer)
                        .signature_type(sig_type);

                    if let Some(funder) = funder_str {
                        let funder_addr: Address = funder.parse()?;
                        auth_builder = auth_builder.funder(funder_addr);
                    }

                    let client = auth_builder.authenticate().await?;
                    client.cancel_order(&order_id).await?;
                    Ok::<_, anyhow::Error>(())
                }.await;

                match result {
                    Ok(_) => {
                        emit_response(&success_response(serde_json::json!({
                            "cancelled": true,
                            "order_id": order_id,
                        })));
                    }
                    Err(e) => {
                        emit_response(&error_response(&format!("Cancel failed: {}", e)));
                    }
                }
            }

            "markets" => {
                // Get markets (unauthenticated)
                let result = async {
                    let client = Client::default();
                    let markets = client.markets().await?;
                    Ok::<_, anyhow::Error>(markets)
                }.await;

                match result {
                    Ok(markets) => {
                        emit_response(&success_response(serde_json::json!({
                            "count": markets.len(),
                            "markets": markets.iter().take(10).collect::<Vec<_>>(),
                        })));
                    }
                    Err(e) => {
                        emit_response(&error_response(&format!("Failed to get markets: {}", e)));
                    }
                }
            }

            "exit" | "quit" => {
                info!("Exit command received, shutting down");
                emit_response(&success_response(serde_json::json!({
                    "status": "exiting",
                })));
                break;
            }

            _ => {
                emit_response(&error_response(&format!("Unknown command: {}", cmd.cmd)));
            }
        }
    }

    info!("Polymarket Bridge shutting down");
    Ok(())
}
