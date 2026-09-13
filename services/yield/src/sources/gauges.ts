/**
 * Aerodrome CL gauge emissions source.
 *
 * Slipstream pools staked in a gauge earn AERO in lieu of trading fees. The
 * gauge streams `rewardRate` AERO-wei per second to STAKED IN-RANGE
 * liquidity until `periodFinish` (weekly epochs, topped up by the Voter).
 * This source resolves each pool's gauge once (Voter.gauges(pool), cached,
 * cross-checked against the curated registry where it records one), samples
 * gauge + pool state in one batched eth_call round, and converts it to the
 * per-width APRs the model defines (src/model.ts):
 *
 *   wholePoolAprPct = rewardRate × YEAR × aeroUsd / poolTvlUsd × 100
 *   APR(bps)        = rewardRate × YEAR × aeroUsd / V_staked(w(bps)) × 100
 *
 * Widths are the shared RANGE_PRESETS (both pair classes), keyed by TOTAL
 * bps — never a typed ±.
 *
 * PRECISION: stakedLiquidity (uint128) and sqrtPriceX96 (uint160) exceed
 * 2⁵³, so BigInt→Number loses ABSOLUTE precision. The math is a
 * product/quotient chain, so only RELATIVE error matters: ≤ ~2⁻⁵² per
 * conversion, far below the 2-decimal display rounding. Cross-checked
 * against the live 2026-08-31 sample in test/gauges.test.ts.
 *
 * NOISE + OUTLIERS: instantaneous stakedLiquidity moves with every
 * stake/unstake, so a rolling average of the accepted readings feeds
 * V_staked. The anchor a reading is tested against is the MEDIAN of that
 * accepted history, and it is only trusted once MIN_STAKED_SAMPLES
 * independent readings have agreed on it. A reading more than
 * OUTLIER_FACTOR× away from the anchor (either direction) is flagged
 * `outlier` and kept OUT of the average; the gate refuses it.
 *
 * WHY NOT THE FIRST READING (wave-1 lens D HIGH-2). The filter used to
 * compare every reading against the FIRST reading ever taken for the pool.
 * The first reading is then BY CONSTRUCTION never an outlier, and it became
 * the permanent anchor. stakedLiquidity is an instantaneous uint128 that
 * moves with every stake/unstake, so one sample taken during a mass unstake
 * — or simply on a gauge whose staked share is momentarily tiny — anchored
 * the filter at the anomaly. Emissions APR is inversely proportional to the
 * staked base, so a 1,000× low first reading produced a 1,000× high APR,
 * served with `outlier:false` because there was nothing to compare it to
 * (measured: 7,599.64 % against a true 3.80 %). Every subsequent CORRECT
 * reading was then rejected as an outlier and kept out of the history, so
 * the average stayed pinned to the anomaly for the life of the process.
 * Two changes close it: no APR is published at all until the anchor is
 * corroborated, and MIN_STAKED_SAMPLES consecutive outliers mean the ANCHOR
 * is what is wrong — the history is dropped and re-corroborated from
 * scratch, so a wrong anchor can never stick.
 *
 * STRICT DECODING: every eth_call return must be exactly the declared word
 * count; empty/short returns throw (the pool keeps its previous sample,
 * served stale, or none). A gauge that resolves to the zero address throws.
 *
 * STALENESS: the sample carries `sampledAt` only; `stale` is derived at
 * serve time. `epochActive` is re-derived at serve time from periodFinish
 * as well, so a lapsed epoch can never keep serving as active.
 */

import { AERODROME, BASE_TOKENS } from "@zyo/shared";
import { emissionsAprPct, modelWidthsBps, priceHalfWidth, round2, SECONDS_PER_YEAR } from "../model.js";
import type { RpcClient } from "./rpc.js";
import type { Address, EmissionsSample } from "../types.js";

/** Aerodrome Voter on Base — resolves pool → CL gauge (shared/base.ts). */
export const AERODROME_VOTER: Address = AERODROME.voter.toLowerCase() as Address;

// Selectors — pinned; re-derived from the signatures in test/gauges.test.ts.
export const SEL = {
  gauges: "0xb9a09fd5", // Voter.gauges(address)
  rewardRate: "0x7b0a47ee", // gauge.rewardRate()
  periodFinish: "0xebe2b12b", // gauge.periodFinish()
  slot0: "0x3850c7bd", // pool.slot0()
  liquidity: "0x1a686502", // pool.liquidity()
  stakedLiquidity: "0x3ab04b20", // pool.stakedLiquidity()
  fee: "0xddca3f43", // pool.fee()
} as const;

