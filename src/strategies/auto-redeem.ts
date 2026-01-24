// ✅ DROP-IN REPLACEMENT for your redeemPosition() logic + the helpers it needs.
// This fixes: "got invalid index set" by generating indexSets from on-chain outcomeSlotCount,
// uses bigint[] (ethers v6 friendly), and keeps your proxy/direct flow intact.
//
// You can paste this into your AutoRedeemStrategy class and then:
// 1) DELETE your current redeemPosition() implementation
// 2) DELETE the hardcoded indexSets = Array.from({length: 16}...)
// 3) ADD the small imports noted at the top if missing

// ADD at top of file if you don't already have these:
import { ZeroHash } from "ethers"; // ethers v6

// ADD inside class (fields):
private outcomeSlotCountCache = new Map<string, { n: bigint; ts: number }>();
private static readonly OUTCOME_SLOTS_CACHE_MS = 60_000; // 1 min

// ADD inside class (helpers):
private async getOutcomeSlotCountCached(
  wallet: Wallet,
  ctfAddress: string,
  conditionId: string,
): Promise<bigint> {
  const cached = this.outcomeSlotCountCache.get(conditionId);
  const now = Date.now();
  if (cached && now - cached.ts < AutoRedeemStrategy.OUTCOME_SLOTS_CACHE_MS) {
    return cached.n;
  }

  const ctf = new Contract(ctfAddress, CTF_ABI, wallet.provider);
  // CTF method name is typically getOutcomeSlotCount(bytes32)
  const nRaw = await ctf.getOutcomeSlotCount(conditionId);
  const n = BigInt(nRaw);

  if (n <= 1n || n > 256n) {
    throw new Error(`Invalid outcomeSlotCount=${n.toString()} for conditionId=${conditionId}`);
  }

  this.outcomeSlotCountCache.set(conditionId, { n, ts: now });
  return n;
}

private buildIndexSetsFromOutcomeSlots(outcomeSlotCount: bigint): bigint[] {
  // Valid index sets are singletons: 1<<i, for i in [0..n-1], with constraint < fullIndexSet
  // fullIndexSet = (1<<n)-1; for binary n=2 => full=3 => valid [1,2]
  const fullIndexSet = (1n << outcomeSlotCount) - 1n;

  const sets: bigint[] = [];
  for (let i = 0n; i < outcomeSlotCount; i++) {
    const s = 1n << i;
    if (s > 0n && s < fullIndexSet) sets.push(s);
  }

  if (sets.length === 0) {
    throw new Error(`No valid indexSets built for outcomeSlotCount=${outcomeSlotCount.toString()}`);
  }
  return sets;
}

private isRpcRateLimitError(msg: string): boolean {
  return (
    msg.includes("in-flight transaction limit") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("-32000")
  );
}

private isNotResolvedYetError(msg: string): boolean {
  // CTF/UMA style messages vary by wrapper/provider
  return (
    msg.includes("result for condition not received yet") ||
    msg.includes("condition not resolved") ||
    msg.includes("payoutDenominator") ||
    msg.includes("payout denominator") ||
    msg.includes("not resolved")
  );
}

