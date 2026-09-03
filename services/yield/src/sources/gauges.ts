/**
 * Aerodrome CL gauge emissions source (task #111).
 *
 * Slipstream pools staked in a gauge earn AERO in lieu of trading fees. The
 * gauge streams `rewardRate` AERO-wei per second to STAKED IN-RANGE liquidity
 * until `periodFinish` (weekly epochs, topped up by the Voter). This source
 * resolves each pool's gauge once (Voter.gauges(pool), cached), samples the
 * gauge + pool state in one batched eth_call round, and converts it to APRs:
 *
 *   wholePoolAprPct = rewardRate × YEAR × aeroUsd / poolTvlUsd × 100
 *     — emissions against the WHOLE pool's TVL: the floor a passive
 *       full-range staker would see.
 *
 *   APR(w) = rewardRate × YEAR × aeroUsd / V_staked(w) × 100
 *     — the MARGINAL rate for a newly staked in-range position of range
 *       width w, where V_staked(w) prices the staked in-range liquidity as
 *       if concentrated at width w:
 *
 *   V_staked(w) = stakedLiquidity × sqrtP × (2 − √(1−w) − 1/√(1+w))
 *                 / 10^dec1 × token1Usd
 *     with sqrtP = sqrtPriceX96 / 2⁹⁶. Derivation: a CL position of
 *     liquidity L on [P(1−w), P(1+w)] holds token1 value L·sqrtP·(1−√(1−w))
 *     and token0 value (in token1 terms) L·sqrtP·(1/1 − 1/√(1+w)) — summing
 *     gives the bracket above. Dividing the annual reward USD by that value
 *     yields the APR a position of width w earns while in range and staked.
 *
 * PRECISION: stakedLiquidity (uint128) and sqrtPriceX96 (uint160) exceed
 * 2⁵³, so BigInt→Number conversion loses ABSOLUTE precision. The math is a
 * product/quotient chain, so only RELATIVE error matters: ≤ ~2⁻⁵² per
 * conversion (~1e-15), far below the 2-decimal display rounding. No
 * subtraction of near-equal magnitudes occurs (the width bracket is computed
 * in float from w alone). Cross-checked against a live sample in tests
 * (services/yield/samples/gauge-emissions-2026-08-31.json).
 *
 * NOISE: instantaneous stakedLiquidity moves with every stake/unstake, so a
 * rolling average of the last `maxSamples` (12) readings feeds V_staked;
 * `samples` in the payload says how many an APR is averaged over.
 */

import type { RpcClient } from "./rpc.js";
import type { Address, EmissionsSample } from "../types.js";

/** Aerodrome Voter on Base — resolves pool → CL gauge. */
export const AERODROME_VOTER: Address = "0x16613524e02ad97edfef371bc883f2f5d6c480a5";

// Selectors (4-byte keccak prefixes, recorded provenance in the task spec).
const SEL_GAUGES = "0xb9a09fd5"; // Voter.gauges(address)
const SEL_REWARD_RATE = "0x7b0a47ee"; // gauge.rewardRate()
const SEL_PERIOD_FINISH = "0xebe2b12b"; // gauge.periodFinish()
const SEL_SLOT0 = "0x3850c7bd"; // pool.slot0()
const SEL_LIQUIDITY = "0x1a686502"; // pool.liquidity()
const SEL_STAKED_LIQUIDITY = "0x3ab04b20"; // pool.stakedLiquidity()
const SEL_FEE = "0xddca3f43"; // pool.fee()

const SECONDS_PER_YEAR = 31_536_000;

/** Range widths (± fraction of price) the product quotes emissions for. */
export const EMISSION_WIDTHS = [0.25, 0.125, 0.08, 0.04, 0.015, 0.0075] as const;

/**
 * token decimals for the known Base tokens the curated pools use — keyed by
 * lowercase address. Emissions math needs token1's decimals; an unknown
 * token1 makes the pool's emissions null (never guessed).
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  "0x4200000000000000000000000000000000000006": 18, // WETH
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 8, // cbBTC
  "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196": 18, // LINK
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": 6, // USDT
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": 18, // cbETH
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": 18, // AERO
};

/** AERO on Base (the emissions token), lowercase. */
export const AERO_ADDRESS: Address = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";

/** Curated-pool token SYMBOL → Base address (lowercase). */
export const BASE_TOKEN_ADDRESSES: Record<string, Address> = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  cbBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  LINK: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196",
  USDT: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
  cbETH: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
  AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
};

/**
 * The ON-CHAIN token1 for a curated pool, from its two token symbols.
 * CL pools order token0 < token1 BY ADDRESS — the curated list's
 * token0/token1 fields are display-ordered and disagree for USDT/USDC
 * (on-chain token0 is USDC), so we must sort, never trust display order.
 * Returns null when either symbol is unknown (emissions then stay null).
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
  /** AERO/USD (from the GeckoTerminal live samples). */
  aeroUsd: number;
  /** Whole-pool TVL in USD (GeckoTerminal reserve_in_usd). */
  poolTvlUsd: number;
  /** token1/USD (GeckoTerminal base/quote price matched by address). */
  token1Usd: number;
  /** token1 decimals (TOKEN_DECIMALS). */
  token1Decimals: number;
  /** Unix seconds "now" — injectable for tests. */
  nowSeconds?: number;
}

function encodeAddressArg(addr: Address): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function wordAt(raw: string, i: number): string {
  return raw.slice(i * 64, (i + 1) * 64);
}

