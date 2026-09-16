/**
 * The HTTP API. node:http only — no framework.
 *
 *   GET /healthz   → { ok, uptimeS, lastRefresh, sources: {…} }
 *   GET /v1/pools  → PoolsResponse: live samples + gauge emissions + gate
 *                    verdicts (every setting × enabled collateral) + cohort
 *                    bands + Aave rates
 *   GET /v1/rates  → AaveRatesSample + { stale } | 503 while never-sampled
 *   GET /v1/gate   → the gate alone: every pool × setting × collateral, or
 *                    filtered by ?pool=&setting=&collateral=. 503 (fail
 *                    closed) whenever the rates are absent or stale — a
 *                    verdict cannot be computed on inputs the gate would
 *                    refuse anyway.
 *   GET /v1/band?ltv=0.40&mix=aweth,acbbtc&collateral=cbBTC
 *                  → empirical user-net band for a mix at an LTV
 *   GET /v1/forecast?collateral=cbBTC&entryHf=1.55&deposit=10000[&pool=&setting=]
 *                  → the forecast (src/forecast.ts): every pool × setting at the
 *                    chosen entry HF — both LP-net forms and their gap, the
 *                    break-evens, liquidation price and drawdown, the borrow
 *                    rate AFTER this borrow on the venue's curve, user net, the
 *                    safety refusals and the disclosure ids. Never 503: missing
 *                    or stale inputs are reported inside each cell (BUILD-PLAN
 *                    2026-09-12 D4/D5, step A3). 400 on a malformed query.
 *
 * STALENESS CONTRACT (audit Lens F, round 3): every sample is stored with
 * its `sampledAt` only. `stale` is DERIVED at serve time from the sample's
 * age against staleAfterMs — for the rates, for each pool's emissions, and
 * for the payload as a whole. There is no code path that stores `stale`,
 * so a source that dies keeps flipping the flag as time passes. The gate
 * consumes the same serve-time flags and refuses stale inputs.
 *
 * Robustness: the request handler never throws to the server (a malformed
 * request-target like `GET //` is a 400, an internal bug is a 500
 * `{error:"internal"}` with no message leak); refresh() is re-entrancy
 * guarded, deadline-bounded, and samples pools with bounded concurrency.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COLLATERAL_ASSETS,
  COLLATERAL_SYMBOLS,
  CURATED_POOLS,
  ENTRY_HF_FLOOR,
  isCollateralSymbol,
  kaminoCurveAprBps,
  ZEC_EXIT_FACTS_DOC,
  ZEC_EXIT_OPEN_QUESTIONS,
  zecExitReadiness,
  zecExitRefusal,
  type CollateralSymbol,
  type CuratedPool,
} from "@zyo/shared";
import { mixUserBand } from "./bands.js";
import { loadVolatility, type VolatilityInputs, type YieldConfig } from "./config.js";
import { evaluateForecastPool, MAX_ENTRY_HF, MIN_ENTRY_HF, type ForecastVenueBorrow } from "./forecast.js";
import { evaluatePool, evaluateGate } from "./gate.js";
import { calibrationIndex, loadMcCalibration, type McCalibration, type McCalibrationCell } from "./mc-calibration.js";
import { ENGINE_FEE_BPS, SETTINGS, type Setting } from "./model.js";
import { AaveSource } from "./sources/aave.js";
import { RegistrySource, type EntryHfFloorSample } from "./sources/registry.js";
import { BlockscoutSource } from "./sources/blockscout.js";
import { GeckoSource } from "./sources/gecko.js";
import { AERO_ADDRESS, GaugeSource, onchainToken1 } from "./sources/gauges.js";
import { RpcClient } from "./sources/rpc.js";
import { KaminoSource, type KaminoSample } from "./sources/kamino.js";
import { evaluateSolanaBorrow, type SolanaBorrowView } from "./solanaBorrow.js";
import type { AaveRatesSample, Address, EmissionsSample, ForecastCell, ForecastRefusal, ForecastResponse, GateVerdict, PoolBands, PoolLiveSample, PoolPayload, PoolsResponse } from "./types.js";

/** Demo-prototype pool ids ↔ curated registry ids (the demo abbreviates). */
export const DEMO_ID_MAP: Record<string, string> = {
  aweth: "aero-usdc-weth-5",
  acbbtc: "aero-cbbtc-usdc",
  wbtc: "aero-weth-cbbtc",
  link: "aero-weth-link",
  lst: "cbeth-weth",
  stab: "aero-usdt-usdc",
  aero: "aero-aero-weth",
  abtc: "aero-aero-cbbtc",
  zec: "aero-cbzec-usdc",
};

/** Prototype-safe lookup view of DEMO_ID_MAP (no Object.prototype keys). */
const DEMO_ID_LOOKUP = new Map(Object.entries(DEMO_ID_MAP));
const CURATED_IDS = new Set(CURATED_POOLS.map((p) => p.id));

