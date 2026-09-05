import { test } from "node:test";
import assert from "node:assert/strict";
import { AAVE_V3, BASE_TOKENS } from "@zyo/shared";
import { decodeReserve, readAccount, readMarket, safeMulticall, type ReadClient } from "../lib/reads";
import { DEMO_MARKET } from "../lib/demo";

/** Tuples exactly as Aave's PoolDataProvider returns them (VERIFIED-BASE-FACTS 2026-09-05). */
const CFG = {
  cbBTC: [8n, 7300n, 7800n, 10750n, 5000n, true, true, false, true, false],
  WETH: [18n, 8000n, 8300n, 10500n, 1500n, true, true, false, true, false],
  USDC: [6n, 7500n, 7800n, 10500n, 1000n, true, true, false, true, false],
  cbZEC: [0n, 0n, 0n, 0n, 0n, false, false, false, false, false],
} as const;
const ray = (pct: number) => BigInt(Math.round(pct * 1e6)) * 10n ** 19n; // pct → ray
const DATA = {
  cbBTC: [0n, 0n, 0n, 0n, 0n, ray(0.012), ray(0.673), 0n, 0n, 0n, 0n, 0n],
  WETH: [0n, 0n, 0n, 0n, 0n, ray(1.843), ray(2.454), 0n, 0n, 0n, 0n, 0n],
  USDC: [0n, 0n, 0n, 0n, 0n, ray(3.921), ray(4.828), 0n, 0n, 0n, 0n, 0n],
  cbZEC: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
} as const;
const PRICE = { cbBTC: 7_963_089_000_000n, WETH: 245_345_000_000n, USDC: 100_000_000n, cbZEC: 0n } as const;

type Sym = keyof typeof CFG;
const symOf = (addr: string): Sym => (Object.keys(BASE_TOKENS) as Sym[]).find((s) => BASE_TOKENS[s as keyof typeof BASE_TOKENS].address.toLowerCase() === addr.toLowerCase())!;

