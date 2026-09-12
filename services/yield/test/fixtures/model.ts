/**
 * Model-side fixtures: an Aave rates sample carrying the VERIFIED 2026-09-05
 * facts, emissions samples in the service's own shape, and the recorded
 * volatility inputs. Nothing here is a number the code could not have read.
 */

import { readFileSync } from "node:fs";
import { AAVE_V3, BASE_TOKENS } from "@zyo/shared";
import { calibrationIndex, loadMcCalibration, type McCalibration, type McCalibrationCell } from "../../src/mc-calibration.js";
import type { VolatilityInputs } from "../../src/config.js";
import type { AaveBorrowCurve, AaveRatesSample, AaveReserve, Address, EmissionsSample } from "../../src/types.js";

export const NOW_MS = Date.UTC(2026, 8, 5, 1, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

export function reserve(symbol: string, over: Partial<AaveReserve> = {}): AaveReserve {
  const table: Record<string, Partial<AaveReserve>> = {
    USDC: { address: BASE_TOKENS.USDC.address.toLowerCase() as Address, supplyAprPct: 3.921, variableBorrowAprPct: 4.828, ltvBps: 7500, liquidationThresholdBps: 7800, liquidationBonusBps: 500 },
    cbBTC: { address: BASE_TOKENS.cbBTC.address.toLowerCase() as Address, supplyAprPct: 0.012, variableBorrowAprPct: 0.673, ltvBps: 7300, liquidationThresholdBps: 7800, liquidationBonusBps: 750 },
    WETH: { address: BASE_TOKENS.WETH.address.toLowerCase() as Address, supplyAprPct: 1.843, variableBorrowAprPct: 2.454, ltvBps: 8000, liquidationThresholdBps: 8300, liquidationBonusBps: 500 },
  };
  const base = table[symbol] as Omit<AaveReserve, "symbol" | "usageAsCollateralEnabled" | "borrowingEnabled" | "isActive" | "isFrozen">;
  // Reserve totals from PoolDataProvider.getReserveData at Base block 51,227,701 (2026-09-12 20:25 UTC,
  // docs/VERIFIED-BASE-FACTS.md Addendum 13): USDC supplied 182,806,571.520498, variable debt
  // 158,038,067.327137 (86.45 % utilisation, live rate 4.5146 %). The collateral reserves carry
  // stand-in totals — nothing in the model reads them.
  const totals: Record<string, { decimals: number; totalATokenUnits: string; totalVariableDebtUnits: string }> = {
    USDC: { decimals: 6, totalATokenUnits: "182806571520498", totalVariableDebtUnits: "158038067327137" },
    cbBTC: { decimals: 8, totalATokenUnits: "100000000000", totalVariableDebtUnits: "1000000000" },
    WETH: { decimals: 18, totalATokenUnits: "10000000000000000000000", totalVariableDebtUnits: "1000000000000000000000" },
  };
  return {
    ...base,
    ...totals[symbol]!,
    symbol,
    usageAsCollateralEnabled: true,
    borrowingEnabled: true,
    isActive: true,
    isFrozen: false,
    isPaused: false,
    ...over,
  };
}

/**
 * The USDC strategy's curve read live 2026-09-12 at block 51,227,701 (Addendum 13):
 * DefaultReserveInterestRateStrategyV2 0x86AB…bDC5, optimal usage 90 %, base 0, slope1 4.70 %,
 * slope2 10 % — which reproduces the live 4.5146 % from the totals above.
 */
export function borrowCurveFixture(over: Partial<AaveBorrowCurve> = {}): AaveBorrowCurve {
  return {
    strategy: "0x86ab1c62a8bf868e1b3e1ab87d587aba6fbcbdc5" as Address,
    optimalUsageBps: 9000,
    baseVariableBorrowRateBps: 0,
    variableRateSlope1Bps: 470,
    variableRateSlope2Bps: 1000,
    ...over,
  };
}

export function ratesFixture(over: Partial<AaveRatesSample> = {}, sampledAtMs = NOW_MS): AaveRatesSample {
  return {
    source: "aave-v3-base",
    dataProvider: AAVE_V3.poolDataProvider.toLowerCase() as Address,
    borrow: reserve("USDC"),
    collateral: { cbBTC: reserve("cbBTC"), WETH: reserve("WETH") },
    borrowCurve: borrowCurveFixture(),
    sampledAt: new Date(sampledAtMs).toISOString(),
    ...over,
  };
}

export function emissionsFixture(
  poolId: string,
  aprByWidthPct: Record<string, number> | null,
  over: Partial<EmissionsSample> = {},
  sampledAtMs = NOW_MS
): EmissionsSample {
  return {
    poolId,
    pool: ("0x" + "11".repeat(20)) as Address,
    gauge: ("0x" + "22".repeat(20)) as Address,
    rewardRateWeiPerSec: "340364640583415175",
    periodFinish: NOW_S + 5 * 86_400,
    epochActive: true,
    wholePoolAprPct: 65,
    aprByWidthPct,
    stakedLiquidity: "5678459724668201957",
    // A corroborated anchor: MIN_STAKED_SAMPLES independent readings have
    // agreed. Below that the gate refuses with `insufficient_samples`.
    samples: 3,
    corroborated: true,
    outlier: false,
    sqrtPriceX96: "3897149340279738881397267",
    feePips: 364,
    aeroUsd: 0.478,
    sampledAt: new Date(sampledAtMs).toISOString(),
    ...over,
  };
}

export function volatilityFixture(): VolatilityInputs {
  return JSON.parse(readFileSync(new URL("../../../samples/volatility.json", import.meta.url), "utf8")) as VolatilityInputs;
}

/**
 * The committed Monte-Carlo calibration (samples/mc-calibration.json), indexed
 * as the gate consumes it. `evaluateGate` requires this — with an empty index
 * every cell refuses `mc_calibration_unavailable`, which is the fail-closed
 * direction and is itself pinned in gate.test.ts.
 */
export function mcCalibrationFixture(): Map<string, McCalibrationCell> {
  return calibrationIndex(mcCalibrationDocFixture());
}

/** The calibration document itself, as the server loads it from samplesDir. */
export function mcCalibrationDocFixture(): McCalibration {
  const path = new URL("../../../samples/mc-calibration.json", import.meta.url).pathname;
  const doc = loadMcCalibration(path);
  if (!doc) throw new Error(`samples/mc-calibration.json missing — run \`npm run model\``);
  return doc;
}
