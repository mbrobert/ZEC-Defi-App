/**
 * ONE GENERATED SOURCE. scripts/lp-sim.py wrote samples/lp-model-2026-09-05.json
 * (and /tmp/build/MODEL-NUMBERS.md) from the recorded gauge words, the
 * recorded σ, the shared presets/fees, and the live Aave inputs of
 * 2026-09-05. This suite feeds the SAME raw words through the TypeScript
 * gauge source and gate and asserts every served cell equals the sim's
 * closed-form cell to 0.01 pt — so the service, the sim and the web (which
 * pins to the markdown) cannot drift apart. It also asserts that
 * samples/model-inputs.json still matches what @zyo/shared exports today.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CURATED_POOLS, ENTRY_HF_FLOOR, FEES, LTV_PRESET_FIXED_BPS, MAX_OFFERED_LTV_CAP_BPS, RANGE_PRESETS, poolById } from "@zyo/shared";
import { evaluateGate } from "../src/gate.js";
import { ENGINE_FEE_BPS, SETTINGS } from "../src/model.js";
import { GaugeSource, onchainToken1, SEL } from "../src/sources/gauges.js";
import { RpcClient } from "../src/sources/rpc.js";
import type { Address, EmissionsSample } from "../src/types.js";
import { MIN_STAKED_SAMPLES } from "../src/sources/gauges.js";
import { mcCalibrationFixture, NOW_S, ratesFixture, reserve, volatilityFixture } from "./fixtures/model.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const MODEL = read("../../samples/lp-model-2026-09-05.json") as {
  inputs: { borrowAprPct: number; collateral: Record<string, { supplyAprPct: number; liquidationThresholdBps: number }>; gaugeSample: { sampledAt: string } };
  results: Record<string, Record<string, {
    rangeWidthBps: number; emissionsGrossPct?: number; emissionsNetPct?: number; emissionsRealizedPct?: number; dragPct?: number;
    lpNetPct?: number | null; mcLpNetPct?: number | null; qualifies?: boolean; reason?: string | null; breakEvenSigma?: number | null; breakEvenEmissionsMultiple?: number | null;
    userNet?: Record<string, Record<string, { ltvBps: number; offerable: boolean; userNetPct: number }>>;
  }>>;
  validation: { ok: boolean; neverMorePermissiveThanMc: boolean; affineErrorPct: number; deltaPct: number; tolerancePct: number }[];
  boundaryGuard: { pool: string; setting: string; optimismPct: number; offeredByClosedFormAlone: boolean; offeredByServedGate: boolean }[];
  verdict: { clears: unknown[] };
};
const SAMPLE = read("../../samples/gauge-emissions-2026-09-05-composite.json") as {
  aeroUsd: number;
  pools: Record<string, { pool: string; gauge: string; rewardRateWeiPerSec: string; periodFinish: number; sqrtPriceX96: string; stakedLiquidity: string | null; poolTvlUsd: number; token1Usd: number; dec1: number; feeBpsLive: number; token0: string; token1: string }>;
};
const INPUTS = read("../../samples/model-inputs.json") as {
  settings: { id: string; preset: string; rangeWidthBps: Record<string, number>; rebalanceDelayHours: number }[];
  fees: { performanceBps: number; engineFeeBps: number };
  ltv: { entryHfFloor: number; maxOfferedLtvCapBps: number; fixedBps: Record<string, number> };
  pools: Record<string, { protocol: string; pairClass: string }>;
};

const word = (v: bigint) => v.toString(16).padStart(64, "0");

/** Replay one pool's recorded words through the real GaugeSource over a mocked JSON-RPC. */
async function emissionsFromWords(poolId: string): Promise<EmissionsSample> {
  const s = SAMPLE.pools[poolId]!;
  const pool = s.pool.toLowerCase();
  const gauge = s.gauge.toLowerCase();
  const answer = (params: unknown[]): string => {
    const { to, data } = params[0] as { to: string; data: string };
    const sel = data.slice(0, 10);
    const target = to.toLowerCase();
    if (sel === SEL.gauges) return `0x${gauge.slice(2).padStart(64, "0")}`;
    if (target === gauge && sel === SEL.rewardRate) return `0x${word(BigInt(s.rewardRateWeiPerSec))}`;
    if (target === gauge && sel === SEL.periodFinish) return `0x${word(BigInt(s.periodFinish))}`;
    if (target === pool && sel === SEL.slot0) return `0x${word(BigInt(s.sqrtPriceX96))}${word(0n)}${word(0n)}${word(1n)}${word(1n)}${word(1n)}`;
    if (target === pool && sel === SEL.stakedLiquidity) return `0x${word(BigInt(s.stakedLiquidity ?? "0"))}`;
    if (target === pool && sel === SEL.fee) return `0x${word(BigInt(Math.round(s.feeBpsLive * 100)))}`;
    throw new Error(`unexpected ${to} ${sel}`);
  };
  const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { id: number; params: unknown[] } | { id: number; params: unknown[] }[];
    const reply = (r: { id: number; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(r.params) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));
  const curated = poolById(poolId)!;
  const t1 = onchainToken1(curated.token0, curated.token1)!;
  assert.equal(t1.address, s.token1.toLowerCase(), `${poolId}: token1 identity`);
  assert.equal(t1.decimals, s.dec1, `${poolId}: token1 decimals`);
  // The 08-31 sample was taken with an active epoch; evaluate at that instant.
  const nowSeconds = Math.floor(Date.parse(MODEL.inputs.gaugeSample.sampledAt) / 1000);
  // Sample MIN_STAKED_SAMPLES times: identical readings ARE corroboration, and
  // until the anchor is corroborated the source publishes no APR at all.
  let out!: EmissionsSample;
  for (let i = 0; i < MIN_STAKED_SAMPLES; i++) {
    out = await src.sample(poolId, pool as Address, { aeroUsd: SAMPLE.aeroUsd, poolTvlUsd: s.poolTvlUsd, token1Usd: s.token1Usd, token1Decimals: s.dec1, nowSeconds });
  }
  return out;
}

