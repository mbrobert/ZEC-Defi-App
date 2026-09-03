/**
 * The HTTP API. node:http only — no framework.
 *
 *   GET /healthz            → { ok, uptimeS, lastRefresh, creditsRemaining? }
 *   GET /v1/pools           → PoolsResponse (live samples + emissions + cohort bands + rates)
 *   GET /v1/rates           → RatesSample + { stale } | 503 while never-sampled
 *   GET /v1/band?ltv=0.40&mix=aweth,acbbtc → user-net APY band for a mix
 *
 * Serving rules: every payload carries generatedAt + per-item sampledAt; a
 * refresh failure KEEPS serving the last good sample flagged stale:true
 * rather than 500ing (stale-while-revalidate) — `stale` is computed from
 * PER-SOURCE sample ages, so dead upstreams actually flip it. Bands come
 * from the cohort store and are null with bandsUnavailableReason until a
 * backfill has run. CORS is open (GET-only, public data).
 *
 * Robustness: the request handler never throws to the server (a malformed
 * request-target like `GET //` is a 400, an internal bug is a 500
 * `{error:"internal"}` with no message leak); refresh() is re-entrancy
 * guarded, deadline-bounded, and samples pools with bounded concurrency.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_POOLS } from "@zyo/shared";
import { mixUserBand, SUPPLY_APY_PCT } from "./bands.js";
import type { YieldConfig } from "./config.js";
import { GeckoSource } from "./sources/gecko.js";
import { AERO_ADDRESS, GaugeSource, onchainToken1 } from "./sources/gauges.js";
import { BlockscoutSource } from "./sources/blockscout.js";
import { RpcClient } from "./sources/rpc.js";
import { RheaRates } from "./rhea.js";
import { MIN_COHORT_N } from "./types.js";
import type {
  Address,
  EmissionsSample,
  PoolBands,
  PoolLiveSample,
  PoolPayload,
  PoolsResponse,
  RatesSample,
} from "./types.js";

/** Demo-prototype pool ids ↔ curated registry ids (the demo abbreviates). */
export const DEMO_ID_MAP: Record<string, string> = {
  // v1 menu (2026-08-27): 8 Aerodrome pools, single-select in the simple app.
  aweth: "aero-usdc-weth-5",
  acbbtc: "aero-cbbtc-usdc",
  wbtc: "aero-weth-cbbtc",
  link: "aero-weth-link",
  lst: "cbeth-weth",
  stab: "aero-usdt-usdc",
  aero: "aero-aero-weth",
  abtc: "aero-aero-cbbtc",
};

/** Prototype-safe lookup view of DEMO_ID_MAP (no Object.prototype keys). */
const DEMO_ID_LOOKUP = new Map(Object.entries(DEMO_ID_MAP));
const CURATED_IDS = new Set(CURATED_POOLS.map((p) => p.id));

/** Most pool ids one /v1/band request may mix. */
const MAX_MIX_IDS = 16;

interface CacheEntry<T> {
  value: T | null;
  at: number; // ms epoch of last success
  error?: string;
}