/** slot0() returns 6 words on Slipstream (sqrtPriceX96, tick, obsIndex, card, cardNext, unlocked). */
const SLOT0_WORDS = 6;

/** A stakedLiquidity reading outside [anchor/F, anchor×F] is an outlier. */
export const OUTLIER_FACTOR = 5;

/**
 * Independent readings that must agree before the anchor — and therefore any
 * APR derived from it — is trusted. Below this the sample is published with
 * `corroborated:false` and NO APR, and the gate refuses it with
 * `insufficient_samples`.
 */
export const MIN_STAKED_SAMPLES = 3;

/**
 * Token decimals for the Base tokens the curated pools use — keyed by
 * lowercase address. Emissions math needs token1's decimals; an unknown
 * token1 makes the pool's emissions fail (never guessed). The five product
 * tokens come from @zyo/shared; LINK/USDT/cbETH are the 2026-08-27
 * registry-verified addresses of the remaining curated pairs.
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  [BASE_TOKENS.WETH.address.toLowerCase()]: BASE_TOKENS.WETH.decimals,
  [BASE_TOKENS.USDC.address.toLowerCase()]: BASE_TOKENS.USDC.decimals,
  [BASE_TOKENS.cbBTC.address.toLowerCase()]: BASE_TOKENS.cbBTC.decimals,
  [BASE_TOKENS.cbZEC.address.toLowerCase()]: BASE_TOKENS.cbZEC.decimals,
  [BASE_TOKENS.AERO.address.toLowerCase()]: BASE_TOKENS.AERO.decimals,
  "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196": 18, // LINK
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": 6, // USDT
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": 18, // cbETH
};

/** AERO on Base (the emissions token), lowercase. */
export const AERO_ADDRESS: Address = BASE_TOKENS.AERO.address.toLowerCase() as Address;

/** Curated-pool token SYMBOL → Base address (lowercase). */
export const BASE_TOKEN_ADDRESSES: Record<string, Address> = {
  WETH: BASE_TOKENS.WETH.address.toLowerCase() as Address,
  USDC: BASE_TOKENS.USDC.address.toLowerCase() as Address,
  cbBTC: BASE_TOKENS.cbBTC.address.toLowerCase() as Address,
  cbZEC: BASE_TOKENS.cbZEC.address.toLowerCase() as Address,
  AERO: BASE_TOKENS.AERO.address.toLowerCase() as Address,
  LINK: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196",
  USDT: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
  cbETH: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
};

/**
 * The ON-CHAIN token1 for a curated pool, from its two token symbols.
 * CL pools order token0 < token1 BY ADDRESS — the curated list's
 * token0/token1 fields are display-ordered and disagree for USDT/USDC
 * (on-chain token1 is USDT) and for cbZEC/USDC (on-chain token0 is USDC,
 * token1 cbZEC — verified 2026-09-05). Sort, never trust display order.
 */
export function onchainToken1(
  token0Symbol: string,
  token1Symbol: string
): { address: Address; decimals: number } | null {
  const a = BASE_TOKEN_ADDRESSES[token0Symbol];
  const b = BASE_TOKEN_ADDRESSES[token1Symbol];
  if (!a || !b) return null;
  const token1 = a > b ? a : b; // both lowercase hex → string compare = numeric compare
  const decimals = TOKEN_DECIMALS[token1];
  return decimals === undefined ? null : { address: token1, decimals };
}

export interface GaugePriceInputs {
  /** AERO/USD. */
  aeroUsd: number;
  /** Whole-pool TVL in USD (context for wholePoolAprPct). */
  poolTvlUsd: number;
  /** token1/USD. */
  token1Usd: number;
  token1Decimals: number;
  /** Unix seconds "now" — injectable for tests. */
  nowSeconds?: number;
}

export class GaugeDecodeError extends Error {
  constructor(pool: string, what: string, detail: string) {
    super(`gauge ${pool} ${what}: ${detail}`);
    this.name = "GaugeDecodeError";
  }
}

function encodeAddressArg(addr: Address): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function wordAt(raw: string, i: number): string {
  return raw.slice(i * 64, (i + 1) * 64);
}

/** Median of a non-empty list (average of the middle pair when even). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Is `reading` consistent with `anchor`? One definition, used both to flag an
 * incoming reading and to prune the history — they must never disagree.
 */
function agreesWithAnchor(anchor: number, reading: number): boolean {
  if (anchor > 0 && reading > 0) {
    return reading <= anchor * OUTLIER_FACTOR && reading >= anchor / OUTLIER_FACTOR;
  }
  return anchor === reading; // a zero appearing/disappearing is an outlier too
}