// ✅ DROP-IN redeemPosition() replacement:
private async redeemPosition(position: Position): Promise<RedemptionResult> {
  const wallet = (this.client as { wallet?: Wallet }).wallet;

  if (!wallet) {
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: "No wallet available for redemption",
    };
  }

  const contracts = resolvePolymarketContracts();
  const ctfAddress = contracts.ctfAddress;
  const usdcAddress = contracts.usdcAddress;

  if (!ctfAddress || !usdcAddress) {
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: "CTF or USDC contract address not configured",
    };
  }

  if (!wallet.provider) {
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: "No provider available",
    };
  }

  // IMPORTANT: In your codebase, position.marketId appears to actually be a bytes32 conditionId.
  // If this is not true, you MUST map Polymarket marketId -> conditionId via Gamma and use that here.
  const conditionId = position.marketId;

  if (!conditionId?.startsWith("0x") || conditionId.length !== 66) {
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: `Invalid conditionId format (expected bytes32): ${conditionId}`,
    };
  }

  // Confirm on-chain resolution (you already have this helper)
  const resolutionCheck = await this.isConditionResolvedOnChain(wallet, ctfAddress, conditionId);
  if (resolutionCheck.error) {
    this.logger.warn(
      `[AutoRedeem] ⚠️ Could not verify on-chain resolution for ${conditionId.slice(0, 16)}...: ${resolutionCheck.error}`,
    );
    // Continue; the contract call will fail if truly not resolved
  } else if (!resolutionCheck.resolved) {
    this.logger.info(
      `[AutoRedeem] ⏳ Market ${conditionId.slice(0, 16)}... marked redeemable but NOT resolved on-chain yet (oracle hasn't reported results)`,
    );
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: "Condition not resolved on-chain yet (payoutDenominator=0)",
      isNotResolvedYet: true,
    };
  }

  try {
    // 1) Find proxy (optional)
    let proxyAddress: string | null = null;
    try {
      const profileUrl = POLYMARKET_API.PROFILE_ENDPOINT(wallet.address);
      const profileData = await httpGet<{ proxyAddress?: string }>(profileUrl, {
        timeout: AutoRedeemStrategy.API_TIMEOUT_MS,
      });
      if (profileData?.proxyAddress) {
        proxyAddress = profileData.proxyAddress;
        this.logger.debug(`[AutoRedeem] Found proxy address: ${proxyAddress}`);
      }
    } catch {
      this.logger.debug(`[AutoRedeem] No proxy address found, using direct wallet`);
    }

    const targetAddress = proxyAddress || wallet.address;
    this.logger.info(`[AutoRedeem] Redeeming for ${targetAddress} (proxy=${!!proxyAddress})`);

    // 2) Build correct indexSets based on on-chain outcomeSlotCount
    const outcomeSlotCount = await this.getOutcomeSlotCountCached(wallet, ctfAddress, conditionId);
    const indexSets = this.buildIndexSetsFromOutcomeSlots(outcomeSlotCount);

    this.logger.debug(
      `[AutoRedeem] condition=${conditionId.slice(0, 10)}... outcomes=${outcomeSlotCount.toString()} indexSets=[${indexSets
        .slice(0, 8)
        .map((x) => x.toString())
        .join(",")}${indexSets.length > 8 ? ",..." : ""}]`,
    );

    // 3) Encode redeemPositions call
    const ctfInterface = new Interface(CTF_ABI);
    const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
      usdcAddress,
      ZeroHash,      // parentCollectionId bytes32(0)
      conditionId,   // bytes32
      indexSets,     // bigint[]
    ]);

    // 4) Fee data w/ buffer
    const feeData = await wallet.provider.getFeeData();
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
      ? (feeData.maxPriorityFeePerGas * 130n) / 100n
      : undefined;
    const maxFeePerGas = feeData.maxFeePerGas ? (feeData.maxFeePerGas * 130n) / 100n : undefined;

    const txOptions =
      maxPriorityFeePerGas && maxFeePerGas ? { maxPriorityFeePerGas, maxFeePerGas } : {};

    // 5) Send tx (proxy or direct)
    let tx: TransactionResponse;

    if (proxyAddress) {
      this.logger.info(`[AutoRedeem] 🔄 Sending redemption via proxy ${proxyAddress.slice(0, 10)}...`);
      const proxyContract = new Contract(proxyAddress, PROXY_WALLET_ABI, wallet);
      tx = (await proxyContract.proxy(ctfAddress, redeemData, txOptions)) as TransactionResponse;
    } else {
      this.logger.info(`[AutoRedeem] 🔄 Sending direct redemption to CTF...`);
      const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet);
      tx = (await ctfContract.redeemPositions(
        usdcAddress,
        ZeroHash,
        conditionId,
        indexSets,
        txOptions,
      )) as TransactionResponse;
    }

    this.logger.info(`[AutoRedeem] ✅ Tx sent: ${tx.hash}`);

    // 6) Wait for confirmation with timeout
    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Transaction timeout (${AutoRedeemStrategy.TX_CONFIRMATION_TIMEOUT_MS / 1000}s)`,
              ),
            ),
          AutoRedeemStrategy.TX_CONFIRMATION_TIMEOUT_MS,
        ),
      ),
    ]);

    if (!receipt || receipt.status !== 1) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        transactionHash: tx.hash,
        error: "Transaction failed or reverted",
      };
    }

    this.logger.info(
      `[AutoRedeem] ✅ Confirmed in block ${receipt.blockNumber}. View on Polygonscan: https://polygonscan.com/tx/${tx.hash}`,
    );

    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: true,
      transactionHash: tx.hash,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.logger.error(`[AutoRedeem] ❌ Error: ${errorMsg}`);

    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: errorMsg,
      isRateLimited: this.isRpcRateLimitError(errorMsg),
      isNotResolvedYet: this.isNotResolvedYetError(errorMsg),
    };
  }
}