test("samples/model-inputs.json matches @zyo/shared and the model today (drift fails the build)", () => {
  assert.deepEqual(
    INPUTS.settings,
    SETTINGS.map((s) => ({ id: s.id, preset: s.preset, rangeWidthBps: { ...RANGE_PRESETS.find((p) => p.preset === s.preset)!.rangeWidthBps }, rebalanceDelayHours: s.rebalanceDelayHours }))
  );
  assert.deepEqual(INPUTS.fees, { performanceBps: FEES.performanceBps, engineFeeBps: ENGINE_FEE_BPS });
  assert.deepEqual(INPUTS.ltv, { entryHfFloor: ENTRY_HF_FLOOR, maxOfferedLtvCapBps: MAX_OFFERED_LTV_CAP_BPS, fixedBps: { ...LTV_PRESET_FIXED_BPS } });
  for (const p of CURATED_POOLS.filter((x) => x.dex === "AERODROME")) {
    assert.equal(INPUTS.pools[p.id]!.protocol, p.protocol, p.id);
    assert.equal(INPUTS.pools[p.id]!.pairClass, p.pairClass, p.id);
  }
});

test("the sim's own validation passed (affine calibration exact, closed form within a tolerance BELOW the borrow rate, gate never more permissive than the MC) and nothing clears at 4.828 %", () => {
  assert.ok(MODEL.validation.length >= 8);
  assert.ok(MODEL.validation.every((v) => v.ok && v.neverMorePermissiveThanMc));
  // FIX D-HIGH-1: the declared model error may never reach the rate it decides against.
  for (const v of MODEL.validation) {
    assert.ok(v.tolerancePct < MODEL.inputs.borrowAprPct, `tolerance ${v.tolerancePct} ≥ borrow ${MODEL.inputs.borrowAprPct}`);
    assert.ok(Math.abs(v.deltaPct) <= v.tolerancePct);
    assert.ok(v.affineErrorPct < 0.01, `affine error ${v.affineErrorPct} — the calibration must be exact, not fitted`);
  }
  assert.equal(MODEL.inputs.borrowAprPct, 4.828);
  assert.deepEqual(MODEL.verdict.clears, []);
});