function strict(pool: string, raw: string | undefined, words: number, what: string): string {
  const hex = (raw ?? "").replace(/^0x/, "");
  if (!hex) throw new GaugeDecodeError(pool, what, "empty return (reverted or wrong address)");
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new GaugeDecodeError(pool, what, "non-hex return");
  if (hex.length !== words * 64) {
    throw new GaugeDecodeError(pool, what, `expected ${words} words, got ${hex.length / 64}`);
  }
  return hex;
}

export class GaugeSource {
  /** pool (lowercase) → gauge; gauges never move for a pool, cache forever. */
  private gaugeCache = new Map<string, Address>();
  /** pool (lowercase) → recent NON-outlier stakedLiquidity readings (as Number). */
  private stakedHistory = new Map<string, number[]>();
  /** pool (lowercase) → consecutive readings rejected against the current anchor. */
  private outlierStreak = new Map<string, number>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly maxSamples = 12
  ) {}

  /**
   * Resolve (and cache) the CL gauge for a pool via the Aerodrome Voter.
   * When the caller knows the gauge from the verified registry, the voter's
   * answer must match it — a mismatch fails closed.
   */
  async gaugeFor(pool: Address, expected?: Address, block?: number): Promise<Address> {
    const key = pool.toLowerCase();
    const cached = this.gaugeCache.get(key);
    if (cached) return cached;
    const raw = await this.rpc.ethCall(AERODROME_VOTER, SEL.gauges + encodeAddressArg(pool), block ?? "latest");
    const hex = strict(pool, raw, 1, "voter.gauges");
    const gauge = `0x${wordAt(hex, 0).slice(24)}`.toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(gauge) || /^0x0{40}$/.test(gauge)) {
      throw new GaugeDecodeError(pool, "voter.gauges", "voter has no gauge for this pool");
    }
    if (expected && gauge !== expected.toLowerCase()) {
      throw new GaugeDecodeError(pool, "voter.gauges", `voter says ${gauge}, registry says ${expected}`);
    }
    this.gaugeCache.set(key, gauge);
    return gauge;
  }

  /**
   * One emissions sample for a pool. Throws when the chain data cannot be
   * read — the caller keeps the previous sample (served stale) or none.
   */
  async sample(
    poolId: string,
    pool: Address,
    prices: GaugePriceInputs,
    expectedGauge?: Address,
    /** Pin every `eth_call` of this sample to one block (slice M); `latest` when absent. Pass the block's timestamp as `prices.nowSeconds` with it. */
    block?: number
  ): Promise<EmissionsSample> {
    if (!(prices.aeroUsd > 0) || !(prices.poolTvlUsd > 0) || !(prices.token1Usd > 0)) {
      throw new Error(
        `gauge ${pool}: unusable price inputs (aeroUsd=${prices.aeroUsd}, ` +
          `poolTvlUsd=${prices.poolTvlUsd}, token1Usd=${prices.token1Usd})`
      );
    }
    const gauge = await this.gaugeFor(pool, expectedGauge, block);
    const tag = block === undefined ? "latest" : `0x${block.toString(16)}`;
    const results = await this.rpc.callMany<string>([
      { method: "eth_call", params: [{ to: gauge, data: SEL.rewardRate }, tag] },
      { method: "eth_call", params: [{ to: gauge, data: SEL.periodFinish }, tag] },
      { method: "eth_call", params: [{ to: pool, data: SEL.slot0 }, tag] },
      { method: "eth_call", params: [{ to: pool, data: SEL.stakedLiquidity }, tag] },
      { method: "eth_call", params: [{ to: pool, data: SEL.fee }, tag] },
    ]);
    if (results.length !== 5) throw new GaugeDecodeError(pool, "batch", `expected 5 results, got ${results.length}`);
    const [rewardRateRaw, periodFinishRaw, slot0Raw, stakedRaw, feeRaw] = results;

    const rewardRate = BigInt(`0x${strict(pool, rewardRateRaw, 1, "rewardRate")}`);
    const periodFinish = Number(BigInt(`0x${strict(pool, periodFinishRaw, 1, "periodFinish")}`));
    const sqrtPriceX96 = BigInt(`0x${wordAt(strict(pool, slot0Raw, SLOT0_WORDS, "slot0"), 0)}`);
    const stakedLiquidity = BigInt(`0x${strict(pool, stakedRaw, 1, "stakedLiquidity")}`);
    const feePips = Number(BigInt(`0x${strict(pool, feeRaw, 1, "fee")}`));
    if (sqrtPriceX96 === 0n) throw new GaugeDecodeError(pool, "slot0", "sqrtPriceX96 is 0 (uninitialized pool)");

    const now = prices.nowSeconds ?? Math.floor(Date.now() / 1000);
    const sampledAt = new Date(now * 1000).toISOString();
    const epochActive = rewardRate > 0n && periodFinish > now;

    // Outlier gate against the MEDIAN of the corroborated history, then
    // rolling average of the accepted readings (instantaneous values are
    // noisy). Never against the first reading — see the header.
    const key = pool.toLowerCase();
    const reading = Number(stakedLiquidity);
    let history = this.stakedHistory.get(key) ?? [];
    let streak = this.outlierStreak.get(key) ?? 0;
    let outlier = false;
    if (history.length >= MIN_STAKED_SAMPLES) {
      outlier = !agreesWithAnchor(median(history), reading);
    }
    if (outlier) {
      streak += 1;
      if (streak >= MIN_STAKED_SAMPLES) {
        // MIN_STAKED_SAMPLES readings in a row disagree with the anchor: the
        // ANCHOR is the anomaly, not the readings. Drop it and re-corroborate
        // from scratch — until then nothing is published (fail closed), so a
        // bad anchor can neither be trusted nor stick.
        history = [];
        streak = 0;
        outlier = false;
      }
    } else {
      streak = 0;
    }
    if (!outlier) {
      history.push(reading);
      while (history.length > this.maxSamples) history.shift();
    }
    // Prune the history against its OWN anchor. The corroborating window is
    // filled before any anchor exists, so an anomalous early reading would
    // otherwise sit inside the average it is supposed to be excluded from —
    // one 2,000×-low first reading still pulled the served APR 17 % high.
    // Dropping below MIN_STAKED_SAMPLES here simply means the pool is not
    // corroborated yet, which is the fail-closed direction.
    if (history.length >= MIN_STAKED_SAMPLES) {
      const anchor = median(history);
      history = history.filter((x) => agreesWithAnchor(anchor, x));
    }
    this.stakedHistory.set(key, history);
    this.outlierStreak.set(key, streak);
    const corroborated = history.length >= MIN_STAKED_SAMPLES;
    const stakedAvg = history.length ? history.reduce((s, x) => s + x, 0) / history.length : reading;

    const base = {
      poolId,
      pool: key as Address,
      gauge,
      rewardRateWeiPerSec: rewardRate.toString(),
      periodFinish,
      epochActive,
      stakedLiquidity: stakedLiquidity.toString(),
      samples: history.length,
      corroborated,
      outlier,
      sqrtPriceX96: sqrtPriceX96.toString(),
      feePips,
      aeroUsd: prices.aeroUsd,
      sampledAt,
    };

    if (!epochActive) {
      // Lapsed epoch or never-voted gauge: rewardRate is either 0 or a stale
      // artifact until the next notifyRewardAmount — showing an APR would
      // advertise yield nobody earns. Zeros, epochActive:false.
      const zeros: Record<string, number> = {};
      for (const bps of modelWidthsBps()) zeros[String(bps)] = 0;
      return { ...base, wholePoolAprPct: 0, aprByWidthPct: zeros };
    }

    if (!corroborated || outlier) {
      // Uncorroborated: the anchor is not yet trusted, so neither is anything
      // divided by it — publishing an APR here is exactly how a 2,000×-
      // overstated figure reached a user with `outlier:false` (lens D HIGH-2).
      // Outlier: this reading and the anchor disagree and it is not yet known
      // which is right, so withhold rather than pick. The gate refuses either
      // way; before this change `/v1/pools` kept publishing regardless.
      return { ...base, wholePoolAprPct: null, aprByWidthPct: null };
    }

    const usdPerYear = (Number(rewardRate) / 1e18) * SECONDS_PER_YEAR * prices.aeroUsd;

    let aprByWidthPct: Record<string, number> | null = {};
    for (const bps of modelWidthsBps()) {
      const apr = emissionsAprPct({
        rewardRateWeiPerSec: rewardRate,
        aeroUsd: prices.aeroUsd,
        stakedLiquidity: stakedAvg,
        sqrtPriceX96,
        token1Decimals: prices.token1Decimals,
        token1Usd: prices.token1Usd,
        halfWidth: priceHalfWidth(bps),
      });
      if (apr === null) {
        aprByWidthPct = null; // no staked liquidity → no marginal APR exists
        break;
      }
      aprByWidthPct[String(bps)] = round2(apr);
    }
    // With no staked liquidity there is no marginal APR AND no whole-pool APR
    // anybody can earn — publishing 513 % beside `aprByWidthPct: null` invited
    // exactly the wrong read (wave-1 lens D LOW-6).
    const wholePoolAprPct = aprByWidthPct === null ? null : round2((usdPerYear / prices.poolTvlUsd) * 100);
    return { ...base, wholePoolAprPct, aprByWidthPct };
  }
}
