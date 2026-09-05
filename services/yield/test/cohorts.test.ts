import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCohortBand,
  MAX_ABS_NET_APR,
  unweightedMedian,
  valueLifecycle,
  weightedPercentile,
} from "../src/cohorts.js";
import { PriceBook } from "../src/prices.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import type { Address, Hex, PositionLifecycle, ValuedLifecycle } from "../src/types.js";

const POOL = ("0x" + "aa".repeat(32)) as Hex;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const UNKNOWN = ("0x" + "77".repeat(20)) as Address;

/**
 * PriceBook with a stubbed gecko. Each registry token's reference pool
 * reports THAT token as its base side (mirroring the live side-detection),
 * and every series prices at $2500 — only WETH's series is exercised below.
 */
function priceBook(): PriceBook {
  const refBase: Record<string, Address> = {
    "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59": WETH,
    "0x4e962bb3889bf030368f56810a9c96b83cb3e778": "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" as Address,
    "0x82321f3beb69f503380d6b233857d5c43562e2d0": "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as Address,
    "0xa9dafa443a02fbc907cb0093276b3e6f4ef02a46": "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22" as Address,
  };
  const stub = {
    pool: async (addr: Address) => ({
      address: addr, tvlUsd: 0, volume24hUsd: 0,
      baseTokenAddress: refBase[addr.toLowerCase()] ?? WETH, quoteTokenAddress: USDC,
      baseTokenPriceUsd: 2500, quoteTokenPriceUsd: 1,
    }),
    dailyUsdCloses: async () => {
      const m = new Map<string, number>();
      const d = new Date(Date.UTC(2026, 7, 1));
      for (let i = 0; i < 70; i++) {
        m.set(d.toISOString().slice(0, 10), 2500);
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return m;
    },
  } as unknown as GeckoSource;
  return new PriceBook(stub);
}

const T0 = Date.UTC(2026, 7, 10) / 1000; // 2026-08-10T00:00Z

function lc(over: Partial<PositionLifecycle>): PositionLifecycle {
  return {
    tokenId: "1", poolId: POOL, owner: ("0x" + "11".repeat(20)) as Address,
    openedBlock: 1, openedAt: T0, closedBlock: 2, closedAt: T0 + 30 * 86400,
    entryFlows: { [USDC]: "1000000000" }, // 1,000 USDC
    entryRefunds: {},
    ambiguousEntry: false,
    unattributedRefundLegs: 0,
    exitFlows: { [USDC]: "1100000000" },  // 1,100 USDC
    harvests: 1, rebalances: 0,
    ...over,
  };
}

test("valueLifecycle: USD flows and annualization", async () => {
  const pb = priceBook();
  await pb.load(30);
  const v = valueLifecycle(lc({}), pb)!;
  assert.equal(v.principalUsd, 1000);
  assert.equal(v.outUsd, 1100);
  assert.equal(v.daysOpen, 30);
  // 10% over 30 days → ×365/30 = 121.666…% APR
  assert.ok(Math.abs(v.netAprFraction - (0.1 * 365) / 30) < 1e-9);
  assert.equal(v.unpriced, false);
});

test("valueLifecycle: open positions return null; unknown tokens mark unpriced", async () => {
  const pb = priceBook();
  await pb.load(30);
  assert.equal(valueLifecycle(lc({ closedAt: undefined }), pb), null);
  const v = valueLifecycle(lc({ exitFlows: { [UNKNOWN]: "5" } }), pb)!;
  assert.equal(v.unpriced, true);
});

test("valueLifecycle: prices WETH flows through the day series", async () => {
  const pb = priceBook();
  await pb.load(30);
  const v = valueLifecycle(
    lc({ entryFlows: { [WETH]: "1000000000000000000" }, exitFlows: { [WETH]: "1100000000000000000" } }),
    pb
  )!;
  assert.equal(v.principalUsd, 2500);
  assert.equal(v.outUsd, 2750);
});

test("weightedPercentile: boundaries, ordering, weight dominance", () => {
  const pairs = [
    { value: 10, weight: 1 },
    { value: 20, weight: 1 },
    { value: 30, weight: 98 },
  ];
  assert.equal(weightedPercentile(pairs, 0), 10);
  assert.equal(weightedPercentile(pairs, 100), 30);
  // the heavy value dominates the middle
  assert.equal(weightedPercentile(pairs, 50), 30);
  assert.equal(weightedPercentile([{ value: 7, weight: 5 }], 50), 7);
  assert.ok(Number.isNaN(weightedPercentile([], 50)));
});

test("unweightedMedian: odd/even", () => {
  assert.equal(unweightedMedian([3, 1, 2]), 2);
  assert.equal(unweightedMedian([4, 1, 2, 3]), 2.5);
});

function valued(over: Partial<ValuedLifecycle>): ValuedLifecycle {
  return {
    tokenId: "1", poolId: POOL, closedAt: T0, daysOpen: 30,
    principalUsd: 1000, outUsd: 1100, netAprFraction: 1.2167, unpriced: false, ambiguousEntry: false,
    ...over,
  };
}

test("buildCohortBand: window filter, exclusions counted, percentile order", () => {
  const now = T0 + 40 * 86400;
  const vs = [
    valued({ closedAt: now - 5 * 86400, netAprFraction: 0.10 }),
    valued({ closedAt: now - 10 * 86400, netAprFraction: 0.30 }),
    valued({ closedAt: now - 15 * 86400, netAprFraction: 0.50 }),
    valued({ closedAt: now - 100 * 86400, netAprFraction: 9.99 }), // outside window
    valued({ closedAt: now - 5 * 86400, unpriced: true }),          // excluded
    valued({ closedAt: now - 5 * 86400, daysOpen: 0.5 }),           // < minDays
    valued({ closedAt: now - 5 * 86400, principalUsd: 0.5 }),       // dust
    null,
  ];
  const band = buildCohortBand(vs, POOL, { windowDays: 30, nowSeconds: now, minDaysOpen: 1 });
  assert.equal(band.n, 3);
  assert.equal(band.excluded, 3);
  assert.ok(band.p10 <= band.p25 && band.p25 <= band.p50);
  assert.ok(band.p50 <= band.p75 && band.p75 <= band.p90);
  assert.equal(band.p10, 10);
  assert.equal(band.p90, 50);
  assert.equal(band.medianUnweighted, 30);
  assert.equal(band.totalPrincipalUsd, 3000);
});

test("valueLifecycle: an attributed refund in the OTHER token reduces principal (single-sided deposit)", async () => {
  const pb = priceBook();
  await pb.load(30);
  // 1,000 USDC in, 0.1 WETH ($250) refunded → principal $750; out 1,100 → +46.7% over 30d
  const v = valueLifecycle(lc({ entryRefunds: { [WETH]: "100000000000000000" } }), pb)!;
  assert.equal(v.principalUsd, 750);
  assert.ok(Math.abs(v.netAprFraction - ((1100 - 750) / 750) * (365 / 30)) < 1e-9);
  // an unpriceable refund marks the position unpriced (never silently ignored)
  const u = valueLifecycle(lc({ entryRefunds: { [UNKNOWN]: "5" } }), pb)!;
  assert.equal(u.unpriced, true);
});

test("buildCohortBand: the absolute outcome bound and ambiguous entries are excluded and counted per reason", () => {
  const now = T0 + 40 * 86400;
  const vs = [
    valued({ closedAt: now - 2 * 86400, netAprFraction: 0.2 }),
    valued({ closedAt: now - 2 * 86400, netAprFraction: 364_963.5 }), // the wave-2 +36,496,350 % band
    valued({ closedAt: now - 2 * 86400, netAprFraction: -MAX_ABS_NET_APR - 0.01 }),
    valued({ closedAt: now - 2 * 86400, netAprFraction: MAX_ABS_NET_APR }), // exactly at the bound: kept
    valued({ closedAt: now - 2 * 86400, netAprFraction: 0.3, ambiguousEntry: true }),
    valued({ closedAt: now - 2 * 86400, netAprFraction: Number.POSITIVE_INFINITY }),
  ];
  const band = buildCohortBand(vs, POOL, { windowDays: 30, nowSeconds: now, minDaysOpen: 1 });
  assert.equal(band.n, 2);
  assert.equal(band.excluded, 4);
  assert.deepEqual(band.excludedReasons, {
    unpriced: 0, ambiguous_entry: 1, short_position: 0, dust_principal: 0, absurd_outcome: 3,
  });
  assert.ok(Math.abs(band.p90) <= MAX_ABS_NET_APR * 100);
});

test("buildCohortBand: principal weighting shifts the band toward big positions", () => {
  const now = T0 + 40 * 86400;
  const vs = [
    valued({ closedAt: now - 2 * 86400, netAprFraction: 0.05, principalUsd: 100000, outUsd: 0 }),
    valued({ closedAt: now - 2 * 86400, netAprFraction: 3.0, principalUsd: 10, outUsd: 0 }),
    valued({ closedAt: now - 2 * 86400, netAprFraction: 2.0, principalUsd: 10, outUsd: 0 }),
  ];
  const band = buildCohortBand(vs, POOL, { windowDays: 30, nowSeconds: now, minDaysOpen: 1 });
  assert.equal(band.p50, 5); // the $100k position IS the weighted median
  assert.equal(band.medianUnweighted, 200); // transparency figure tells the other story
});

test("buildCohortBand: other pools never leak in", () => {
  const now = T0 + 10 * 86400;
  const other = ("0x" + "cc".repeat(32)) as Hex;
  const vs = [valued({ closedAt: now - 86400, poolId: other })];
  const band = buildCohortBand(vs, POOL, { windowDays: 30, nowSeconds: now, minDaysOpen: 1 });
  assert.equal(band.n, 0);
  assert.ok(Number.isNaN(band.p50));
});
