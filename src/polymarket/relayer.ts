import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import {
  deriveProxyWallet,
  deriveSafe,
} from "@polymarket/builder-relayer-client/dist/builder/derive";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Logger } from "../utils/logger.util";
import { parsePrivateKey } from "../utils/keys";

export type RelayerContext = {
  enabled: boolean;
  relayerUrl?: string;
  signerUrl?: string;
  signerAddress: string;
  txType?: RelayerTxType;
  client?: RelayClient;
  tradingAddress?: string;
};

export type RelayerTxResult = {
  transactionId?: string;
  transactionHash?: string;
  state?: string;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseRelayerTxType = (
  raw: string | undefined,
): RelayerTxType | undefined => {
  if (!raw) return undefined;
  const normalized = raw.toUpperCase();
  if (normalized === RelayerTxType.PROXY) return RelayerTxType.PROXY;
  if (normalized === RelayerTxType.SAFE) return RelayerTxType.SAFE;
  return undefined;
};

export const createRelayerContext = (params: {
  privateKey: string;
  rpcUrl: string;
  logger?: Logger;
}): RelayerContext => {
  const signerUrl = readEnv("SIGNER_URL");
  const relayerUrl =
    readEnv("RELAYER_URL") ?? "https://relayer-v2.polymarket.com/";
  const txType =
    parseRelayerTxType(readEnv("RELAYER_TX_TYPE")) ?? RelayerTxType.SAFE;

  // Parse and validate private key
  let normalizedKey: string;
  try {
    normalizedKey = parsePrivateKey({ logger: params.logger });
  } catch (error) {
    params.logger?.error(`[Relayer] Private key parsing failed: ${error}`);
    throw error;
  }

  const account = privateKeyToAccount(normalizedKey as Hex);

  // Check for builder credentials
  const builderApiKey = readEnv("POLY_BUILDER_API_KEY");
  const builderSecret = readEnv("POLY_BUILDER_API_SECRET");
  const builderPassphrase = readEnv("POLY_BUILDER_API_PASSPHRASE");
  const useRelayerForApprovals =
    readEnv("USE_RELAYER_FOR_APPROVALS") !== "false"; // Default true

  // Need either signer URL or builder credentials for relayer
  if (!signerUrl && !(builderApiKey && builderSecret && builderPassphrase)) {
    params.logger?.info(
      "[Relayer] Neither SIGNER_URL nor builder credentials provided; relayer disabled.",
    );
    return {
      enabled: false,
      signerAddress: account.address,
    };
  }

  let builderConfig: BuilderConfig;
  if (builderApiKey && builderSecret && builderPassphrase) {
    // Use builder credentials directly
    builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: builderApiKey,
        secret: builderSecret,
        passphrase: builderPassphrase,
      },
    });
    params.logger?.info(
      "[Relayer] Using builder credentials for relayer initialization.",
    );
  } else if (signerUrl) {
    // Use remote signer
    const signerToken = readEnv("SIGNER_AUTH_TOKEN");
    builderConfig = new BuilderConfig({
      remoteBuilderConfig: {
        url: signerUrl,
        ...(signerToken ? { token: signerToken } : {}),
      },
    });
    params.logger?.info(
      "[Relayer] Using remote signer for relayer initialization.",
    );
  } else {
    return {
      enabled: false,
      signerAddress: account.address,
    };
  }

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(params.rpcUrl),
  });

  const client = new RelayClient(
    relayerUrl,
    137,
    walletClient,
    builderConfig,
    txType,
  );
  params.logger?.info(
    `[Relayer] enabled=true relayerUrl=${relayerUrl} txType=${txType} signer=${account.address} useForApprovals=${useRelayerForApprovals}`,
  );

  return {
    enabled: true,
    relayerUrl,
    signerUrl,
    signerAddress: account.address,
    txType,
    client,
  };
};

export const executeRelayerTxs = async (params: {
  relayer: RelayerContext;
  txs: { to: string; data: string; value?: string }[];
  description: string;
  logger: Logger;
}): Promise<RelayerTxResult> => {
  const client = params.relayer.client;
  if (!client) {
    throw new Error("[Relayer] Client unavailable for execute.");
  }

  const txs = params.txs.map((tx) => ({
    to: tx.to,
    data: tx.data,
    value: tx.value ?? "0",
  }));

  params.logger.info(
    `[Relayer] Executing ${txs.length} tx(s) desc=${params.description}`,
  );
  const response = await client.execute(txs, params.description);
  params.logger.info(
    `[Relayer] Submitted relayer_tx_id=${response.transactionID} state=${response.state} hash=${response.transactionHash ?? "n/a"}`,
  );
  const result = await response.wait();
  if (!result) {
    params.logger.warn("[Relayer] Transaction did not reach a final state.");
    return {
      transactionId: response.transactionID,
      transactionHash: response.transactionHash,
      state: response.state,
    };
  }
  params.logger.info(
    `[Relayer] Finalized relayer_tx_id=${result.transactionID} state=${result.state} txHash=${result.transactionHash ?? "n/a"} proxy=${result.proxyAddress}`,
  );
  return {
    transactionId: result.transactionID,
    transactionHash: result.transactionHash ?? response.transactionHash,
    state: result.state,
  };
};

export const deployIfNeeded = async (params: {
  relayer: RelayerContext;
  logger: Logger;
}): Promise<{ tradingAddress?: string }> => {
  const { relayer, logger } = params;
  if (!relayer.enabled || !relayer.client || !relayer.txType) {
    return { tradingAddress: relayer.tradingAddress };
  }

  if (relayer.txType === RelayerTxType.PROXY) {
    const proxyFactory =
      relayer.client.contractConfig.ProxyContracts.ProxyFactory;
    const proxyAddress = deriveProxyWallet(relayer.signerAddress, proxyFactory);
    relayer.tradingAddress = proxyAddress;
    logger.info(
      `[Relayer] Proxy address=${proxyAddress} (deployment deferred to first tx).`,
    );
    return { tradingAddress: proxyAddress };
  }

  const safeFactory = relayer.client.contractConfig.SafeContracts.SafeFactory;
  const safeAddress = deriveSafe(relayer.signerAddress, safeFactory);
  relayer.tradingAddress = safeAddress;
  const deployed = await relayer.client.getDeployed(safeAddress);
  if (deployed) {
    logger.info(`[Relayer] Safe already deployed address=${safeAddress}.`);
    return { tradingAddress: safeAddress };
  }

  logger.info(`[Relayer] Safe not deployed. Deploying address=${safeAddress}.`);
  const response = await relayer.client.deploy();
  logger.info(
    `[Relayer] Deploy submitted relayer_tx_id=${response.transactionID} state=${response.state} hash=${response.transactionHash ?? "n/a"}`,
  );
  const result = await response.wait();
  if (!result) {
    logger.warn("[Relayer] Safe deploy did not reach a final state.");
    return { tradingAddress: safeAddress };
  }
  logger.info(
    `[Relayer] Safe deploy finalized relayer_tx_id=${result.transactionID} state=${result.state} txHash=${result.transactionHash ?? "n/a"} proxy=${result.proxyAddress}`,
  );
  relayer.tradingAddress = result.proxyAddress || safeAddress;
  return { tradingAddress: relayer.tradingAddress };
};
