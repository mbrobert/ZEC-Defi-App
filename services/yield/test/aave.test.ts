import assert from "node:assert/strict";
import { test } from "node:test";
import { AAVE_V3, BASE_TOKENS, keccak256Hex } from "@zyo/shared";
import {
  AaveDecodeError,
  AaveSource,
  decodeReserve,
  RESERVE_CONFIG_WORDS,
  RESERVE_DATA_WORDS,
  SEL_GET_INTEREST_RATE_DATA_BPS,
  SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS,
  SEL_GET_PAUSED,
  SEL_GET_RESERVE_CONFIGURATION_DATA,
  SEL_GET_RESERVE_DATA,
  RATE_DATA_WORDS,
  decodeBorrowCurve,
  decodeStrategyAddress,
  strictWords,
} from "../src/sources/aave.js";
import { RpcClient } from "../src/sources/rpc.js";
import type { Address } from "../src/types.js";

/**
 * Fixture words reproduce docs/VERIFIED-BASE-FACTS.md (read live 2026-09-05):
 *   USDC  variable borrow 4.828 %, supply 3.921 %, LTV 75.00 %, LT 78.00 %, bonus 5.0 %
 *   cbBTC variable borrow 0.673 %, supply 0.012 %, LTV 73.00 %, LT 78.00 %, bonus 7.5 %
 *   WETH  variable borrow 2.454 %, supply 1.843 %, LTV 80.00 %, LT 83.00 %, bonus 5.0 %
 * Rates are encoded as ray (1e27 = 100 %); the configuration tuple in bps
 * with Aave's 10000+bonus convention.
 */
const RAY = 10n ** 27n;
const pctToRay = (pct: number) => (BigInt(Math.round(pct * 1_000_000)) * RAY) / 100_000_000n;
const word = (v: bigint) => v.toString(16).padStart(64, "0");

interface ReserveFixture {
  supplyPct: number;
  borrowPct: number;
  ltv: number;
  lt: number;
  bonus: number; // Aave word (10750 = 7.5 %)
  collateral?: boolean;
  borrowable?: boolean;
  active?: boolean;
  frozen?: boolean;
  /** PoolDataProvider.getPaused(asset) — a separate call, not in the config tuple. */
  paused?: boolean;
}

function reserveDataWords(f: ReserveFixture): string {
  // (unbacked, accruedToTreasuryScaled, totalAToken, totalStableDebt,
  //  totalVariableDebt, liquidityRate, variableBorrowRate, stableBorrowRate,
  //  averageStableBorrowRate, liquidityIndex, variableBorrowIndex, lastUpdateTimestamp)
  const w = [0n, 0n, 10n ** 12n, 0n, 5n * 10n ** 11n, pctToRay(f.supplyPct), pctToRay(f.borrowPct), 0n, 0n, RAY, RAY, 1_757_030_400n];
  assert.equal(w.length, RESERVE_DATA_WORDS);
  return "0x" + w.map(word).join("");
}

function configWords(f: ReserveFixture): string {
  // (decimals, ltv, liquidationThreshold, liquidationBonus, reserveFactor,
  //  usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen)
  const b = (x: boolean | undefined, d: boolean) => ((x ?? d) ? 1n : 0n);
  const w = [6n, BigInt(f.ltv), BigInt(f.lt), BigInt(f.bonus), 1000n, b(f.collateral, true), b(f.borrowable, true), 0n, b(f.active, true), b(f.frozen, false)];
  assert.equal(w.length, RESERVE_CONFIG_WORDS);
  return "0x" + w.map(word).join("");
}

function pausedWord(f: ReserveFixture): string {
  return "0x" + word(f.paused ? 1n : 0n);
}
/** The un-paused answer, for the pure decodeReserve cases. */
const PAUSED_FALSE = "0x" + word(0n);