test("every served cell reproduces the generated model to 0.01 pt: emissions, drag, lpNet, verdict, user net per collateral × LTV", async () => {
  const sampledAt = Date.parse(MODEL.inputs.gaugeSample.sampledAt);
  const nowSeconds = Math.floor(sampledAt / 1000);
  const collateral = Object.fromEntries(
    Object.entries(MODEL.inputs.collateral).map(([sym, c]) => [sym, reserve(sym, { supplyAprPct: c.supplyAprPct, liquidationThresholdBps: c.liquidationThresholdBps })])
  );
  const rates = { ...ratesFixture({ collateral, borrow: reserve("USDC", { variableBorrowAprPct: MODEL.inputs.borrowAprPct }) }, sampledAt), stale: false };
  const vol = volatilityFixture();
  const MC = mcCalibrationFixture();
  let cells = 0;
  for (const [poolId, perSetting] of Object.entries(MODEL.results)) {
    const pool = poolById(poolId)!;
    const emissions = { ...(await emissionsFromWords(poolId)), stale: false };
    for (const setting of SETTINGS) {
      const cell = perSetting[setting.id]!;
      for (const sym of Object.keys(MODEL.inputs.collateral)) {
        const v = evaluateGate({ pool, setting, collateral: sym as "cbBTC" | "WETH", rates, emissions, volatility: vol, mcCalibration: MC, nowSeconds });
        cells++;
        assert.equal(v.rangeWidthBps, cell.rangeWidthBps, `${poolId}/${setting.id} width`);
        if (cell.emissionsGrossPct !== undefined) {
          assert.ok(Math.abs((v.emissionsGrossPct ?? 0) - cell.emissionsGrossPct) < 0.011, `${poolId}/${setting.id} gross ${v.emissionsGrossPct} vs ${cell.emissionsGrossPct}`);
        }
        if (cell.lpNetPct !== null && cell.lpNetPct !== undefined && cell.reason !== "emissions_below_borrow") {
          assert.ok(Math.abs(v.lpNetPct! - cell.lpNetPct) < 0.011, `${poolId}/${setting.id} lpNet ${v.lpNetPct} vs ${cell.lpNetPct}`);
          assert.ok(Math.abs(v.dragPct! - cell.dragPct!) < 0.011, `${poolId}/${setting.id} drag`);
          assert.ok(Math.abs(v.emissionsRealizedPct! - cell.emissionsRealizedPct!) < 0.011, `${poolId}/${setting.id} realized`);
          assert.equal(v.qualifies, cell.qualifies, `${poolId}/${setting.id}/${sym} verdict`);
          if (cell.breakEvenEmissionsMultiple != null) {
            assert.ok(Math.abs(v.breakEvenEmissionsMultiple! - cell.breakEvenEmissionsMultiple) < 0.011, `${poolId}/${setting.id} break-even multiple`);
          }
          if (cell.breakEvenSigma != null) {
            assert.ok(Math.abs(v.breakEvenSigma! - cell.breakEvenSigma) < 0.011, `${poolId}/${setting.id} break-even σ`);
          }
          // The MC-calibrated number the GATE decides on must also reproduce.
          assert.ok(
            Math.abs(v.mcLpNetPct! - cell.mcLpNetPct!) < 0.011,
            `${poolId}/${setting.id} mcLpNet ${v.mcLpNetPct} vs ${cell.mcLpNetPct}`
          );
          const expectedUser = cell.userNet![sym]!;
          for (const u of v.userNet) {
            const e = Object.values(expectedUser).find((x) => x.ltvBps === u.ltvBps)!;
            assert.ok(e, `${poolId}/${setting.id}/${sym} ltv ${u.ltvBps} present in the model`);
            assert.equal(u.offerable, e.offerable);
            assert.ok(Math.abs(u.userNetPct - e.userNetPct) < 0.011, `${poolId}/${setting.id}/${sym}@${u.ltvBps}: ${u.userNetPct} vs ${e.userNetPct}`);
          }
        } else {
          assert.equal(v.qualifies, false, `${poolId}/${setting.id}/${sym}`);
          assert.equal(v.reason, cell.reason ?? v.reason, `${poolId}/${setting.id}/${sym} reason`);
        }
      }
    }
  }
  assert.equal(cells, Object.keys(MODEL.results).length * SETTINGS.length * Object.keys(MODEL.inputs.collateral).length);
});

test("the cbZEC/USDC entry of the composite sample yields no emissions through the real source", async () => {
  const e = await emissionsFromWords("aero-cbzec-usdc");
  assert.equal(e.epochActive, false);
  assert.equal(e.rewardRateWeiPerSec, "0");
  assert.equal(e.wholePoolAprPct, 0);
  assert.ok(Object.values(e.aprByWidthPct!).every((x) => x === 0));
});