/** A fake viem client that answers the same calls the real one would. */
function fakeClient(opts: { multicallThrows?: boolean; deployed?: boolean; account?: string; positions?: bigint[]; log?: string[] } = {}): ReadClient {
  const answer = (c: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    opts.log?.push(c.functionName);
    const asset = symOf(String(c.args?.[0] ?? ""));
    switch (c.functionName) {
      case "getReserveConfigurationData":
        return [...CFG[asset]];
      case "getReserveData":
        return [...DATA[asset]];
      case "getAssetPrice":
        return PRICE[asset];
      case "balanceOf":
        return c.address.toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase() ? 123_000_000n : 0n;
      case "accountOf":
        return opts.account ?? "0x2222222222222222222222222222222222222222";
      case "getUserAccountData":
        return [3_981_544_500_000n, 1_592_617_800_000n, 1_313_509_000_000n, 7800n, 7300n, 1_950_000_000_000_000_000n];
      case "getUserReserveData": {
        const a = symOf(String(c.args?.[0]));
        if (a === "cbBTC") return [50_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true];
        if (a === "USDC") return [0n, 0n, 15_926_178_000n, 0n, 0n, 0n, 0n, 0n, false];
        return [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
      }
      case "positionsOf":
        return opts.positions ?? [7n, 9n];
      default:
        throw new Error(`unexpected ${c.functionName}`);
    }
  };
  return {
    async multicall({ contracts }) {
      if (opts.multicallThrows) throw new Error("multicall3 missing");
      return (contracts as { address: string; functionName: string; args?: readonly unknown[] }[]).map((c) => {
        try {
          return { status: "success" as const, result: answer(c) };
        } catch {
          return { status: "failure" as const };
        }
      });
    },
    async readContract(c) {
      return answer(c);
    },
    async getCode({ address }) {
      return opts.deployed === false ? "0x" : address.toLowerCase() === "0x2222222222222222222222222222222222222222" ? "0x6080" : "0x";
    },
  };
}

test("decodeReserve: cbBTC config + rates + oracle price → the VERIFIED numbers", () => {
  const r = decodeReserve("cbBTC", [...CFG.cbBTC], [...DATA.cbBTC], PRICE.cbBTC)!;
  assert.equal(r.liquidationThresholdBps, 7800);
  assert.equal(r.ltvBps, 7300);
  assert.equal(r.liquidationBonusBps, 750);
  assert.equal(r.usageAsCollateralEnabled, true);
  assert.ok(Math.abs(r.variableBorrowAprPct - 0.673) < 1e-9);
  assert.ok(Math.abs(r.supplyAprPct - 0.012) < 1e-9);
  assert.ok(Math.abs(r.priceUsd - 79_630.89) < 1e-9);
});

test("decodeReserve: an unlisted reserve (all zeros, cbZEC) → null; half-read → null", () => {
  assert.equal(decodeReserve("cbZEC", [...CFG.cbZEC], [...DATA.cbZEC], 0n), null);
  assert.equal(decodeReserve("cbBTC", null, [...DATA.cbBTC], PRICE.cbBTC), null);
  assert.equal(decodeReserve("cbBTC", [...CFG.cbBTC], null, PRICE.cbBTC), null);
  const noPrice = decodeReserve("cbBTC", [...CFG.cbBTC], [...DATA.cbBTC], null)!;
  assert.ok(Number.isNaN(noPrice.priceUsd));
});

test("readMarket: live decode agrees with the demo snapshot field-for-field", async () => {
  const m = await readMarket(fakeClient());
  assert.equal(m.source, "live");
  assert.ok(Math.abs(m.usdcBorrowAprPct - DEMO_MARKET.usdcBorrowAprPct) < 1e-9);
  for (const s of ["cbBTC", "WETH", "USDC"] as const) {
    const live = m.reserves[s]!;
    const snap = DEMO_MARKET.reserves[s]!;
    assert.equal(live.liquidationThresholdBps, snap.liquidationThresholdBps, `${s} LT`);
    assert.equal(live.ltvBps, snap.ltvBps, `${s} LTV`);
    assert.equal(live.liquidationBonusBps, snap.liquidationBonusBps, `${s} bonus`);
    assert.ok(Math.abs(live.variableBorrowAprPct - snap.variableBorrowAprPct) < 1e-9, `${s} borrow`);
    assert.ok(Math.abs(live.priceUsd - snap.priceUsd) < 1e-6, `${s} price`);
  }
  assert.equal(m.reserves.cbZEC, null);
});

test("readMarket throws (fail closed) when USDC is unreadable", async () => {
  const c = fakeClient();
  const broken: ReadClient = {
    ...c,
    async multicall(args) {
      const res = await c.multicall(args);
      return res.map((r, i) => ((args.contracts as { args?: unknown[] }[])[i].args?.[0] === BASE_TOKENS.USDC.address ? { status: "failure" as const } : r));
    },
  };
  await assert.rejects(readMarket(broken), /USDC reserve unreadable/);
});

test("safeMulticall falls back to per-call reads when the batch throws", async () => {
  const log: string[] = [];
  const out = await safeMulticall(fakeClient({ multicallThrows: true, log }), [
    { address: AAVE_V3.oracle, abi: [], functionName: "getAssetPrice", args: [BASE_TOKENS.cbBTC.address] },
    { address: AAVE_V3.oracle, abi: [], functionName: "getAssetPrice", args: [BASE_TOKENS.WETH.address] },
  ]);
  assert.deepEqual(out, [PRICE.cbBTC, PRICE.WETH]);
  assert.equal(log.length, 2);
});

test("readAccount: deployed account → Aave data, holdings, USDC debt, LP ids", async () => {
  const market = await readMarket(fakeClient());
  const a = await readAccount(fakeClient(), "0x1111111111111111111111111111111111111111", market, {
    factory: "0x3333333333333333333333333333333333333333",
    lpVenue: "0x5555555555555555555555555555555555555555",
  });
  assert.equal(a.account, "0x2222222222222222222222222222222222222222");
  assert.equal(a.deployed, true);
  assert.ok(Math.abs(a.aave!.totalCollateralUsd - 39_815.445) < 1e-6);
  assert.ok(Math.abs(a.aave!.totalDebtUsd - 15_926.178) < 1e-6);
  assert.equal(a.aave!.currentLiquidationThresholdBps, 7800);
  assert.ok(Math.abs(a.aave!.healthFactor - 1.95) < 1e-9);
  assert.equal(a.collateral.length, 1);
  assert.equal(a.collateral[0].symbol, "cbBTC");
  assert.ok(Math.abs(a.collateral[0].amount - 0.5) < 1e-12);
  assert.ok(Math.abs(a.collateral[0].usd - 39_815.445) < 1e-6);
  assert.ok(Math.abs(a.debtUsdc - 15_926.178) < 1e-9);
  assert.deepEqual(a.lpPositionIds, [7n, 9n]);
  assert.equal(a.walletBalances.cbBTC, 123_000_000n);
});

test("readAccount: no factory configured → wallet balances only; predicted-but-undeployed → address, no positions", async () => {
  const market = await readMarket(fakeClient());
  const none = await readAccount(fakeClient(), "0x1111111111111111111111111111111111111111", market, {});
  assert.equal(none.account, null);
  assert.equal(none.deployed, false);
  assert.equal(none.walletBalances.cbBTC, 123_000_000n);

  const pred = await readAccount(fakeClient({ deployed: false }), "0x1111111111111111111111111111111111111111", market, { factory: "0x3333333333333333333333333333333333333333" });
  assert.equal(pred.account, "0x2222222222222222222222222222222222222222");
  assert.equal(pred.deployed, false);
  assert.equal(pred.aave, null);
  assert.deepEqual(pred.lpPositionIds, []);
});
