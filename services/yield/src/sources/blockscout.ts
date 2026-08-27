/**
 * Blockscout PRO API source (Base = chain id 8453).
 *
 * Two surfaces, one Bearer key (env BLOCKSCOUT_PRO_API_KEY — read at
 * runtime, NEVER logged or echoed):
 *   • JSON-RPC gateway  POST /8453/json-rpc — standard eth_* methods with
 *     the explorer's indexed infra behind them. We reuse RpcClient verbatim
 *     against this URL, so every read (logs, receipts, historical eth_call)
 *     has identical semantics whether it runs against a plain RPC or the
 *     PRO gateway.
 *   • REST v2 — explorer-enriched extras this service uses when available:
 *     verified-contract ABI (event-map self-check) and decoded per-tx
 *     token transfers (entry-principal reconstruction without raw-log
 *     parsing).
 *
 * Handling follows the PRO API contract: 401/403 JSON → key problem, stop
 * and surface (no retry); 402 → daily credits exhausted, stop; 429 →
 * exponential backoff; x-credits-remaining is tracked and exposed so batch
 * jobs can stop cleanly instead of failing mid-run.
 */

import { RpcClient } from "./rpc.js";
import type { Address, Hex } from "../types.js";

const BASE_URL = "https://api.blockscout.com";
const CHAIN_ID = 8453;

export class BlockscoutAuthError extends Error {
  constructor(status: number) {
    super(
      `Blockscout PRO API returned ${status} — the API key is missing, invalid, or revoked. ` +
        `Check BLOCKSCOUT_PRO_API_KEY (keys: https://dev.blockscout.com).`
    );
    this.name = "BlockscoutAuthError";
  }
}

export class BlockscoutCreditsError extends Error {
  constructor() {
    super("Blockscout PRO API daily credit allowance exhausted (HTTP 402). Stopping cleanly.");
    this.name = "BlockscoutCreditsError";
  }
}

export interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  /** Atomic amount as decimal string. */
  value: string;
}

export class BlockscoutSource {
  /** eth_* reads through the PRO gateway — same interface as a plain RPC. */
  readonly rpc: RpcClient;
  /** Last seen x-credits-remaining (null until the first REST call). */
  creditsRemaining: number | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.rpc = new RpcClient(`${BASE_URL}/${CHAIN_ID}/json-rpc`, {
      headers: { authorization: `Bearer ${apiKey}` },
      // The gateway bills per call; keep batches modest.
      batchSize: 10,
      fetchImpl,
    });
  }

  private async rest<T>(path: string): Promise<T> {
    let backoff = 1000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.fetchImpl(`${BASE_URL}/${CHAIN_ID}${path}`, {
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          "user-agent": "oilskin-yield/0.1",
        },
        signal: AbortSignal.timeout(30_000),
      });
      const credits = res.headers.get("x-credits-remaining");
      if (credits !== null) this.creditsRemaining = Number(credits);
      if (res.status === 401 || res.status === 403) throw new BlockscoutAuthError(res.status);
      if (res.status === 402) throw new BlockscoutCreditsError();
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }
      if (!res.ok) throw new Error(`blockscout http ${res.status} on ${path}`);
      return (await res.json()) as T;
    }
    throw new Error(`blockscout: still rate-limited after retries on ${path}`);
  }

  /**
   * Verified-contract ABI for the engine implementation — used by the
   * `verify-events` self-check to confirm our topic constants still match
   * the deployed code (e.g. after an engine upgrade).
   */
  async contractAbi(address: Address): Promise<unknown[]> {
    const j = await this.rest<{ abi?: unknown[]; is_verified?: boolean }>(
      `/api/v2/smart-contracts/${address}`
    );
    if (!j.is_verified || !j.abi) throw new Error(`${address}: not verified on Blockscout`);
    return j.abi;
  }

  /**
   * Decoded ERC-20 transfers of one transaction (entry-principal pass).
   * Paginated; loops until the cursor is exhausted.
   */
  async txTokenTransfers(txHash: Hex): Promise<TokenTransfer[]> {
    const out: TokenTransfer[] = [];
    let qs = "";
    for (;;) {
      const j = await this.rest<{
        items: {
          token: { address_hash?: string; address?: string };
          from: { hash: string };
          to: { hash: string };
          total: { value?: string };
        }[];
        next_page_params: Record<string, string | number> | null;
      }>(`/api/v2/transactions/${txHash}/token-transfers?type=ERC-20${qs}`);
      for (const it of j.items) {
        const token = (it.token.address_hash ?? it.token.address ?? "").toLowerCase();
        if (!token || it.total.value === undefined) continue;
        out.push({
          token: token as Address,
          from: it.from.hash.toLowerCase() as Address,
          to: it.to.hash.toLowerCase() as Address,
          value: it.total.value,
        });
      }
      if (!j.next_page_params) return out;
      qs =
        "&" +
        Object.entries(j.next_page_params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&");
    }
  }
}