/** Run `fn` over items with at most `limit` in flight; stop starting new work once `signal` aborts. */
async function runBounded<T>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length && !signal.aborted) {
      const item = items[idx++]!;
      await fn(item);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.race([
    Promise.all(workers).then(() => undefined),
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

export class YieldServer {
  private live = new Map<string, CacheEntry<PoolLiveSample>>();
  private emissions = new Map<string, CacheEntry<EmissionsSample>>();
  private rates: CacheEntry<RatesSample> = { value: null, at: 0 };
  private bands = new Map<string, PoolBands>(); // curatedId → bands
  private startedAt = Date.now();
  private lastRefresh = 0;
  private refreshing = false;
  private readonly refreshDeadlineMs: number;
  private timer?: NodeJS.Timeout;
  private readonly gecko: GeckoSource;
  private readonly rhea: RheaRates;
  private readonly gauges?: GaugeSource;

  constructor(
    private readonly cfg: YieldConfig,
    deps?: {
      gecko?: GeckoSource;
      rhea?: RheaRates;
      gauges?: GaugeSource;
      /** Whole-refresh time budget (default 90s); injectable for tests. */
      refreshDeadlineMs?: number;
    }
  ) {
    this.gecko = deps?.gecko ?? new GeckoSource();
    this.rhea =
      deps?.rhea ??
      new RheaRates(
        cfg.nearRpcUrl,
        cfg.rheaLendingContract,
        cfg.rheaUsdcTokenId,
        cfg.rheaZecTokenId
      );
    this.gauges =
      deps?.gauges ??
      (cfg.baseRpcUrl
        ? new GaugeSource(new RpcClient(cfg.baseRpcUrl))
        : cfg.blockscoutKey
          ? new GaugeSource(new BlockscoutSource(cfg.blockscoutKey).rpc)
          : undefined);
    this.refreshDeadlineMs = deps?.refreshDeadlineMs ?? 90_000;
    this.loadBandsFromDisk();
  }

  /** Bands are produced by the backfill CLI; the server just serves them. */
  loadBandsFromDisk(): void {
    const path = join(this.cfg.dataDir, "bands.json");
    if (!existsSync(path)) return;
    try {
      const arr = JSON.parse(readFileSync(path, "utf8")) as PoolBands[];
      this.bands = new Map(arr.map((b) => [b.poolId, b]));
    } catch (e) {
      console.error(`bands.json unreadable: ${(e as Error).message}`);
    }
  }

  /**
   * Refresh all live sources. Re-entrancy guarded (an overlapping timer fire
   * returns immediately instead of stacking loops), bounded by a whole-run
   * deadline, and pool sampling runs at most 3 requests at a time.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const deadline = AbortSignal.timeout(this.refreshDeadlineMs);

      const sampleable = CURATED_POOLS.filter((p) => p.poolAddress);
      await runBounded(sampleable, 3, deadline, async (pool) => {
        try {
          const sample = await this.gecko.liveSample(
            pool.id,
            pool.poolAddress as Address,
            pool.feeTierBps,
            deadline
          );
          this.live.set(pool.id, { value: sample, at: Date.now() });
        } catch (e) {
          const prev = this.live.get(pool.id);
          this.live.set(pool.id, {
            value: prev?.value ?? null,
            at: prev?.at ?? 0,
            error: (e as Error).message,
          });
        }
      });

      if (!deadline.aborted) {
        try {
          this.rates = { value: await this.rhea.sample(), at: Date.now() };
        } catch (e) {
          this.rates = { ...this.rates, error: (e as Error).message };
        }
      }

      await this.refreshEmissions(deadline);

      this.loadBandsFromDisk(); // pick up fresh backfills without restart
      this.lastRefresh = Date.now();
    } finally {
      this.refreshing = false;
    }
  }

  /** Gauge emissions per AERODROME pool — alongside the live fee sampling. */
  private async refreshEmissions(deadline: AbortSignal): Promise<void> {
    if (!this.gauges) return;
    const gauges = this.gauges;
    const aeroUsd = this.tokenUsdFromLiveSamples(AERO_ADDRESS);
    const aeroPools = CURATED_POOLS.filter((p) => p.dex === "AERODROME" && p.poolAddress);
    await runBounded(aeroPools, 3, deadline, async (pool) => {
      try {
        const live = this.live.get(pool.id)?.value;
        if (!live || !(live.tvlUsd > 0)) throw new Error("no live TVL sample to price against");
        const t1 = onchainToken1(pool.token0, pool.token1);
        if (!t1) throw new Error(`unknown token pair ${pool.token0}/${pool.token1}`);
        const token1Usd = priceForToken(live, t1.address);
        if (aeroUsd === undefined) throw new Error("no AERO/USD price in live samples");
        if (token1Usd === undefined) throw new Error("live sample carries no token1 price");
        const sample = await gauges.sample(pool.poolAddress as Address, {
          aeroUsd,
          poolTvlUsd: live.tvlUsd,
          token1Usd,
          token1Decimals: t1.decimals,
        });
        this.emissions.set(pool.id, { value: sample, at: Date.now() });
      } catch (e) {
        const prev = this.emissions.get(pool.id);
        this.emissions.set(pool.id, {
          value: prev?.value ?? null,
          at: prev?.at ?? 0,
          error: (e as Error).message,
        });
      }
    });
  }

  /** AERO (or any token) USD price from whichever live sample carries it. */
  private tokenUsdFromLiveSamples(token: Address): number | undefined {
    for (const entry of this.live.values()) {
      const s = entry.value;
      if (!s) continue;
      const px = priceForToken(s, token);
      if (px !== undefined) return px;
    }
    return undefined;
  }

  private poolsPayload(): PoolsResponse {
    const now = Date.now();
    const pools: PoolPayload[] = CURATED_POOLS.map((p) => {
      const live = this.live.get(p.id);
      const bands = this.bands.get(p.id) ?? null;
      return {
        id: p.id,
        name: `${p.token0}/${p.token1}`,
        venue: `${p.dex === "AERODROME" ? "Aerodrome" : "Uniswap"} ${(p.feeTierBps / 100).toFixed(2)}%`,
        riskTag: p.riskTag,
        live: live?.value ?? null,
        emissions: this.emissions.get(p.id)?.value ?? null,
        bands,
        ...(bands ? {} : { bandsUnavailableReason: "backfill_pending" }),
      };
    });
    // Per-SOURCE staleness: any sampleable pool whose last good live sample —
    // or the rates sample — is older than staleAfterMs flags the payload.
    // (A refresh in which every source failed used to reset a global
    // lastRefresh and hide exactly this.)
    const stale =
      CURATED_POOLS.filter((p) => p.poolAddress).some(
        (p) => now - (this.live.get(p.id)?.at ?? 0) > this.cfg.staleAfterMs
      ) || now - this.rates.at > this.cfg.staleAfterMs;
    return {
      pools,
      rates: this.rates.value,
      generatedAt: new Date().toISOString(),
      stale,
      methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/YIELD-SERVICE.md",
    };
  }

  private bandPayload(url: URL): Record<string, unknown> & { status?: number } {
    const ltv = Number(url.searchParams.get("ltv"));
    // Lower bound 0.01: an ltv like 1e-300 is either a typo or a probe, and
    // produces meaningless quasi-zero leverage math.
    if (!(ltv >= 0.01 && ltv <= 0.5)) {
      return { error: "ltv must be in [0.01, 0.5]", status: 400 };
    }
    const mixParam = url.searchParams.get("mix") ?? "";
    // Dedupe (a repeated id would double-weight its pool in the mix) and map
    // demo ids through a Map — Object-literal lookups resolve prototype keys
    // like "__proto__"/"constructor" to garbage.
    const ids = [
      ...new Set(
        mixParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((id) => DEMO_ID_LOOKUP.get(id) ?? id)
      ),
    ];
    if (!ids.length) return { error: "mix required (comma-separated pool ids)", status: 400 };
    if (ids.length > MAX_MIX_IDS) {
      return { error: `too many pool ids (${ids.length} > ${MAX_MIX_IDS})`, status: 400 };
    }
    const unknown = ids.filter((id) => !CURATED_IDS.has(id));
    if (unknown.length) {
      return { error: "unknown pool ids", unknown, status: 400 };
    }
    const missing = ids.filter((id) => !this.bands.has(id));
    const windows = this.cfg.cohortWindows;
    const borrow = this.rates.value?.borrowAprPct;
    if (borrow === undefined) return { error: "rates not yet sampled", status: 503 };
    const supply = this.rates.value?.zecSupplyAprPct ?? SUPPLY_APY_PCT;

    const perWindow = windows.map((w) => {
      const bandList = ids
        .map((id) => this.bands.get(id)?.bands.find((b) => b.windowDays === w))
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      const band = mixUserBand(bandList, ltv, borrow, supply);
      const insufficient =
        band === null && bandList.some((b) => b.reason === "insufficient_sample");
      return {
        windowDays: w,
        band,
        poolsWithData: bandList.filter((b) => b.n >= MIN_COHORT_N && b.p50 !== null).length,
        ...(insufficient ? { reason: "insufficient_sample" as const } : {}),
      };
    });
    return {
      ltv,
      mix: ids,
      missingBands: missing,
      borrowAprPct: borrow,
      supplyApyPct: supply,
      mixAveraging: "percentile-mean-v1",
      windows: perWindow,
      generatedAt: new Date().toISOString(),
    };
  }

  handler = (req: IncomingMessage, res: ServerResponse): void => {
    const send = (status: number, body: object) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(json);
    };

    // Node's HTTP parser admits request-targets (`//`, `/\`, `//?x`) that the
    // WHATWG URL parser rejects; an uncaught throw here killed the process.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(400, { error: "bad request" });
    }

    try {
      if (req.method !== "GET") return send(405, { error: "GET only" });

      switch (url.pathname) {
        case "/healthz":
          return send(200, {
            ok: true,
            uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
            lastRefresh: this.lastRefresh ? new Date(this.lastRefresh).toISOString() : null,
          });
        case "/v1/pools":
          return send(200, this.poolsPayload());
        case "/v1/rates":
          return this.rates.value
            ? send(200, {
                ...this.rates.value,
                stale: Date.now() - this.rates.at > this.cfg.staleAfterMs,
              })
            : // Fixed reason enum — never raw upstream error text (provider
              // HTML/JSON snippets leak infrastructure details).
              send(503, { error: "rates_unavailable", reason: "upstream_unavailable" });
        case "/v1/band": {
          const body = this.bandPayload(url);
          const status = "status" in body && typeof body.status === "number" ? body.status : 200;
          return send(status, body);
        }
        default:
          return send(404, { error: "not found" });
      }
    } catch (e) {
      // Never leak internal error text; never let the throw escape to the
      // 'request' event (that is an uncaught exception → process exit).
      console.error(`handler ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) return send(500, { error: "internal" });
      res.destroy();
    }
  };

  async start(): Promise<import("node:http").Server> {
    await this.refresh().catch((e) => console.error(`initial refresh: ${(e as Error).message}`));
    this.timer = setInterval(() => {
      void this.refresh().catch((e) => console.error(`refresh: ${(e as Error).message}`));
    }, this.cfg.refreshMs);
    this.timer.unref();
    const server = createServer(this.handler);
    await new Promise<void>((resolve) => server.listen(this.cfg.port, resolve));
    return server;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Price of `token` (lowercase address) inside a live sample, if it carries it. */
function priceForToken(s: PoolLiveSample, token: Address): number | undefined {
  const t = token.toLowerCase();
  if (s.baseTokenAddress?.toLowerCase() === t && s.baseTokenPriceUsd !== undefined) {
    return Number.isFinite(s.baseTokenPriceUsd) ? s.baseTokenPriceUsd : undefined;
  }
  if (s.quoteTokenAddress?.toLowerCase() === t && s.quoteTokenPriceUsd !== undefined) {
    return Number.isFinite(s.quoteTokenPriceUsd) ? s.quoteTokenPriceUsd : undefined;
  }
  return undefined;
}
