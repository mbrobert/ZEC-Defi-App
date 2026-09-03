import { ONE_CLICK_ENDPOINTS } from "@zyo/shared";
import type { OneClickStatus } from "@zyo/shared";
import { keccak256 } from "../vendor/keccak.js";

/**
 * Client for the NEAR Intents 1-Click API. Every request carries a 15s
 * AbortSignal timeout — a hung solver socket must never wedge a reward tick.
 * Endpoints + schema verified against https://docs.near-intents.org (2026-08-05):
 *   GET  /v0/tokens
 *   POST /v0/quote            (Bearer JWT optional; omitting → 0.2% fee)
 *   POST /v0/deposit/submit
 *   GET  /v0/status?depositAddress=…
 */

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  /** Basis points, e.g. 100 = 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  /** Atomic units of the origin asset. */
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  /** ISO-8601. */
  deadline: string;
}

export interface QuoteResponse {
  quoteRequest: QuoteRequest;
  quote: {
    depositAddress: string;
    amountIn: string;
    amountInFormatted?: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutFormatted?: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    deadline?: string;
    timeEstimate?: number;
  };
  signature?: string;
  timestamp?: string;
}

export interface StatusResponse {
  status: OneClickStatus;
  quoteResponse?: QuoteResponse;
  swapDetails?: {
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
    amountOut?: string;
  };
}

export class OneClickError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "OneClickError";
  }
}

export interface OneClickClientOptions {
  baseUrl: string;
  jwt?: string;
  fetchImpl?: typeof fetch;
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly jwt?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OneClickClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.jwt = opts.jwt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

  async getTokens(): Promise<OneClickToken[]> {
    const res = await this.fetchImpl(`${this.baseUrl}${ONE_CLICK_ENDPOINTS.tokens}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new OneClickError(`tokens failed: ${res.status}`, res.status);
    return (await res.json()) as OneClickToken[];
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${ONE_CLICK_ENDPOINTS.quote}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new OneClickError(`quote failed: ${res.status} ${body}`, res.status);
    }
    return (await res.json()) as QuoteResponse;
  }

  async submitDepositTx(depositAddress: string, txHash: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}${ONE_CLICK_ENDPOINTS.depositSubmit}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ depositAddress, txHash }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new OneClickError(`deposit/submit failed: ${res.status}`, res.status);
  }

  async getStatus(depositAddress: string): Promise<StatusResponse> {
    const url = `${this.baseUrl}${ONE_CLICK_ENDPOINTS.status}?depositAddress=${encodeURIComponent(depositAddress)}`;
    const res = await this.fetchImpl(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new OneClickError(`status failed: ${res.status}`, res.status);
    return (await res.json()) as StatusResponse;
  }
}

/**
 * Deterministic hash binding an on-chain RewardsRouted event to the off-chain
 * quote that justified it. Emitted with routeToZcash for auditability.
 */
export function computeQuoteHash(q: QuoteResponse): `0x${string}` {
  const canonical = JSON.stringify({
    depositAddress: q.quote.depositAddress,
    amountIn: q.quote.amountIn,
    amountOut: q.quote.amountOut,
    recipient: q.quoteRequest.recipient,
    destinationAsset: q.quoteRequest.destinationAsset,
    deadline: q.quoteRequest.deadline,
  });
  return keccak256(canonical);
}
