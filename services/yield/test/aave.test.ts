import assert from "node:assert/strict";
import { test } from "node:test";
import { AAVE_V3, BASE_TOKENS, keccak256Hex } from "@zyo/shared";
import {
  AaveDecodeError,
  AaveSource,
  decodeReserve,
  RESERVE_CONFIG_WORDS,
  RESERVE_DATA_WORDS,
  SEL_GET_RESERVE_CONFIGURATION_DATA,
  SEL_GET_RESERVE_DATA,
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

function makeTransport(overrides?: TransportOverrides) {
  const counts = { calls: 0 };
  const answer = (params: unknown[]): string => {
    const { to, data } = params[0] as { to: string; data: string };
    counts.calls++;
    assert.equal(to.toLowerCase(), AAVE_V3.poolDataProvider.toLowerCase(), "every read targets the verified PoolDataProvider");
    const sel = data.slice(0, 10);
    const asset = ("0x" + data.slice(10).slice(24)).toLowerCase();
    const broken = overrides?.break?.(sel, asset);
    if (broken !== undefined) return broken;
    const f = { ...FIX[asset]!, ...(overrides?.reserves?.[asset] ?? {}) };
    if (sel === SEL_GET_RESERVE_DATA) return reserveDataWords(f);
    if (sel === SEL_GET_RESERVE_CONFIGURATION_DATA) return configWords(f);
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
  // 2 calls per reserve × 3 reserves, one batch
  assert.equal(t.counts.calls, 6);
});

test("STRICT decoding: short, empty, non-hex or over-long returns throw — nothing reads as zero", () => {
  const usdc = BASE_TOKENS.USDC.address.toLowerCase() as Address;
  const f = FIX[usdc]!;
  assert.throws(() => decodeReserve("USDC", usdc, "0x", configWords(f)), AaveDecodeError);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f).slice(0, -64), configWords(f)), /expected 12 words, got 11/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f) + "00".repeat(32), configWords(f)), /expected 12 words, got 13/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), "0x" + "zz".repeat(32 * 10)), /non-hex/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), configWords(f).slice(0, -64)), /expected 10 words, got 9/);
  assert.throws(() => strictWords(undefined, 1, "x"), /empty return/);
});

test("STRICT decoding: implausible words (bool ≠ 0/1, bps > 10000, rate > 1 ray, bonus out of range) throw", () => {
  const usdc = BASE_TOKENS.USDC.address.toLowerCase() as Address;
  const f = FIX[usdc]!;
  const cfgWords = configWords(f).slice(2).match(/.{64}/g)!;
  const rdWords = reserveDataWords(f).slice(2).match(/.{64}/g)!;
  const patch = (arr: string[], i: number, v: bigint) => "0x" + arr.map((w, j) => (j === i ? word(v) : w)).join("");
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 5, 2n)), /bool word is 2/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 2, 10_001n)), /> 10000/);
  assert.throws(() => decodeReserve("USDC", usdc, reserveDataWords(f), patch(cfgWords, 3, 9_000n)), /liquidationBonus/);
  assert.throws(() => decodeReserve("USDC", usdc, patch(rdWords, 6, RAY + 1n), configWords(f)), /exceeds 1 ray/);
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
