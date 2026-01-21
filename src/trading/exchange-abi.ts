/**
 * CTF Exchange Contract ABIs for Polymarket
 *
 * Polymarket uses Gnosis Conditional Token Framework (CTF) Exchange contracts
 * for on-chain trading. These ABIs define the interface for interacting with
 * the exchange contracts directly on the Polygon network.
 *
 * @see https://docs.polymarket.com/developers/CTF/deployment-resources
 * @see https://github.com/Polymarket/ctf-exchange
 */

/**
 * Core CTF Exchange ABI
 *
 * Main exchange contract for trading conditional tokens.
 * Contract address: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E (Polygon Mainnet)
 */
export const CTF_EXCHANGE_ABI = [
  // Order filling functions
  "function fillOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount) external",

  "function fillOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] orders, uint256[] fillAmounts) external",

  "function matchOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) takerOrder, tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts, bytes32 makerSignatureHashs) external",

  // Order cancellation
  "function cancelOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order) external",

  "function cancelOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] orders) external",

  // View functions
  "function getOrderStatus(bytes32 orderHash) external view returns (uint8)",
  "function isValidNonce(address account, uint256 nonce) external view returns (bool)",
  "function hashOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order) external view returns (bytes32)",

  // Registry and operator functions
  "function addOperator(address operator) external",
  "function removeOperator(address operator) external",
  "function isValidOperator(address user, address operator) external view returns (bool)",

  // Events
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
  "event OrderCancelled(bytes32 indexed orderHash)",
  "event OperatorAdded(address indexed user, address indexed operator)",
  "event OperatorRemoved(address indexed user, address indexed operator)",
] as const;

/**
 * Negative Risk CTF Exchange ABI
 *
 * Exchange contract for trading negative risk tokens (e.g., "Will NOT happen").
 * Contract address: 0xC5d563A36AE78145C45a50134d48A1215220f80a (Polygon Mainnet)
 */
export const NEG_RISK_CTF_EXCHANGE_ABI = [
  // Similar to CTF Exchange but with negative risk token support
  "function fillOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount) external",

  "function matchOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) takerOrder, tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts) external",

  "function cancelOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order) external",
] as const;

/**
 * Negative Risk Adapter ABI
 *
 * Adapter contract for converting between standard and negative risk tokens.
 * Contract address: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296 (Polygon Mainnet)
 */
export const NEG_RISK_ADAPTER_ABI = [
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
] as const;

/**
 * Conditional Tokens Framework (CTF) ABI
 *
 * Core conditional token contract for minting, merging, and redeeming positions.
 * Contract address: 0x4d97dcd97ec945f40cf65f87097ace5ea0476045 (Polygon Mainnet)
 */
export const CTF_ABI = [
  // ERC1155 standard functions
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory)",
  "function isApprovedForAll(address account, address operator) external view returns (bool)",
  "function setApprovalForAll(address operator, bool approved) external",

  // CTF-specific functions
  "function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external",
  "function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external",
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",

  // View functions
  "function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external pure returns (bytes32)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) external view returns (uint256)",

  // Events
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount)",
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)",
  "event PositionsMerge(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)",
  "event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)",
] as const;

/**
 * ERC20 ABI (USDC)
 *
 * Standard ERC20 interface used for USDC collateral.
 * USDC.e address: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (Polygon Mainnet)
 */
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",

  // Events
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

/**
 * Order side enum values
 */
export enum OrderSide {
  BUY = 0,
  SELL = 1,
}

/**
 * Order signature type enum values
 */
export enum SignatureType {
  EOA = 0,
  POLY_PROXY = 1,
  POLY_GNOSIS_SAFE = 2,
}

/**
 * Order struct type definition
 */
export type Order = {
  salt: bigint;
  maker: string;
  signer: string;
  taker: string;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  side: OrderSide;
  signatureType: SignatureType;
  signature: string;
};

/**
 * Helper type for creating orders with more flexible input types
 */
export type OrderInput = {
  salt?: bigint | string | number;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string | bigint;
  makerAmount: bigint | string | number;
  takerAmount: bigint | string | number;
  expiration?: bigint | number;
  nonce?: bigint | number;
  feeRateBps?: bigint | number;
  side: OrderSide | 0 | 1;
  signatureType?: SignatureType | 0 | 1 | 2;
  signature?: string;
};

/**
 * Convert OrderInput to Order with proper types
 */
export function normalizeOrder(input: OrderInput): Order {
  return {
    salt: typeof input.salt === "bigint" ? input.salt : BigInt(input.salt ?? 0),
    maker: input.maker,
    signer: input.signer,
    taker: input.taker,
    tokenId:
      typeof input.tokenId === "bigint" ? input.tokenId : BigInt(input.tokenId),
    makerAmount:
      typeof input.makerAmount === "bigint"
        ? input.makerAmount
        : BigInt(input.makerAmount),
    takerAmount:
      typeof input.takerAmount === "bigint"
        ? input.takerAmount
        : BigInt(input.takerAmount),
    expiration:
      typeof input.expiration === "bigint"
        ? input.expiration
        : BigInt(input.expiration ?? 0),
    nonce:
      typeof input.nonce === "bigint" ? input.nonce : BigInt(input.nonce ?? 0),
    feeRateBps:
      typeof input.feeRateBps === "bigint"
        ? input.feeRateBps
        : BigInt(input.feeRateBps ?? 0),
    side: typeof input.side === "number" ? input.side : input.side,
    signatureType: (input.signatureType ?? SignatureType.EOA) as SignatureType,
    signature: input.signature ?? "0x",
  };
}
