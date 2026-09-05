/**
 * Spot via CoW Protocol (MEV-protected batch auctions). Flow: quote → the
 * user signs an EIP-712 order in their wallet → order posted to the CoW
 * order book → status polled. Oilskin never touches the tokens: the order is
 * settled by a solver against the user's own balance through the
 * GPv2VaultRelayer allowance.
 *
 * The vault-relayer address is READ from settlement.vaultRelayer() — it is not
 * in VERIFIED-BASE-FACTS and must not be typed.
 */
import type { Address } from "viem";
import { OrderKind, SupportedChainId, TradingSdk, type QuoteResults } from "@cowprotocol/cow-sdk";
import { ViemAdapter } from "@cowprotocol/sdk-viem-adapter";
import { BASE_TOKENS, CHAIN_ID, COW_PROTOCOL, type TokenSymbol } from "@zyo/shared";
import { COW_SETTLEMENT_ABI, ERC20_ABI } from "./abi/aave";
import { fromAtomic } from "./math";
import { ENV } from "./env";
import type { ReadClient } from "./reads";

/** Structural client type so wagmi's chain-specialised clients pass to the CoW adapter without casts. */
type AnyClient = object;

if ((SupportedChainId.BASE as number) !== CHAIN_ID) throw new Error("CoW SupportedChainId.BASE != @zyo/shared CHAIN_ID");

/** Slippage the user may set in Advanced mode, bps of price. Beyond MAX the page refuses to sign; Simple mode uses CoW's suggestion only. */
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_WARN_BPS = 100;
export const SLIPPAGE_MAX_BPS = 300;

export type SpotToken = Extract<TokenSymbol, "USDC" | "WETH" | "cbBTC" | "cbZEC">;
export const SPOT_TOKENS: readonly SpotToken[] = ["USDC", "WETH", "cbBTC", "cbZEC"];

export interface SpotQuote {
  sell: SpotToken;
  buy: SpotToken;
  sellAmount: number;
  /** Expected buy amount after network costs and protocol fees, before slippage. */
  expectedBuy: number;
  /** Minimum buy amount the order guarantees (after the slippage tolerance). */
  minBuy: number;
  /** Solver network cost, in the sell token. */
  networkCostSell: number;
  slippageBps: number;
  /** Seconds until the order expires unfilled (nothing spent). */
  validForSeconds: number;
  quotedAt: string;
  raw: QuoteResults;
}

export function makeTradingSdk(publicClient: AnyClient, walletClient?: AnyClient): TradingSdk {
  const adapter = new ViemAdapter({ provider: publicClient as never, walletClient: walletClient as never });
  return new TradingSdk({ chainId: SupportedChainId.BASE, appCode: ENV.cowAppCode }, { enableLogging: false }, adapter);
}

export function toSpotQuote(sell: SpotToken, buy: SpotToken, sellAmount: number, q: QuoteResults): SpotQuote {
  const buyDec = BASE_TOKENS[buy].decimals;
  const sellDec = BASE_TOKENS[sell].decimals;
  const a = q.amountsAndCosts;
  return {
    sell,
    buy,
    sellAmount,
    expectedBuy: fromAtomic(BigInt(a.afterPartnerFees.buyAmount), buyDec),
    minBuy: fromAtomic(BigInt(a.afterSlippage.buyAmount), buyDec),
    networkCostSell: fromAtomic(BigInt(a.costs.networkFee.amountInSellCurrency), sellDec),
    slippageBps: q.suggestedSlippageBps,
    validForSeconds: Math.max(0, Number(q.orderToSign.validTo) - Math.floor(Date.now() / 1000)),
    quotedAt: new Date().toISOString(),
    raw: q,
  };
}

export async function getSpotQuote(sdk: TradingSdk, owner: Address, sell: SpotToken, buy: SpotToken, sellAmountAtomic: bigint, slippageBps?: number) {
  const { quoteResults, postSwapOrderFromQuote } = await sdk.getQuote({
    kind: OrderKind.SELL,
    owner,
    sellToken: BASE_TOKENS[sell].address,
    sellTokenDecimals: BASE_TOKENS[sell].decimals,
    buyToken: BASE_TOKENS[buy].address,
    buyTokenDecimals: BASE_TOKENS[buy].decimals,
    amount: sellAmountAtomic.toString(),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  });
  return { quote: toSpotQuote(sell, buy, fromAtomic(sellAmountAtomic, BASE_TOKENS[sell].decimals), quoteResults), post: postSwapOrderFromQuote };
}

/** The spender CoW orders need an allowance for. Read live; null if unreadable. */
export async function readVaultRelayer(client: ReadClient): Promise<Address | null> {
  try {
    return (await client.readContract({ address: COW_PROTOCOL.settlement, abi: COW_SETTLEMENT_ABI, functionName: "vaultRelayer" })) as Address;
  } catch {
    return null;
  }
}

export async function readAllowance(client: ReadClient, token: SpotToken, owner: Address, spender: Address): Promise<bigint> {
  return (await client.readContract({ address: BASE_TOKENS[token].address, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] })) as bigint;
}

export type SpotOrderStatus = "open" | "fulfilled" | "cancelled" | "expired" | "presignaturePending" | "unknown";

export async function readOrderStatus(sdk: TradingSdk, orderUid: string): Promise<{ status: SpotOrderStatus; executedBuy?: string }> {
  const o = await sdk.getOrder({ orderUid });
  return { status: (o.status as SpotOrderStatus) ?? "unknown", executedBuy: o.executedBuyAmount };
}
