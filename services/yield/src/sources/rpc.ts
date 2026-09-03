/**
 * Zero-dependency Base JSON-RPC client: batched calls, chunked+adaptive
 * eth_getLogs, block-timestamp cache, receipts, eth_call at a block tag.
 *
 * Provider-agnostic: works against any standard endpoint (public
 * mainnet.base.org, 1rpc.io/…, Alchemy, or the Blockscout PRO gateway —
 * sources/blockscout.ts wraps this class with Bearer auth).
 */

import type { Address, Hex, RawLog } from "../types.js";

export interface RpcOptions {
  headers?: Record<string, string>;
  /** Max entries per JSON-RPC batch array (1 = no batching). */
  batchSize?: number;
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Errors that mean "range too large — split and retry smaller". Deliberately
 * NARROW: generic words like "limit"/"too many" also appear in provider
 * rate-limit errors, and bisecting a throttled chunk down to single blocks
 * multiplies the billed calls that triggered the throttle in the first place.
 */
const RANGE_HINTS = /block range|exceeds|query returned more than|response size/i;

/** Rate limiting — RETRYABLE WITH BACKOFF, never bisected. */
const RATE_LIMIT_HINTS = /rate ?limit|too many requests/i;
/** JSON-RPC codes providers use for "slow down" (−32005 spec'd, −32097 seen in the wild). */
const RATE_LIMIT_CODES = new Set([-32005, -32097]);

export function isRateLimitError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = e instanceof RpcError ? e.code : undefined;
  return (code !== undefined && RATE_LIMIT_CODES.has(code)) || RATE_LIMIT_HINTS.test(e.message);
}

export class RpcClient {
  private id = 0;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly tsCache = new Map<number, number>();