const FIX: Record<string, ReserveFixture> = {
  [BASE_TOKENS.USDC.address.toLowerCase()]: { supplyPct: 3.921, borrowPct: 4.828, ltv: 7500, lt: 7800, bonus: 10500 },
  [BASE_TOKENS.cbBTC.address.toLowerCase()]: { supplyPct: 0.012, borrowPct: 0.673, ltv: 7300, lt: 7800, bonus: 10750 },
  [BASE_TOKENS.WETH.address.toLowerCase()]: { supplyPct: 1.843, borrowPct: 2.454, ltv: 8000, lt: 8300, bonus: 10500 },
};

/** JSON-RPC transport answering PoolDataProvider calls from the fixture. */
interface TransportOverrides {
  reserves?: Partial<Record<string, Partial<ReserveFixture>>>;
  break?: (sel: string, asset: string) => string | undefined;
}

/**
 * The USDC strategy on Base, read 2026-09-12 at block 51,227,701 (docs/VERIFIED-BASE-FACTS.md
 * Addendum 13): DefaultReserveInterestRateStrategyV2 0x86AB…bDC5 answering
 * getInterestRateDataBps(USDC) = (9000, 0, 470, 1000).
 */
const STRATEGY = "0x86ab1c62a8bf868e1b3e1ab87d587aba6fbcbdc5";
const CURVE_WORDS = [9000n, 0n, 470n, 1000n];
function rateDataWords(): string {
  assert.equal(CURVE_WORDS.length, RATE_DATA_WORDS);
  return "0x" + CURVE_WORDS.map(word).join("");
}
const STRATEGY_WORD = "0x" + STRATEGY.slice(2).padStart(64, "0");

function makeTransport(overrides?: TransportOverrides) {
  const counts = { calls: 0, strategyCalls: 0 };
  const answer = (params: unknown[]): string => {
    const { to, data } = params[0] as { to: string; data: string };
    counts.calls++;
    const sel = data.slice(0, 10);
    const asset = ("0x" + data.slice(10).slice(24)).toLowerCase();
    const broken = overrides?.break?.(sel, asset);
    if (broken !== undefined) return broken;
    if (to.toLowerCase() === STRATEGY) {
      // The one call that leaves the PoolDataProvider: the strategy's own curve, for the borrow asset only.
      counts.strategyCalls++;
      assert.equal(sel, SEL_GET_INTEREST_RATE_DATA_BPS, "the strategy is asked only for its rate data");
      assert.equal(asset, BASE_TOKENS.USDC.address.toLowerCase(), "the curve is read for the borrow asset");
      return rateDataWords();
    }
    assert.equal(to.toLowerCase(), AAVE_V3.poolDataProvider.toLowerCase(), "every other read targets the verified PoolDataProvider");
    const f = { ...FIX[asset]!, ...(overrides?.reserves?.[asset] ?? {}) };
    if (sel === SEL_GET_RESERVE_DATA) return reserveDataWords(f);
    if (sel === SEL_GET_RESERVE_CONFIGURATION_DATA) return configWords(f);
    if (sel === SEL_GET_PAUSED) return pausedWord(f);
    if (sel === SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS) {
      assert.equal(asset, BASE_TOKENS.USDC.address.toLowerCase(), "the strategy is looked up for the borrow asset");
      return STRATEGY_WORD;
    }
    throw new Error(`unexpected selector ${sel}`);
  };
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const reply = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(r.params) });
    const out = Array.isArray(body) ? body.map(reply) : reply(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, counts };
}

const NOW = Date.UTC(2026, 8, 5, 1, 0, 0);
function source(t: ReturnType<typeof makeTransport>): AaveSource {
  return new AaveSource(new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 }), () => NOW);
}

test("selectors are keccak prefixes of the PoolDataProvider signatures (vendored keccak)", () => {
  assert.equal(SEL_GET_RESERVE_DATA, "0x" + keccak256Hex("getReserveData(address)").slice(0, 8));
  assert.equal(SEL_GET_RESERVE_CONFIGURATION_DATA, "0x" + keccak256Hex("getReserveConfigurationData(address)").slice(0, 8));
  assert.equal(SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS, "0x" + keccak256Hex("getInterestRateStrategyAddress(address)").slice(0, 8));
  assert.equal(SEL_GET_INTEREST_RATE_DATA_BPS, "0x" + keccak256Hex("getInterestRateDataBps(address)").slice(0, 8));
});