/** Most pool ids one /v1/band request may mix. */
const MAX_MIX_IDS = 16;

export const VOLATILITY_FILE = "volatility.json";
/** The Monte-Carlo calibration of the closed form (scripts/lp-sim.py --calibration). */
export const MC_CALIBRATION_FILE = "mc-calibration.json";

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

/**
 * Does `docs/VERIFIED-ZEC-ROUTES-<date>.md` exist yet? Step Z1's output, and Door 1's precondition
 * (`ZEC_EXIT_FACTS_DOC` in `@zyo/shared` names it, so the service and the web agree on the name).
 *
 * A missing `docs/` is treated as absent rather than thrown: the service must run from a container
 * that carries only `dist/`, and "I cannot see the document" and "the document is not there" both
 * mean the door stays shut. Failing closed on an unreadable precondition is the only safe direction.
 */
export function zecRouteFactsPresent(docsDir = new URL(new URL(".", import.meta.url).pathname.endsWith("/dist/src/") ? "../../../../docs" : "../../../docs", import.meta.url).pathname): boolean {
  try {
    if (!existsSync(docsDir)) return false;
    const want = ZEC_EXIT_FACTS_DOC.replace(/^docs\//, "");
    return readdirSync(docsDir).some((f) => f.startsWith(want) && f.endsWith(".md"));
  } catch {
    return false;
  }
}

export class YieldServer {
  private live = new Map<string, CacheEntry<PoolLiveSample>>();
  private emissions = new Map<string, CacheEntry<EmissionsSample>>();
  private rates: CacheEntry<AaveRatesSample> = { value: null, at: 0 };
  private bands = new Map<string, PoolBands>(); // curatedId → bands
  private volatility: VolatilityInputs;
  private mcCalibration: McCalibration | null;
  private mcIndex: Map<string, McCalibrationCell>;
  private startedAt: number;
  private lastRefresh = 0;
  private refreshing = false;
  private readonly refreshDeadlineMs: number;
  private timer?: NodeJS.Timeout;
  private readonly gecko: GeckoSource;
  private readonly aave?: AaveSource;
  private readonly gauges?: GaugeSource;
  /** The registry's entry floor, read with the rates (A4.4); absent = no registry configured. */
  private readonly registry?: RegistrySource;
  private floor: CacheEntry<EntryHfFloorSample> = { value: null, at: 0 };
  /** Kamino's ZCASH market (SOLANA_RPC_URL); absent = the Solana route says so. */
  private readonly kamino?: KaminoSource;
  private kaminoEntry: CacheEntry<KaminoSample> = { value: null, at: 0 };
  private readonly now: () => number;

  constructor(
    private readonly cfg: YieldConfig,
    deps?: {
      gecko?: GeckoSource;
      aave?: AaveSource;
      gauges?: GaugeSource;
      /** The registry floor source; null = none (tests), undefined = build one from the config when it names a registry. */
      registry?: RegistrySource | null;
      /** The Kamino source; null = none (tests), undefined = build one when the config names a Solana RPC. */
      kamino?: KaminoSource | null;
      volatility?: VolatilityInputs;
      /** MC calibration of the closed form; null = every cell refuses (fail closed). */
      mcCalibration?: McCalibration | null;
      /** Whole-refresh time budget (default 90s); injectable for tests. */
      refreshDeadlineMs?: number;
      /** Injectable clock — staleness tests freeze and advance it. */
      now?: () => number;
    }
  ) {
    this.now = deps?.now ?? (() => Date.now());
    this.gecko = deps?.gecko ?? new GeckoSource();
    const rpc = cfg.baseRpcUrl
      ? new RpcClient(cfg.baseRpcUrl)
      : cfg.blockscoutKey
        ? new BlockscoutSource(cfg.blockscoutKey).rpc
        : undefined;
    this.aave = deps?.aave ?? (rpc ? new AaveSource(rpc, this.now) : undefined);
    this.gauges = deps?.gauges ?? (rpc ? new GaugeSource(rpc) : undefined);
    this.registry =
      deps?.registry === undefined
        ? rpc && cfg.collateralRegistry
          ? new RegistrySource(rpc, cfg.collateralRegistry as Address, this.now)
          : undefined
        : (deps.registry ?? undefined);
    this.kamino = deps?.kamino === undefined ? (cfg.solanaRpcUrl ? new KaminoSource(cfg.solanaRpcUrl, this.now) : undefined) : (deps.kamino ?? undefined);
    this.volatility = deps?.volatility ?? loadVolatility(join(cfg.samplesDir, VOLATILITY_FILE));
    this.mcCalibration =
      deps?.mcCalibration !== undefined
        ? deps.mcCalibration
        : loadMcCalibration(join(cfg.samplesDir, MC_CALIBRATION_FILE));
    if (!this.mcCalibration) {
      // Loud, not silent: with no calibration the boundary guard has nothing
      // to check against and every cell refuses with mc_calibration_unavailable.
      console.error(`${MC_CALIBRATION_FILE} not found in ${cfg.samplesDir}: the gate will offer nothing`);
    }
    this.mcIndex = calibrationIndex(this.mcCalibration);
    this.startedAt = this.now();
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
   * deadline, and pool sampling runs at most 3 requests at a time. A source
   * that fails keeps its previous value (and its previous `at`, so the
   * served `stale` flag keeps aging).
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
          this.live.set(pool.id, { value: sample, at: this.now() });
        } catch (e) {
          const prev = this.live.get(pool.id);
          this.live.set(pool.id, { value: prev?.value ?? null, at: prev?.at ?? 0, error: (e as Error).message });
        }
      });

      if (!deadline.aborted && this.aave) {
        try {
          this.rates = { value: await this.aave.sample(), at: this.now() };
        } catch (e) {
          this.rates = { ...this.rates, error: (e as Error).message };
        }
      }

      // The registry's entry floor rides the same cadence as the rates (A4.4): a failed read keeps the
      // last good one (stale past staleAfterMs, when the shared constant is served and said).
      if (!deadline.aborted && this.registry) {
        try {
          this.floor = { value: await this.registry.entryHfFloor(), at: this.now() };
        } catch (e) {
          this.floor = { ...this.floor, error: (e as Error).message };
        }
      }

      // Kamino rides the same cadence; a failed read keeps the last good sample (stale past staleAfterMs).
      if (!deadline.aborted && this.kamino) {
        try {
          this.kaminoEntry = { value: await this.kamino.sample(), at: this.now() };
        } catch (e) {
          this.kaminoEntry = { ...this.kaminoEntry, error: (e as Error).message };
        }
      }

      await this.refreshEmissions(deadline);

      this.loadBandsFromDisk(); // pick up fresh backfills without restart
      this.lastRefresh = this.now();
    } finally {
      this.refreshing = false;
    }
  }

  /** Gauge emissions per AERODROME pool (engine + DIRECT, incl. cbZEC/USDC). */
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
        const sample = await gauges.sample(
          pool.id,
          pool.poolAddress as Address,
          { aeroUsd, poolTvlUsd: live.tvlUsd, token1Usd, token1Decimals: t1.decimals, nowSeconds: Math.floor(this.now() / 1000) },
          pool.gauge as Address | undefined
        );
        this.emissions.set(pool.id, { value: sample, at: this.now() });
      } catch (e) {
        const prev = this.emissions.get(pool.id);
        this.emissions.set(pool.id, { value: prev?.value ?? null, at: prev?.at ?? 0, error: (e as Error).message });
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

  // ---- serve-time staleness -------------------------------------------------

  private isStale(entry: CacheEntry<unknown>): boolean {
    return entry.value === null || this.now() - entry.at > this.cfg.staleAfterMs;
  }

  private ratesForServe(): (AaveRatesSample & { stale: boolean }) | null {
    return this.rates.value ? { ...this.rates.value, stale: this.isStale(this.rates) } : null;
  }

  /**
   * The floor `/v1/forecast` judges `entry_hf_below_floor` against: the registry's, when a read is
   * fresh; the STRICTER of the last good read and the shared deploy default when the read is stale
   * ("registry_stale" — a floor the chain may have raised since must not be lowered by going stale);
   * the shared constant with no read at all. The last read time is carried so a stale read is visible.
   */
  private entryHfFloorForServe(): { floor: number; source: "registry" | "registry_stale" | "shared"; readAt: string | null } {
    const v = this.floor.value;
    if (v && !this.isStale(this.floor)) return { floor: v.floor, source: "registry", readAt: v.sampledAt };
    // Stale: the chain may have RAISED the floor since, never assume it lowered it — serve the stricter
    // of the last good read and the shared deploy default, and say the read is stale.
    if (v) return { floor: Math.max(v.floor, ENTRY_HF_FLOOR), source: "registry_stale", readAt: v.sampledAt };
    return { floor: ENTRY_HF_FLOOR, source: "shared", readAt: null };
  }

  private emissionsForServe(poolId: string): (EmissionsSample & { stale: boolean }) | null {
    const e = this.emissions.get(poolId);
    if (!e?.value) return null;
    const nowS = Math.floor(this.now() / 1000);
    return {
      ...e.value,
      // Re-derived at serve time: a lapsed epoch can never keep serving as active.
      epochActive: e.value.epochActive && e.value.periodFinish > nowS && BigInt(e.value.rewardRateWeiPerSec) > 0n,
      stale: this.isStale(e),
    };
  }

  private gateFor(pool: CuratedPool, collaterals: readonly CollateralSymbol[] = COLLATERAL_SYMBOLS): GateVerdict[] {
    return evaluatePool(pool, collaterals, {
      rates: this.ratesForServe(),
      emissions: this.emissionsForServe(pool.id),
      volatility: this.volatility,
      mcCalibration: this.mcIndex,
      nowSeconds: Math.floor(this.now() / 1000),
    });
  }

  private liveForServe(poolId: string): (PoolLiveSample & { stale: boolean }) | null {
    const e = this.live.get(poolId);
    return e?.value ? { ...e.value, stale: this.isStale(e) } : null;
  }

  private poolsPayload(): PoolsResponse {
    const pools: PoolPayload[] = CURATED_POOLS.map((p) => {
      const bands = this.bands.get(p.id) ?? null;
      return {
        id: p.id,
        name: `${p.token0}/${p.token1}`,
        venue: `${p.dex === "AERODROME" ? "Aerodrome" : "Uniswap"} ${(p.feeTierBps / 100).toFixed(2)}%`,
        riskTag: p.riskTag,
        protocol: p.protocol,
        pairClass: p.pairClass,
        ...(p.note ? { note: p.note } : {}),
        live: this.liveForServe(p.id),
        emissions: this.emissionsForServe(p.id),
        gate: p.dex === "AERODROME" ? this.gateFor(p) : [],
        bands,
        ...(bands ? {} : { bandsUnavailableReason: "backfill_pending" }),
      };
    });
    // Per-SOURCE staleness: any sampleable pool whose last good live sample,
    // ANY pool's gauge emissions, or the rates sample is older than
    // staleAfterMs flags the payload. Emissions used to be excluded, so the
    // headline flag read `false` with every gauge hours dead while the
    // per-pool `emissions.stale` said otherwise (wave-1 lens D MED-5) — a
    // consumer trusting the headline rendered stale emissions as live.
    const stale =
      CURATED_POOLS.filter((p) => p.poolAddress).some((p) => this.isStale(this.live.get(p.id) ?? { value: null, at: 0 })) ||
      CURATED_POOLS.filter((p) => p.dex === "AERODROME" && p.poolAddress).some((p) =>
        this.isStale(this.emissions.get(p.id) ?? { value: null, at: 0 })
      ) ||
      this.isStale(this.rates);
    return {
      pools,
      rates: this.ratesForServe(),
      generatedAt: new Date(this.now()).toISOString(),
      stale,
      methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/YIELD-SERVICE.md",
    };
  }

  private gatePayload(url: URL): Record<string, unknown> & { status?: number } {
    const rates = this.ratesForServe();
    // Fail closed: no verdict is computable without fresh rates.
    if (!rates) return { error: "gate_unavailable", reason: "rates_unavailable", status: 503 };
    if (rates.stale) return { error: "gate_unavailable", reason: "rates_stale", status: 503 };

    const poolParam = url.searchParams.get("pool");
    const settingParam = url.searchParams.get("setting");
    const collateralParam = url.searchParams.get("collateral");
    const poolId = poolParam ? (DEMO_ID_LOOKUP.get(poolParam) ?? poolParam) : null;
    if (poolId !== null && !CURATED_IDS.has(poolId)) return { error: "unknown pool id", status: 400 };
    let settings: readonly Setting[] = SETTINGS;
    if (settingParam !== null) {
      const s = SETTINGS.find((x) => x.id === settingParam || x.preset === settingParam);
      if (!s) return { error: "unknown setting", status: 400 };
      settings = [s];
    }
    let collaterals: readonly CollateralSymbol[] = COLLATERAL_SYMBOLS;
    if (collateralParam !== null) {
      if (!isCollateralSymbol(collateralParam)) return { error: "unknown collateral", status: 400 };
      collaterals = [collateralParam];
    }
    const pools = CURATED_POOLS.filter((p) => p.dex === "AERODROME" && (poolId === null || p.id === poolId));
    const nowSeconds = Math.floor(this.now() / 1000);
    const verdicts: GateVerdict[] = [];
    for (const pool of pools) {
      for (const setting of settings) {
        for (const collateral of collaterals) {
          verdicts.push(
            evaluateGate({
              pool,
              setting,
              collateral,
              rates,
              emissions: this.emissionsForServe(pool.id),
              volatility: this.volatility,
              mcCalibration: this.mcIndex,
              nowSeconds,
            })
          );
        }
      }
    }
    // Fields web/lib/gate.ts has always read and the live payload never sent
    // (wave-1 lens D MED-6): without `stale` the client's staleness guard —
    // and the `&& !stale` term in its own qualifies re-derivation — was dead
    // code in live mode, and emissions staleness is the ONE kind /v1/gate
    // does not 503 on. `emissionsSampledAt` is the OLDEST sample actually
    // consumed by the verdicts above, so it cannot read fresher than the
    // worst input behind them.
    const consumed = [...new Set(pools.map((p) => p.id))]
      .map((id) => this.emissionsForServe(id))
      .filter((e): e is EmissionsSample & { stale: boolean } => e !== null);
    const emissionsStale = consumed.some((e) => e.stale);
    const emissionsSampledAt = consumed.length
      ? consumed.map((e) => e.sampledAt).sort()[0]!
      : null;
    return {
      borrowAprPct: rates.borrow.variableBorrowAprPct,
      ratesSampledAt: rates.sampledAt,
      emissionsSampledAt,
      volatilityAsOf: this.volatility.asOf,
      engineFeeBps: ENGINE_FEE_BPS,
      stale: rates.stale || emissionsStale,
      mcCalibrationGeneratedAt: this.mcCalibration?.generatedAt ?? null,
      settings: settings.map((s) => ({ id: s.id, preset: s.preset, rebalanceDelayHours: s.rebalanceDelayHours })),
      verdicts,
      qualifying: verdicts.filter((v) => v.qualifies).map((v) => ({ poolId: v.poolId, setting: v.setting, collateral: v.collateral })),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * The forecast: the same inputs as the gate, evaluated by src/forecast.ts at the entry HF the
   * user chose. Fails open on the numbers and closed on safety: missing or stale rates become a
   * refusal INSIDE each cell (the site must show why nothing may be opened), never a 503 that
   * hides the picture. Malformed query → 400.
   */
  private forecastPayload(url: URL): (ForecastResponse & { status?: number }) | (Record<string, unknown> & { status: number }) {
    const q = url.searchParams;
    const entryHfParam = q.get("entryHf");
    const floor = this.entryHfFloorForServe();
    const entryHf = entryHfParam === null ? floor.floor : Number(entryHfParam);
    if (!(Number.isFinite(entryHf) && entryHf >= MIN_ENTRY_HF && entryHf <= MAX_ENTRY_HF)) {
      return { error: `entryHf must be a number in [${MIN_ENTRY_HF}, ${MAX_ENTRY_HF}]`, status: 400 };
    }
    const depositParam = q.get("deposit");
    const depositUsd = depositParam === null ? null : Number(depositParam);
    if (depositUsd !== null && !(Number.isFinite(depositUsd) && depositUsd > 0 && depositUsd <= 1e12)) {
      return { error: "deposit must be a positive USD amount", status: 400 };
    }
    const poolParam = q.get("pool");
    const settingParam = q.get("setting");
    const collateralParam = q.get("collateral");
    const poolId = poolParam ? (DEMO_ID_LOOKUP.get(poolParam) ?? poolParam) : null;
    if (poolId !== null && !CURATED_IDS.has(poolId)) return { error: "unknown pool id", status: 400 };
    let settings: readonly Setting[] = SETTINGS;
    if (settingParam !== null) {
      const st = SETTINGS.find((x) => x.id === settingParam || x.preset === settingParam);
      if (!st) return { error: "unknown setting", status: 400 };
      settings = [st];
    }
    let collaterals: readonly CollateralSymbol[] = COLLATERAL_SYMBOLS;
    if (collateralParam !== null) {
      if (!isCollateralSymbol(collateralParam)) return { error: "unknown collateral", status: 400 };
      collaterals = [collateralParam];
    }
    const rates = this.ratesForServe();
    // ?crossChain=1 — the loop of BUILD-PLAN D6: the USDC is borrowed on Kamino and worked on Base.
    const crossChainParam = q.get("crossChain");
    if (crossChainParam !== null && !["1", "true", "0", "false"].includes(crossChainParam)) {
      return { error: "crossChain must be 1 or 0", status: 400 };
    }
    const crossChain = crossChainParam === "1" || crossChainParam === "true";
    const venueRead = crossChain ? this.venueBorrowForServe() : { venue: null, reason: null };
    if (crossChain && !venueRead.venue) {
      return { error: `a cross-chain forecast needs Kamino's pool: ${venueRead.reason}`, status: 503 };
    }
    const pools = CURATED_POOLS.filter((p) => p.dex === "AERODROME" && (poolId === null || p.id === poolId));
    const nowSeconds = Math.floor(this.now() / 1000);
    const priceOf = (c: CollateralSymbol): number | null =>
      this.tokenUsdFromLiveSamples(COLLATERAL_ASSETS[c].address.toLowerCase() as Address) ?? null;
    const cells: ForecastCell[] = [];
    for (const pool of pools) {
      const emissions = this.emissionsForServe(pool.id);
      for (const setting of settings) {
        if (!settings.includes(setting)) continue;
        for (const collateral of collaterals) {
          cells.push(
            ...evaluateForecastPool(pool, [collateral], {
              rates,
              emissions,
              volatility: this.volatility,
              mcCalibration: this.mcIndex,
              nowSeconds,
              entryHf,
              entryHfFloor: floor.floor,
              depositUsd,
              collateralPriceUsd: priceOf(collateral),
              venueBorrow: venueRead.venue,
            }).filter((c) => c.setting === setting.id)
          );
        }
      }
    }
    const consumed = [...new Set(pools.map((p) => p.id))]
      .map((id) => this.emissionsForServe(id))
      .filter((e): e is EmissionsSample & { stale: boolean } => e !== null);
    const emissionsStale = consumed.some((e) => e.stale);
    const emissionsSampledAt = consumed.length ? consumed.map((e) => e.sampledAt).sort()[0]! : null;
    return {
      entryHf,
      entryHfFloor: floor.floor,
      entryHfFloorSource: floor.source,
      entryHfFloorReadAt: floor.readAt,
      depositUsd,
      borrowAprPct: rates && !rates.stale ? rates.borrow.variableBorrowAprPct : null,
      ratesSampledAt: rates?.sampledAt ?? null,
      emissionsSampledAt,
      volatilityAsOf: this.volatility.asOf,
      engineFeeBps: ENGINE_FEE_BPS,
      stale: !rates || rates.stale || emissionsStale,
      mcCalibrationGeneratedAt: this.mcCalibration?.generatedAt ?? null,
      settings: settings.map((st) => ({ id: st.id, preset: st.preset, rebalanceDelayHours: st.rebalanceDelayHours })),
      cells,
      generatedAt: new Date(this.now()).toISOString(),
      methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/YIELD-SERVICE.md",
    };
  }

  private kaminoForServe(): (KaminoSample & { stale: boolean }) | null {
    const v = this.kaminoEntry.value;
    return v ? { ...v, stale: this.isStale(this.kaminoEntry) } : null;
  }

  /**
   * Kamino's borrow side as the forecast consumes it for a CROSS-CHAIN position (BUILD-PLAN D6;
   * `CROSSCHAIN-LOOP-2026-09-12.md` §6 item 1). The loan lives on Kamino, so its rate, the collateral
   * parameters that size it and whether the pool can fund it are Kamino's — a Base LP cell priced against
   * Base's borrow rate would be telling the user the cost of a loan they are not taking.
   *
   * The venue's own refusals are mapped onto the forecast's vocabulary, which already carries these meanings:
   * a paused market or a disabled borrow is `borrow_paused`; an inactive reserve is `collateral_not_active`;
   * a stale or out-of-band oracle is `rates_stale`; no sample at all is `rates_unavailable`. Amount-dependent
   * refusals are NOT mapped here — the forecast computes them per cell, because every cell borrows a different
   * amount (`venueBorrowAprAfterPct`).
   */
  private venueBorrowForServe(): { venue: ForecastVenueBorrow | null; reason: string | null } {
    if (this.kamino === undefined) return { venue: null, reason: "no Solana RPC is configured, so Kamino cannot be read" };
    const sample = this.kaminoForServe();
    if (!sample) return { venue: null, reason: "Kamino has not been read yet" };
    const { zec, usdc, market, scopeZec, scopeUsdc } = sample;
    const refusals: ForecastRefusal[] = [];
    if (market.emergencyMode || market.borrowDisabled) refusals.push("borrow_paused");
    if (zec.status !== 0 || usdc.status !== 0) refusals.push("collateral_not_active");
    const oracleAgeS = sample.chainTimeS - Number(scopeZec.unixTimestamp);
    if (oracleAgeS > zec.maxAgePriceSeconds || oracleAgeS < -300) refusals.push("rates_stale");
    const zecUsd = scopeZec.priceUsd;
    const usdcUsd = scopeUsdc.priceUsd;
    if (!(zecUsd >= zec.heuristicLowerUsd && zecUsd <= zec.heuristicUpperUsd)) refusals.push("rates_stale");
    if (!(usdcUsd >= usdc.heuristicLowerUsd && usdcUsd <= usdc.heuristicUpperUsd)) refusals.push("rates_stale");
    const supplied = usdc.availableUnits + usdc.borrowedUnits;
    const utilBps = supplied > 0n ? Number((usdc.borrowedUnits * 10_000n) / supplied) : 0;
    return {
      venue: {
        chain: "solana",
        venue: "kamino",
        borrowAprNowPct: Math.round(kaminoCurveAprBps(usdc.borrowRateCurve, utilBps) * 100) / 10_000,
        // The ZCASH market's ZEC reserve is collateral-only (its borrow limit is zero), so deposited ZEC earns
        // nothing while it sits there. Stated rather than assumed: a non-zero number here would flatter the net.
        supplyAprPct: 0,
        liquidationThresholdBps: zec.liquidationThresholdPct * 100,
        venueMaxLtvBps: zec.loanToValuePct * 100,
        availableUnits: usdc.availableUnits.toString(),
        borrowedUnits: usdc.borrowedUnits.toString(),
        borrowLimitUnits: usdc.borrowLimitUnits.toString(),
        decimals: usdc.mintDecimals,
        borrowCurve: usdc.borrowRateCurve,
        refusals,
        stale: sample.stale,
      },
      reason: null,
    };
  }

  /**
   * GET /v1/solana/borrow[?collateral=<ZEC>&amount=<USDC>&entryHf=<hf>] — Kamino's ZCASH market as it is, and
   * what a borrow would do to it (SOLANA-ARCHITECTURE.md §7, BUILD-PLAN D4/D5: refusals are safety only).
   */
  /**
   * `GET /v1/exit-quote` — Door 1's endpoint (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.1), which
   * will proxy a LIVE NEAR Intents quote for USDC → ZEC and cache no rate into code.
   *
   * Today it refuses, and the refusal is the feature. §3.3: nothing about that route has been read
   * into a `docs/VERIFIED-*-FACTS.md` file — not the endpoints, not their shapes, not a fee, not the
   * signer set. Step Z1 is that read. So the route exists, is wired, is tested, and answers 503 with
   * the reason and the name of the document that would unblock it; there is no code path here that
   * reaches the network, and `zecExit.ts` is pinned by its own test to contain no URL.
   *
   * The precondition is checked by looking for the document, not by trusting a flag: an operator can
   * turn Door 1 off, but nobody can turn "somebody read this" on.
   */
  private exitQuotePayload(): Record<string, unknown> & { status?: number } {
    const readiness = zecExitReadiness({ factsPresent: zecRouteFactsPresent(), flagEnabled: this.cfg.zecExitEnabled });
    if (!readiness.ready) return { ...zecExitRefusal(readiness), openQuestions: ZEC_EXIT_OPEN_QUESTIONS, status: 503 };
    // Unreachable until Step Z1 lands AND the operator switches it on. When that happens the live
    // proxy goes here — and `verifiedIn` on the quote is what makes it impossible to ship a shape
    // nobody read, the same discipline as zecForms.ts.
    return { error: "zec_exit_unimplemented", reason: "The route has been read but the live quote proxy is not built yet.", status: 501 };
  }

  private solanaBorrowPayload(url: URL): (SolanaBorrowView & Record<string, unknown> & { status?: number }) | (Record<string, unknown> & { status: number }) {
    const q = url.searchParams;
    const num = (name: string, max: number): number | null | "bad" => {
      const raw = q.get(name);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 && n <= max ? n : "bad";
    };
    const collateralZec = num("collateral", 1e9);
    if (collateralZec === "bad") return { error: "collateral must be a positive amount of ZEC", status: 400 };
    const amountUsdc = num("amount", 1e12);
    if (amountUsdc === "bad") return { error: "amount must be a positive amount of USDC", status: 400 };
    const entryHfParam = q.get("entryHf");
    const entryHf = entryHfParam === null ? null : Number(entryHfParam);
    if (entryHf !== null && !(Number.isFinite(entryHf) && entryHf >= MIN_ENTRY_HF && entryHf <= MAX_ENTRY_HF)) {
      return { error: `entryHf must be a number in [${MIN_ENTRY_HF}, ${MAX_ENTRY_HF}]`, status: 400 };
    }
    const floor = this.entryHfFloorForServe();
    const view = evaluateSolanaBorrow({ sample: this.kaminoForServe(), collateralZec, amountUsdc, entryHf, entryHfFloor: floor.floor });
    return {
      ...view,
      configured: this.kamino !== undefined,
      entryHfFloorSource: floor.source,
      entryHfFloorReadAt: floor.readAt,
      generatedAt: new Date(this.now()).toISOString(),
      methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/SOLANA-ARCHITECTURE.md",
    };
  }

  private bandPayload(url: URL): Record<string, unknown> & { status?: number } {
    const ltv = Number(url.searchParams.get("ltv"));
    // Lower bound 0.01: an ltv like 1e-300 is either a typo or a probe, and
    // produces meaningless quasi-zero leverage math.
    if (!(ltv >= 0.01 && ltv <= 0.5)) {
      return { error: "ltv must be in [0.01, 0.5]", status: 400 };
    }
    const collateralParam = url.searchParams.get("collateral") ?? "";
    if (!isCollateralSymbol(collateralParam)) {
      return { error: `collateral required (one of ${COLLATERAL_SYMBOLS.join(", ")})`, status: 400 };
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
    if (unknown.length) return { error: "unknown pool ids", unknown, status: 400 };

    const rates = this.ratesForServe();
    if (!rates) return { error: "rates_unavailable", status: 503 };
    if (rates.stale) return { error: "rates_stale", status: 503 };
    const reserve = rates.collateral[collateralParam];
    if (!reserve) return { error: "collateral_not_active", status: 503 };
    const borrow = rates.borrow.variableBorrowAprPct;
    const supply = reserve.supplyAprPct;

    const missing = ids.filter((id) => !this.bands.has(id));
    const perWindow = this.cfg.cohortWindows.map((w) => {
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
      collateral: collateralParam,
      mix: ids,
      missingBands: missing,
      borrowAprPct: borrow,
      collateralSupplyAprPct: supply,
      ratesSampledAt: rates.sampledAt,
      mixAveraging: "percentile-mean-v1",
      windows: perWindow,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Health with per-source freshness. `ok` is false — and the endpoint 503s —
   * when the rates are missing/stale, when no source has ever refreshed, or
   * when every sampleable pool's live or emissions sample is stale.
   */
  private health(): Record<string, unknown> & { ok: boolean } {
    const sampleable = CURATED_POOLS.filter((p) => p.poolAddress);
    const aeroPools = sampleable.filter((p) => p.dex === "AERODROME");
    const count = (
      ids: readonly string[],
      map: Map<string, CacheEntry<unknown>>
    ): { total: number; fresh: number; stale: number } => {
      let fresh = 0;
      let stale = 0;
      for (const id of ids) {
        const e = map.get(id);
        if (!e?.value) continue;
        if (this.isStale(e)) stale += 1;
        else fresh += 1;
      }
      return { total: ids.length, fresh, stale };
    };
    const live = count(sampleable.map((p) => p.id), this.live as Map<string, CacheEntry<unknown>>);
    const emissions = count(aeroPools.map((p) => p.id), this.emissions as Map<string, CacheEntry<unknown>>);
    const ratesStale = this.isStale(this.rates);
    const degraded: string[] = [];
    if (!this.lastRefresh) degraded.push("never_refreshed");
    if (!this.rates.value) degraded.push("rates_unavailable");
    else if (ratesStale) degraded.push("rates_stale");
    if (live.fresh === 0 && live.total > 0) degraded.push("live_samples_stale");
    if (emissions.fresh === 0 && emissions.total > 0) degraded.push("emissions_stale");
    if (!this.mcCalibration) degraded.push("mc_calibration_unavailable");
    const kaminoStale = this.isStale(this.kaminoEntry);
    if (this.kamino) {
      if (!this.kaminoEntry.value) degraded.push("kamino_unavailable");
      else if (kaminoStale) degraded.push("kamino_stale");
    }
    return {
      ok: degraded.length === 0,
      degraded,
      uptimeS: Math.round((this.now() - this.startedAt) / 1000),
      lastRefresh: this.lastRefresh ? new Date(this.lastRefresh).toISOString() : null,
      sources: {
        rates: this.rates.value ? { sampledAt: this.rates.value.sampledAt, stale: ratesStale } : null,
        emissionsPools: emissions,
        livePools: live,
        volatilityAsOf: this.volatility.asOf,
        mcCalibrationGeneratedAt: this.mcCalibration?.generatedAt ?? null,
        kamino: this.kamino ? (this.kaminoEntry.value ? { sampledAt: this.kaminoEntry.value.sampledAt, slot: this.kaminoEntry.value.slot, stale: kaminoStale } : null) : "not_configured",
      },
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

    /** Payload builders return an internal `status`; it is the HTTP status, never a body field. */
    const sendPayload = (payload: Record<string, unknown> & { status?: number }) => {
      const { status, ...body } = payload;
      return send(typeof status === "number" ? status : 200, body);
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
        case "/healthz": {
          const h = this.health();
          // A monitor must be able to see a dead service. `ok:true`
          // unconditionally, with counts of entries that merely HAVE a value,
          // reported a healthy service while every source had been dead for
          // hours (wave-1 lens D MED-5).
          return send(h.ok ? 200 : 503, h);
        }
        case "/v1/pools":
          return send(200, this.poolsPayload());
        case "/v1/rates": {
          const r = this.ratesForServe();
          return r
            ? send(200, r)
            : // Fixed reason enum — never raw upstream error text (provider
              // HTML/JSON snippets leak infrastructure details).
              send(503, { error: "rates_unavailable", reason: "upstream_unavailable" });
        }
        case "/v1/gate":
          return sendPayload(this.gatePayload(url));
        case "/v1/band":
          return sendPayload(this.bandPayload(url));
        case "/v1/forecast":
          return sendPayload(this.forecastPayload(url) as Record<string, unknown> & { status?: number });
        case "/v1/solana/borrow":
          return sendPayload(this.solanaBorrowPayload(url) as Record<string, unknown> & { status?: number });
        case "/v1/exit-quote":
          return sendPayload(this.exitQuotePayload() as Record<string, unknown> & { status?: number });
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
export function priceForToken(s: PoolLiveSample, token: Address): number | undefined {
  const t = token.toLowerCase();
  if (s.baseTokenAddress?.toLowerCase() === t && s.baseTokenPriceUsd !== undefined) {
    return Number.isFinite(s.baseTokenPriceUsd) ? s.baseTokenPriceUsd : undefined;
  }
  if (s.quoteTokenAddress?.toLowerCase() === t && s.quoteTokenPriceUsd !== undefined) {
    return Number.isFinite(s.quoteTokenPriceUsd) ? s.quoteTokenPriceUsd : undefined;
  }
  return undefined;
}
