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

/** Errors that mean "range too large — split and retry smaller". */
const RANGE_HINTS = /range|10000|block range|too many|response size|limit/i;

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
    const req: RpcRequest = { jsonrpc: "2.0", id: ++this.id, method, params };
    const res = (await this.post(req)) as RpcResponse;
    if (res.error) throw new RpcError(`${method}: ${res.error.message}`, res.error.code);
    return res.result as T;
  }

  /** Batched calls, preserving order; falls back to sequential when batchSize=1. */
  async callMany<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    const out: T[] = new Array(calls.length);
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const slice = calls.slice(i, i + this.batchSize);
      if (slice.length === 1 || this.batchSize === 1) {
        for (let j = 0; j < slice.length; j++) {
          out[i + j] = await this.call<T>(slice[j].method, slice[j].params);
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
          out[i + j] = await this.call<T>(slice[j].method, slice[j].params);
        }
        continue;
      }
      const byId = new Map(res.map((r) => [r.id, r]));
      for (let j = 0; j < reqs.length; j++) {
        const r = byId.get(reqs[j].id);
        if (!r) throw new RpcError(`batch: missing response for ${slice[j].method}`);
        if (r.error) throw new RpcError(`${slice[j].method}: ${r.error.message}`, r.error.code);
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
      const res = await this.callMany<{ timestamp: string }>(
        missing.map((b) => ({
          method: "eth_getBlockByNumber",
          params: [`0x${b.toString(16)}`, false],
        }))
      );
      missing.forEach((b, i) => this.tsCache.set(b, Number(res[i].timestamp)));
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
      logs: { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[];
    } | null>("eth_getTransactionReceipt", [txHash]);
    if (!r) return null;
    return { logs: r.logs.map(normalizeLog) };
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
        { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[]
      >("eth_getLogs", [
        {
          address,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          ...(topics ? { topics } : {}),
        },
      ]);
      return raw.map(normalizeLog);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (fromBlock < toBlock && RANGE_HINTS.test(msg)) {
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