/** The width bracket 2 − √(1−w) − 1/√(1+w), in plain float (w ∈ (0,1)). */
export function widthBracket(w: number): number {
  return 2 - Math.sqrt(1 - w) - 1 / Math.sqrt(1 + w);
}

export class GaugeSource {
  /** pool (lowercase) → gauge; gauges never move for a pool, cache forever. */
  private gaugeCache = new Map<string, Address>();
  /** pool (lowercase) → recent stakedLiquidity readings (as Number). */
  private stakedHistory = new Map<string, number[]>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly maxSamples = 12
  ) {}

  /** Resolve (and cache) the CL gauge for a pool via the Aerodrome Voter. */
  async gaugeFor(pool: Address): Promise<Address> {
    const key = pool.toLowerCase();
    const cached = this.gaugeCache.get(key);
    if (cached) return cached;
    const raw = await this.rpc.ethCall(AERODROME_VOTER, SEL_GAUGES + encodeAddressArg(pool));
    const gauge = `0x${wordAt(raw, 0).slice(24)}`.toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(gauge) || /^0x0{40}$/.test(gauge)) {
      throw new Error(`voter has no gauge for pool ${pool}`);
    }
    this.gaugeCache.set(key, gauge);
    return gauge;
  }

  /**
   * One emissions sample for a pool. Throws when the chain data cannot be
   * read or the epoch math would divide by zero — the caller keeps the
   * previous sample (or serves null) exactly like the other live sources.
   */
  async sample(pool: Address, prices: GaugePriceInputs): Promise<EmissionsSample> {
    if (!(prices.aeroUsd > 0) || !(prices.poolTvlUsd > 0) || !(prices.token1Usd > 0)) {
      throw new Error(
        `gauge ${pool}: unusable price inputs (aeroUsd=${prices.aeroUsd}, ` +
          `poolTvlUsd=${prices.poolTvlUsd}, token1Usd=${prices.token1Usd})`
      );
    }
    const gauge = await this.gaugeFor(pool);
    const [rewardRateRaw, periodFinishRaw, slot0Raw, liquidityRaw, stakedRaw, feeRaw] =
      await this.rpc.callMany<string>([
        { method: "eth_call", params: [{ to: gauge, data: SEL_REWARD_RATE }, "latest"] },
        { method: "eth_call", params: [{ to: gauge, data: SEL_PERIOD_FINISH }, "latest"] },
        { method: "eth_call", params: [{ to: pool, data: SEL_SLOT0 }, "latest"] },
        { method: "eth_call", params: [{ to: pool, data: SEL_LIQUIDITY }, "latest"] },
        { method: "eth_call", params: [{ to: pool, data: SEL_STAKED_LIQUIDITY }, "latest"] },
        { method: "eth_call", params: [{ to: pool, data: SEL_FEE }, "latest"] },
      ]);
    const clean = (r: string | undefined, what: string): string => {
      const hex = (r ?? "").replace(/^0x/, "");
      if (!hex) throw new Error(`gauge ${pool}: empty eth_call result for ${what}`);
      return hex;
    };

    const rewardRate = BigInt(`0x${wordAt(clean(rewardRateRaw, "rewardRate"), 0)}`);
    const periodFinish = Number(BigInt(`0x${wordAt(clean(periodFinishRaw, "periodFinish"), 0)}`));
    const sqrtPriceX96 = BigInt(`0x${wordAt(clean(slot0Raw, "slot0"), 0)}`);
    const stakedLiquidity = BigInt(`0x${wordAt(clean(stakedRaw, "stakedLiquidity"), 0)}`);
    // liquidity() and fee() are sampled alongside (cheap in the same batch)
    // for observability / future gross-fee refresh; not used in APR math yet.
    void liquidityRaw;
    void feeRaw;

    const now = prices.nowSeconds ?? Math.floor(Date.now() / 1000);
    const sampledAt = new Date(now * 1000).toISOString();
    const epochActive = periodFinish > now;

    // Rolling stakedLiquidity average (instantaneous readings are noisy).
    const key = pool.toLowerCase();
    const history = this.stakedHistory.get(key) ?? [];
    history.push(Number(stakedLiquidity));
    while (history.length > this.maxSamples) history.shift();
    this.stakedHistory.set(key, history);
    const stakedAvg = history.reduce((s, x) => s + x, 0) / history.length;

    if (!epochActive) {
      // Epoch lapsed: rewardRate is a stale artifact until the next
      // notifyRewardAmount — showing its APR would advertise yield nobody
      // earns. Report zeros with epochActive:false.
      const zeros: Record<string, number> = {};
      for (const w of EMISSION_WIDTHS) zeros[String(w)] = 0;
      return { wholePoolAprPct: 0, aprByWidthPct: zeros, epochActive, sampledAt, gauge, samples: history.length };
    }

    // Everything below is float math — see PRECISION note in the header.
    const usdPerYear = (Number(rewardRate) / 1e18) * SECONDS_PER_YEAR * prices.aeroUsd;
    const wholePoolAprPct = round2((usdPerYear / prices.poolTvlUsd) * 100);

    const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
    const aprByWidthPct: Record<string, number> = {};
    for (const w of EMISSION_WIDTHS) {
      const vStakedUsd =
        ((stakedAvg * sqrtP * widthBracket(w)) / 10 ** prices.token1Decimals) * prices.token1Usd;
      aprByWidthPct[String(w)] = vStakedUsd > 0 ? round2((usdPerYear / vStakedUsd) * 100) : 0;
    }

    return { wholePoolAprPct, aprByWidthPct, epochActive, sampledAt, gauge, samples: history.length };
  }
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}