  constructor(readonly url: string, opts: RpcOptions = {}) {
    this.headers = {
      "content-type": "application/json",
      "user-agent": "oilskin-yield/0.1",
      accept: "application/json",
      ...opts.headers,
    };
    this.batchSize = opts.batchSize ?? 20;
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(body: RpcRequest | RpcRequest[]): Promise<RpcResponse | RpcResponse[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new RpcError(`http ${res.status}`, res.status, true);
        }
        if (!res.ok) throw new RpcError(`http ${res.status}`, res.status, false);
        return (await res.json()) as RpcResponse | RpcResponse[];
      } catch (e) {
        lastErr = e;
        const retryable =
          e instanceof RpcError ? e.retryable : true; // network/timeout → retry
        if (!retryable || attempt === this.retries) throw e;
        await sleep(500 * 2 ** attempt + Math.floor(200 * ((this.id % 7) / 7)));
      }
    }
    throw lastErr;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const req: RpcRequest = { jsonrpc: "2.0", id: ++this.id, method, params };
      const res = (await this.post(req)) as RpcResponse;
      if (!res.error) return res.result as T;
      const err = new RpcError(`${method}: ${res.error.message}`, res.error.code);
      // JSON-RPC-level rate limits (some providers return HTTP 200 with a
      // -32005/"rate limit" error body) back off and retry; every other
      // JSON-RPC error (reverts, bad params, range hints) surfaces at once.
      if (isRateLimitError(err) && attempt < this.retries) {
        await sleep(500 * 2 ** attempt + Math.floor(200 * ((this.id % 7) / 7)));
        continue;
      }
      throw err;
    }
  }

  /** Batched calls, preserving order; falls back to sequential when batchSize=1. */
  async callMany<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    const out: T[] = new Array(calls.length);
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const slice = calls.slice(i, i + this.batchSize);
      if (slice.length === 1 || this.batchSize === 1) {
        for (let j = 0; j < slice.length; j++) {
          const c = slice[j]!;
          out[i + j] = await this.call<T>(c.method, c.params);
        }
        continue;
      }
      const reqs: RpcRequest[] = slice.map((c) => ({
        jsonrpc: "2.0",
        id: ++this.id,
        method: c.method,
        params: c.params,
      }));
      const res = (await this.post(reqs)) as RpcResponse[] | RpcResponse;
      if (!Array.isArray(res)) {
        // Endpoint refused the batch shape → degrade to sequential once.
        for (let j = 0; j < slice.length; j++) {
          const c = slice[j]!;
          out[i + j] = await this.call<T>(c.method, c.params);
        }
        continue;
      }
      // Coerce reply ids with Number(): some gateways echo ids as strings,
      // which would make every lookup miss and fail the whole batch.
      const byId = new Map(res.map((r) => [Number(r.id), r]));
      for (let j = 0; j < reqs.length; j++) {
        const req = reqs[j]!;
        const call = slice[j]!;
        const r = byId.get(req.id);
        if (!r) throw new RpcError(`batch: missing response for ${call.method}`);
        if (r.error) throw new RpcError(`${call.method}: ${r.error.message}`, r.error.code);
        out[i + j] = r.result as T;
      }
    }
    return out;
  }

  async blockNumber(): Promise<number> {
    return Number(await this.call<string>("eth_blockNumber", []));
  }

  async blockTimestamp(block: number): Promise<number> {
    const hit = this.tsCache.get(block);
    if (hit !== undefined) return hit;
    const b = await this.call<{ timestamp: string }>("eth_getBlockByNumber", [
      `0x${block.toString(16)}`,
      false,
    ]);
    const ts = Number(b.timestamp);
    this.tsCache.set(block, ts);
    return ts;
  }

  async blockTimestamps(blocks: number[]): Promise<Map<number, number>> {
    const missing = [...new Set(blocks)].filter((b) => !this.tsCache.has(b));
    if (missing.length) {
      const res = await this.callMany<{ timestamp: string } | null>(
        missing.map((b) => ({
          method: "eth_getBlockByNumber",
          params: [`0x${b.toString(16)}`, false],
        }))
      );
      missing.forEach((b, i) => {
        const block = res[i];
        // A null block (pruned/unknown) or a missing timestamp must fail
        // LOUD — NaN timestamps would silently poison every cohort window.
        if (!block || block.timestamp === undefined) {
          throw new RpcError(`eth_getBlockByNumber(${b}): endpoint returned no block/timestamp`);
        }
        this.tsCache.set(b, Number(block.timestamp));
      });
    }
    return new Map(blocks.map((b) => [b, this.tsCache.get(b)!]));
  }

  async ethCall(to: Address, data: string, block: number | "latest" = "latest"): Promise<string> {
    const tag = block === "latest" ? "latest" : `0x${block.toString(16)}`;
    const res = await this.call<string>("eth_call", [{ to, data }, tag]);
    return (res ?? "0x").replace(/^0x/, "");
  }

  async getReceipt(txHash: Hex): Promise<{ logs: RawLog[] } | null> {
    const r = await this.call<{
      logs: { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[] | null;
    } | null>("eth_getTransactionReceipt", [txHash]);
    if (!r) return null;
    return { logs: (r.logs ?? []).map(normalizeLog) };
  }

  /**
   * eth_getLogs over [from, to], transparently splitting the range when the
   * endpoint objects (each provider words its limits differently).
   */
  async getLogs(
    address: Address,
    fromBlock: number,
    toBlock: number,
    topics?: (Hex | Hex[] | null)[]
  ): Promise<RawLog[]> {
    try {
      const raw = await this.call<
        | { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[]
        | null
      >("eth_getLogs", [
        {
          address,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          ...(topics ? { topics } : {}),
        },
      ]);
      return (raw ?? []).map(normalizeLog);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // NEVER bisect on a rate limit: splitting a throttled chunk into
      // log₂(chunk) sub-requests multiplies the very load being throttled
      // (call() already backed off and retried before this throw).
      if (!isRateLimitError(e) && fromBlock < toBlock && RANGE_HINTS.test(msg)) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await this.getLogs(address, fromBlock, mid, topics);
        const right = await this.getLogs(address, mid + 1, toBlock, topics);
        return left.concat(right);
      }
      throw e;
    }
  }

  /** First block at which the address has code (bisect; for backfill start). */
  async contractCreationBlock(address: Address, latest: number): Promise<number> {
    const hasCode = async (b: number) =>
      (await this.call<string>("eth_getCode", [address, `0x${b.toString(16)}`])) !== "0x";
    if (!(await hasCode(latest))) throw new RpcError(`${address}: no code at head`);
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

function normalizeLog(l: {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}): RawLog {
  return {
    address: l.address.toLowerCase() as Address,
    topics: l.topics as Hex[],
    data: l.data as Hex,
    blockNumber: Number(l.blockNumber),
    transactionHash: l.transactionHash as Hex,
    logIndex: Number(l.logIndex),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
