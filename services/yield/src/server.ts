/**
 * The HTTP API. node:http only — no framework.
 *
 *   GET /healthz            → { ok, uptimeS, lastRefresh, creditsRemaining? }
 *   GET /v1/pools           → PoolsResponse (live samples + cohort bands + rates)
 *   GET /v1/rates           → RatesSample | 503 while never-sampled
 *   GET /v1/band?ltv=0.40&mix=aweth,acbbtc → user-net APY band for a mix
 *
 * Serving rules: every payload carries generatedAt + per-item sampledAt; a
 * refresh failure KEEPS serving the last good sample flagged stale:true
 * rather than 500ing (stale-while-revalidate); bands come from the cohort
 * store and are null with bandsUnavailableReason until a backfill has run.
 * CORS is open (GET-only, public data).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_POOLS } from "@zyo/shared";
import { mixUserBand, SUPPLY_APY_PCT } from "./bands.js";
import type { YieldConfig } from "./config.js";
import { GeckoSource } from "./sources/gecko.js";
import { RheaRates } from "./rhea.js";
import type {
  PoolBands,
  PoolLiveSample,
  PoolPayload,
  PoolsResponse,
  RatesSample,
} from "./types.js";

/** Demo-prototype pool ids ↔ curated registry ids (the demo abbreviates). */
export const DEMO_ID_MAP: Record<string, string> = {
  aweth: "aero-usdc-weth-5",
  acbbtc: "aero-cbbtc-usdc",
  uweth: "uni-weth-usdc-5",
  ubtc: "uni-cbbtc-weth-30",
  lst: "cbeth-weth",
  stab: "aero-usdt-usdc",
  aero: "aero-aero-weth",
  abtc: "aero-aero-cbbtc",
};

interface CacheEntry<T> {
  value: T | null;
  at: number; // ms epoch of last success
  error?: string;
}

export class YieldServer {
  private live = new Map<string, CacheEntry<PoolLiveSample>>();
  private rates: CacheEntry<RatesSample> = { value: null, at: 0 };
  private bands = new Map<string, PoolBands>(); // curatedId → bands
  private startedAt = Date.now();
  private lastRefresh = 0;
  private timer?: NodeJS.Timeout;
  private readonly gecko: GeckoSource;
  private readonly rhea: RheaRates;

  constructor(
    private readonly cfg: YieldConfig,
    deps?: { gecko?: GeckoSource; rhea?: RheaRates }
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

  async refresh(): Promise<void> {
    for (const pool of CURATED_POOLS) {
      if (!pool.poolAddress) continue;
      try {
        const sample = await this.gecko.liveSample(
          pool.id,
          pool.poolAddress as `0x${string}`,
          pool.feeTierBps
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
    }
    try {
      this.rates = { value: await this.rhea.sample(), at: Date.now() };
    } catch (e) {
      this.rates = { ...this.rates, error: (e as Error).message };
    }
    this.loadBandsFromDisk(); // pick up fresh backfills without restart
    this.lastRefresh = Date.now();
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
        bands,
        ...(bands ? {} : { bandsUnavailableReason: "backfill_pending" }),
      };
    });
    const stale =
      this.lastRefresh === 0 || now - this.lastRefresh > this.cfg.staleAfterMs;
    return {
      pools,
      rates: this.rates.value,
      generatedAt: new Date().toISOString(),
      stale,
      methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/YIELD-SERVICE.md",
    };
  }

  private bandPayload(url: URL): object | { error: string; status: number } {
    const ltv = Number(url.searchParams.get("ltv"));
    if (!(ltv > 0 && ltv <= 0.5)) return { error: "ltv must be in (0, 0.5]", status: 400 };
    const mixParam = url.searchParams.get("mix") ?? "";
    const ids = mixParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => DEMO_ID_MAP[id] ?? id);
    if (!ids.length) return { error: "mix required (comma-separated pool ids)", status: 400 };
    const missing = ids.filter((id) => !this.bands.has(id));
    const windows = this.cfg.cohortWindows;
    const borrow = this.rates.value?.borrowAprPct;
    if (borrow === undefined) return { error: "rates not yet sampled", status: 503 };
    const supply = this.rates.value?.zecSupplyAprPct ?? SUPPLY_APY_PCT;

    const perWindow = windows.map((w) => {
      const bandList = ids
        .map((id) => this.bands.get(id)?.bands.find((b) => b.windowDays === w))
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      return {
        windowDays: w,
        band: mixUserBand(bandList, ltv, borrow, supply),
        poolsWithData: bandList.filter((b) => b.n > 0).length,
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: object) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(json);
    };
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
          ? send(200, this.rates.value)
          : send(503, { error: "rates not yet sampled", detail: this.rates.error });
      case "/v1/band": {
        const body = this.bandPayload(url);
        const status = "status" in body ? (body as { status: number }).status : 200;
        return send(status, body);
      }
      default:
        return send(404, { error: "not found" });
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
