import type { Strategy } from "@zyo/shared";

/** Demo strategies shown on the dashboard until the agent API is wired. */
export const MOCK_STRATEGIES: Strategy[] = [
  {
    id: "strat-a41f",
    owner: {
      baseAddress: "0x7C3aE2f6bE85731F0AF1D4b7cF74c88F9C1d2E11",
      zcashAddress: "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX", // checksum-valid test vector (hash160 = sha256("oilskin-test-vector-1")[0..20])
    },
    mode: "FULL_STRATEGY",
    status: "ACTIVE_FULL",
    rewardPreference: "SEND_TO_ZCASH",
    lending: {
      mcaId: "mca-7c3ae2f6.near",
      suppliedZecAtomic: "2500000000", // 25 ZEC
      borrowedAsset: "USDC",
      borrowedAmountAtomic: "437500000", // $437.50
      targetLtvBps: 3500,
      healthFactor: 2.0,
    },
    lp: {
      protocol: "SNUGGLEFI",
      poolId: "aero-usdc-weth-5",
      vaultPositionId: 1,
      depositToken: "USDC",
      depositAmountAtomic: "437500000",
      params: { rangeWidthBps: 800, rebalanceDelayHours: 12, autoCompoundEnabled: true },
      inRange: true,
      pendingRewardsUsd: 18.42,
    },
    createdAt: "2026-07-21T14:03:00Z",
    updatedAt: "2026-08-05T15:12:00Z",
  },
  {
    id: "strat-b7d2",
    owner: { zcashAddress: "t1Vt91RNqhwFheyN6PYzJs57PMGoyWzR34D" },
    mode: "SIMPLE_LENDING",
    status: "ACTIVE_SIMPLE",
    rewardPreference: "COMPOUND",
    lending: {
      mcaId: "mca-91bb04d1.near",
      suppliedZecAtomic: "800000000", // 8 ZEC
      healthFactor: Infinity,
    },
    createdAt: "2026-08-01T09:40:00Z",
    updatedAt: "2026-08-05T15:12:00Z",
  },
];

export const MOCK_ZEC_PRICE = 48.75;
export const MOCK_SUPPLY_APY = 3.1;

/**
 * Placeholder APRs keyed by curated pool id (v2 registry). Real figures come
 * from the engine/aggregator once the data pipeline is wired.
 */
export const MOCK_POOL_APRS: Record<string, number> = {
  "uni-weth-usdc-5": 18.4,
  "aero-cbbtc-usdc": 31.7,
  "aero-usdc-weth-5": 24.6,
  "uni-cbbtc-weth-30": 12.4,
  "uni-usdc-weth-30": 14.9,
  "uni-usdc-cbbtc-30": 9.8,
  "aero-usdt-usdc": 6.2,
  "cbeth-weth": 5.1,
  "aero-aero-weth": 41.2,
  "aero-aero-cbbtc": 33.5,
};