test("sample reproduces the verified 2026-09-05 facts: USDC borrow 4.828 %, cbBTC LT 7800, WETH LT 8300", async () => {
  const t = makeTransport();
  const s = await source(t).sample();
  assert.equal(s.source, "aave-v3-base");
  assert.equal(s.dataProvider, AAVE_V3.poolDataProvider.toLowerCase());
  assert.equal(s.borrow.symbol, "USDC");
  assert.equal(s.borrow.variableBorrowAprPct, 4.828);
  assert.equal(s.borrow.supplyAprPct, 3.921);
  assert.equal(s.collateral.cbBTC!.liquidationThresholdBps, 7800);
  assert.equal(s.collateral.cbBTC!.ltvBps, 7300);
  assert.equal(s.collateral.cbBTC!.liquidationBonusBps, 750);
  assert.equal(s.collateral.cbBTC!.supplyAprPct, 0.012);
  assert.equal(s.collateral.WETH!.liquidationThresholdBps, 8300);
  assert.equal(s.collateral.WETH!.supplyAprPct, 1.843);
  assert.equal(s.collateral.WETH!.usageAsCollateralEnabled, true);
  // cbZEC is disabled in the registry → never read (it is not an Aave reserve)
  assert.equal(s.collateral.cbZEC, undefined);
  assert.equal(s.sampledAt, new Date(NOW).toISOString());
  // no `stale` field is ever stored on a sample
  assert.equal("stale" in s, false);
  // 3 calls per reserve (data + config + getPaused) × 3 reserves, one batch
  assert.equal(t.counts.calls, 11, "3 reserves × 3 reads + the strategy address + its rate data (A3, 2026-09-12)");
  assert.equal(s.borrow.isPaused, false);
});

test("STRICT decoding: short, empty, non-hex or over-long returns throw — nothing reads as zero", () => {
  const usdc = BASE_TOKENS.USDC.address.toLowerCase() as Address;
  const f = FIX[usdc]!;
  assert.throws(() => decodeReserve("USDC", usdc, "0x", configWords(f), PAUSED_FALSE), AaveDecodeError);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f).slice(0, -64), configWords(f), PAUSED_FALSE), /expected 12 words, got 11/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f) + "00".repeat(32), configWords(f), PAUSED_FALSE), /expected 12 words, got 13/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), "0x" + "zz".repeat(32 * 10), PAUSED_FALSE), /non-hex/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), configWords(f).slice(0, -64), PAUSED_FALSE), /expected 10 words, got 9/);
  assert.throws(() => strictWords(undefined, 1, "x"), /empty return/);
});

test("STRICT decoding: implausible words (bool ≠ 0/1, bps > 10000, rate > 1 ray, bonus out of range) throw", () => {
  const usdc = BASE_TOKENS.USDC.address.toLowerCase() as Address;
  const f = FIX[usdc]!;
  const cfgWords = configWords(f).slice(2).match(/.{64}/g)!;
  const rdWords = reserveDataWords(f).slice(2).match(/.{64}/g)!;
  const patch = (arr: string[], i: number, v: bigint) => "0x" + arr.map((w, j) => (j === i ? word(v) : w)).join("");
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 5, 2n), PAUSED_FALSE), /bool word is 2/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 2, 10_001n), PAUSED_FALSE), /> 10000/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 3, 9_000n), PAUSED_FALSE), /liquidationBonus/);
  assert.throws(() => decodeReserve("USDC", usdc, patch(rdWords, 6, RAY + 1n), configWords(f), PAUSED_FALSE), /exceeds 1 ray/);
});

