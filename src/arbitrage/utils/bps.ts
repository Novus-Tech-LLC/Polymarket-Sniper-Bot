export function toBps(value: number): number {
  return Math.round(value * 10000);
}

export function fromBps(value: number): number {
  return value / 10000;
}

export function calculateEdgeBps(yesAsk: number, noAsk: number): number {
  return toBps(yesAsk + noAsk - 1);
}

export function estimateProfitUsd(params: {
  sizeUsd: number;
  edgeBps: number;
  feeBps: number;
  slippageBps: number;
}): number {
  const { sizeUsd, edgeBps, feeBps, slippageBps } = params;
  const grossEdge = fromBps(edgeBps) * sizeUsd;
  const totalCosts = sizeUsd * 2 * fromBps(feeBps + slippageBps);
  return grossEdge - totalCosts;
}

export function calculateSpreadBps(bestBid: number, bestAsk: number): number {
  if (!bestBid || !bestAsk) return Number.POSITIVE_INFINITY;
  const mid = (bestBid + bestAsk) / 2;
  if (!mid) return Number.POSITIVE_INFINITY;
  return toBps((bestAsk - bestBid) / mid);
}