test("sample fails CLOSED when any reserve is unreadable — no half-read sample is ever produced", async () => {
  const weth = BASE_TOKENS.WETH.address.toLowerCase();
  const t = makeTransport({ break: (sel, asset) => (asset === weth && sel === SEL_GET_RESERVE_DATA ? "0x" : undefined) });
  await assert.rejects(() => source(t).sample(), /WETH.getReserveData: empty return/);
  const t2 = makeTransport({ break: () => "0x" + "00".repeat(32) }); // every call one word
  await assert.rejects(() => source(t2).sample(), AaveDecodeError);
});

test("sample refuses to quote a borrow rate when the borrow reserve is frozen / not borrowable", async () => {
  const usdc = BASE_TOKENS.USDC.address.toLowerCase();
  await assert.rejects(() => source(makeTransport({ reserves: { [usdc]: { frozen: true } } })).sample(), /not borrowable/);
  await assert.rejects(() => source(makeTransport({ reserves: { [usdc]: { borrowable: false } } })).sample(), /not borrowable/);
});

test("collateral flags are carried verbatim so the gate can refuse a frozen collateral", async () => {
  const cbbtc = BASE_TOKENS.cbBTC.address.toLowerCase();
  const s = await source(makeTransport({ reserves: { [cbbtc]: { frozen: true, collateral: false } } })).sample();
  assert.equal(s.collateral.cbBTC!.isFrozen, true);
  assert.equal(s.collateral.cbBTC!.usageAsCollateralEnabled, false);
});

test("an RPC transport error propagates (the server keeps the previous sample, served stale)", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 502 })) as typeof fetch;
  const src = new AaveSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));
  await assert.rejects(() => src.sample());
});

test("A3: the sample carries the borrow reserve's curve and totals — read from the strategy the Pool names, strictly", async () => {
  const t = makeTransport();
  const s = await source(t).sample();
  assert.equal(t.counts.strategyCalls, 1, "one call to the strategy, after its address came from the PoolDataProvider");
  assert.deepEqual(s.borrowCurve, { strategy: STRATEGY, optimalUsageBps: 9000, baseVariableBorrowRateBps: 0, variableRateSlope1Bps: 470, variableRateSlope2Bps: 1000 });
  // getReserveData words 2 and 4 from the fixture, and the config's decimals word.
  assert.equal(s.borrow.totalATokenUnits, (10n ** 12n).toString());
  assert.equal(s.borrow.totalVariableDebtUnits, (5n * 10n ** 11n).toString());
  assert.equal(s.borrow.decimals, 6);
  // Strict decoding: a short curve, a zero optimal usage, a zero strategy address, debt above supply — all refuse.
  assert.throws(() => decodeBorrowCurve(STRATEGY as Address, "0x" + [9000n, 0n, 470n].map(word).join("")), AaveDecodeError);
  assert.throws(() => decodeBorrowCurve(STRATEGY as Address, "0x" + [0n, 0n, 470n, 1000n].map(word).join("")), AaveDecodeError);
  assert.throws(() => decodeStrategyAddress("0x" + word(0n)), AaveDecodeError);
  const debtAboveSupply = makeTransport({ break: (sel, asset) => (sel === SEL_GET_RESERVE_DATA && asset === BASE_TOKENS.USDC.address.toLowerCase()
    ? "0x" + [0n, 0n, 10n ** 12n, 0n, 2n * 10n ** 12n, pctToRay(3.9), pctToRay(4.8), 0n, 0n, RAY, RAY, 1_757_030_400n].map(word).join("")
    : undefined) });
  await assert.rejects(source(debtAboveSupply).sample(), AaveDecodeError);
  // A strategy that does not answer fails the WHOLE sample: the gate keeps serving the previous one, stale.
  const mute = makeTransport({ break: (sel) => (sel === SEL_GET_INTEREST_RATE_DATA_BPS ? "0x" : undefined) });
  await assert.rejects(source(mute).sample(), AaveDecodeError);
});
