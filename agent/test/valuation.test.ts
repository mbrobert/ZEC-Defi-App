import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { BPS, WAD, evaluateSnapshot, normaliseTo8, type AccountSnapshot, type ReserveRow, type ValuationParams } from "../src/engine/valuation.js";
import { MAX_UINT256 } from "../src/types/evm.js";
import { CBBTC, LTS, PRICES, USDC, WETH } from "./fixtures.js";
import { isLoanDust } from "@zyo/shared";

const NOW = 1_800_000_000n;
const PARAMS: ValuationParams = { nowS: NOW, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };
const ACCOUNT = "0xAcc0000000000000000000000000000000000001" as const;

function row(o: Partial<ReserveRow> & { symbol: "cbBTC" | "WETH" | "USDC" }): ReserveRow {
  const asset = { cbBTC: CBBTC, WETH, USDC }[o.symbol];
  const decimals = { cbBTC: 8, WETH: 18, USDC: 6 }[o.symbol];
  const price = PRICES[o.symbol];
  return {
    asset,
    decimals,
    liquidationThresholdBps: LTS[o.symbol],
    aTokenBalance: 0n,
    debt: 0n,
    usingAsCollateral: false,
    aavePrice: price,
    chainlink: { roundId: 10n, answer: price, updatedAt: NOW - 60n, answeredInRound: 10n, decimals: 8 },
    ...o,
  };
}

/** Build the pool-level totals Aave would report for a set of rows. */
function consistent(rows: ReserveRow[], over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  let coll = 0n;
  let debt = 0n;
  let wlt = 0n;
  for (const r of rows) {
    const unit = 10n ** BigInt(r.decimals);
    if (r.aTokenBalance > 0n && r.usingAsCollateral) {
      const v = (r.aTokenBalance * r.aavePrice) / unit;
      coll += v;
      wlt += v * r.liquidationThresholdBps;
    }
    if (r.debt > 0n) debt += (r.debt * r.aavePrice) / unit;
  }
  const lt = coll > 0n ? wlt / coll : 0n;
  const hf = debt === 0n ? MAX_UINT256 : (wlt * WAD) / (debt * BPS);
  return {
    account: ACCOUNT,
    totalCollateralBase: coll,
    totalDebtBase: debt,
    currentLiquidationThresholdBps: lt,
    healthFactorWad: hf,
    reserves: rows,
    unreadableReserves: [],
    blockNumber: 1n,
    ...over,
  };
}

const ONE_BTC = 100_000_000n;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

describe("valuation — happy paths", () => {
  it("1 cbBTC vs 30,000 USDC → HF = 79600×0.78/30000 ≈ 2.0696, cbBTC dominant", () => {
    const s = consistent([row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true }), row({ symbol: "USDC", debt: usdc(30_000) })]);
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "OK");
    if (v.kind !== "OK") return;
    assert.ok(Math.abs(v.hf - (79_600 * 0.78) / 30_000) < 1e-6, String(v.hf));
    assert.equal(v.dominantCollateral.symbol, "cbBTC");
    assert.equal(v.debtBase, 30_000n * 100_000_000n);
  });

  it("no debt anywhere → NO_DEBT", () => {
    const s = consistent([row({ symbol: "WETH", aTokenBalance: 10n ** 18n, usingAsCollateral: true })]);
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "NO_DEBT");
  });

  it("slice C: the measured one-unit USDC residual with collateral is NO_DEBT (rounding, not a book), and the pool's finite HF is not a fault", () => {
    const rows = [row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true }), row({ symbol: "USDC", debt: 1n })];
    const s = consistent(rows); // totalDebtBase = 1 × 1e8 / 1e6 = 100 base units, HF finite and enormous
    assert.notEqual(s.healthFactorWad, MAX_UINT256, "the pool reports a finite HF for a unit of debt");
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "NO_DEBT", `kind ${v.kind}${v.kind === "UNKNOWN" ? `: ${v.reasons.join("; ")}` : ""}`);
    // …at the threshold it is still dust; one unit above it is a book, valued as OK
    assert.equal(evaluateSnapshot(consistent([rows[0], row({ symbol: "USDC", debt: 100n })]), PARAMS).kind, "NO_DEBT");
    assert.equal(evaluateSnapshot(consistent([rows[0], row({ symbol: "USDC", debt: 101n })]), PARAMS).kind, "OK");
    // literally nothing owed still demands the pool's MAX_UINT256
    const lying = consistent([rows[0]], { healthFactorWad: 5n * WAD });
    assert.equal(evaluateSnapshot(lying, PARAMS).kind, "UNKNOWN");
  });

  it("empty account (no exposure at all) → NO_DEBT", () => {
    const s = consistent([row({ symbol: "cbBTC" }), row({ symbol: "WETH" }), row({ symbol: "USDC" })]);
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "NO_DEBT");
  });

  it("mixed collateral: dominant is the larger VALUE, weighted LT reproduces the pool's", () => {
    const s = consistent([
      row({ symbol: "cbBTC", aTokenBalance: ONE_BTC / 10n, usingAsCollateral: true }), // $7,960
      row({ symbol: "WETH", aTokenBalance: 5n * 10n ** 18n, usingAsCollateral: true }), // $12,267
      row({ symbol: "USDC", debt: usdc(5_000) }),
    ]);
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "OK");
    if (v.kind === "OK") assert.equal(v.dominantCollateral.symbol, "WETH");
  });

  it("chainlink feed with 18 decimals normalises to the 8-decimal base unit", () => {
    assert.equal(normaliseTo8(79_600n * 10n ** 18n, 18), PRICES.cbBTC);
    assert.equal(normaliseTo8(79_600n * 10n ** 6n, 6), PRICES.cbBTC);
    const s = consistent([
      row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true, chainlink: { roundId: 1n, answer: 79_600n * 10n ** 18n, updatedAt: NOW, answeredInRound: 1n, decimals: 18 } }),
      row({ symbol: "USDC", debt: usdc(1000) }),
    ]);
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "OK");
  });
});

describe("valuation — the four guards, each alone forces UNKNOWN", () => {
  const base = () => [row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true }), row({ symbol: "USDC", debt: usdc(30_000) })];

  it("G1: an unreadable reserve", () => {
    const s = consistent(base(), { unreadableReserves: [{ symbol: "WETH", reason: "DeadlineError" }] });
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") assert.match(v.reasons.join(), /G1 WETH: unreadable/);
  });

  it("G1: the pool reports debt that no reserve row carries (the $9,500 bug's shape)", () => {
    const s = consistent([row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true })]);
    s.totalDebtBase = 9_500n * 100_000_000n;
    s.healthFactorWad = 5n * WAD;
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "UNKNOWN");
    assert.notEqual(v.kind, "NO_DEBT");
  });

  it("G1: duplicate reserve rows", () => {
    const s = consistent([...base(), row({ symbol: "USDC" })]);
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
  });

  it("G2: debt asset whose Aave oracle reads 0 — THE broken round-2 fix — is UNKNOWN, never HEALTHY", () => {
    const rows = base();
    rows[1].aavePrice = 0n; // USDC price 0 → debt values to $0 → naive HF = ∞
    const s = consistent(rows);
    assert.equal(s.totalDebtBase, 0n); // Aave itself would say "no debt"
    const v = evaluateSnapshot(s, PARAMS);
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") assert.match(v.reasons.join("\n"), /G2 USDC: aave oracle price is 0/);
  });

  it("G2: zero, stale, future, non-finalised, and disagreeing Chainlink answers", () => {
    const mk = (cl: Partial<NonNullable<ReserveRow["chainlink"]>>) => {
      const rows = base();
      rows[0].chainlink = { ...rows[0].chainlink!, ...cl };
      return evaluateSnapshot(consistent(rows), PARAMS);
    };
    assert.equal(mk({ answer: 0n }).kind, "UNKNOWN");
    assert.equal(mk({ answer: -1n }).kind, "UNKNOWN");
    assert.equal(mk({ updatedAt: NOW - BigInt(PARAMS.priceMaxAgeS) - 1n }).kind, "UNKNOWN");
    assert.equal(mk({ updatedAt: NOW - BigInt(PARAMS.priceMaxAgeS) }).kind, "OK");
    assert.equal(mk({ updatedAt: NOW + 301n }).kind, "UNKNOWN");
    assert.equal(mk({ updatedAt: 0n }).kind, "UNKNOWN");
    assert.equal(mk({ answeredInRound: 9n }).kind, "UNKNOWN");
    assert.equal(mk({ answer: (PRICES.cbBTC * 104n) / 100n }).kind, "UNKNOWN"); // +4% vs 300 bps tolerance
    assert.equal(mk({ answer: (PRICES.cbBTC * 102n) / 100n }).kind, "OK");
    assert.equal(mk({ decimals: 19 }).kind, "UNKNOWN");
  });

  it("G2: a reserve with exposure but no independent feed is UNKNOWN", () => {
    const rows = base();
    rows[0].chainlink = null;
    assert.equal(evaluateSnapshot(consistent(rows), PARAMS).kind, "UNKNOWN");
  });

  it("G3: Σ collateral / Σ debt / weighted LT must reproduce the pool totals", () => {
    let s = consistent(base());
    s.totalCollateralBase = s.totalCollateralBase * 2n; // e.g. an unlisted collateral asset
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
    s = consistent(base());
    s.totalDebtBase = s.totalDebtBase / 2n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
    s = consistent(base());
    s.currentLiquidationThresholdBps = 8300n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
  });

  it("G3: collateral flagged as used with LT = 0 (delisted) is UNKNOWN", () => {
    const rows = base();
    rows[0].liquidationThresholdBps = 0n;
    assert.equal(evaluateSnapshot(consistent(rows), PARAMS).kind, "UNKNOWN");
  });

  it("G4: MAX_UINT HF with debt; 0 HF; HF above sanity; HF disagreeing with the recompute", () => {
    let s = consistent(base());
    s.healthFactorWad = MAX_UINT256;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
    s = consistent(base());
    s.healthFactorWad = 0n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
    s = consistent(base());
    s.healthFactorWad = (s.healthFactorWad * 103n) / 100n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
    s = consistent(base());
    s.healthFactorWad = (s.healthFactorWad * 1005n) / 1000n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "OK");
  });

  it("G4: no debt but pool HF is not MAX_UINT — inconsistent, UNKNOWN", () => {
    const s = consistent([row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true })]);
    s.healthFactorWad = 3n * WAD;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
  });

  it("G4: debt with zero valued collateral is UNKNOWN (escalate), not 'liquidatable'", () => {
    const s = consistent([row({ symbol: "USDC", debt: usdc(100) })]);
    s.healthFactorWad = 0n;
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
  });

  it("dust debt that values to zero base units is UNKNOWN, not zero", () => {
    // 1 wei of WETH debt = $2.4e-15 → 0 base units.
    const rows = [row({ symbol: "cbBTC", aTokenBalance: ONE_BTC, usingAsCollateral: true }), row({ symbol: "WETH", debt: 1n })];
    const s = consistent(rows);
    assert.equal(evaluateSnapshot(s, PARAMS).kind, "UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Property tests over adversarial account states.
// ---------------------------------------------------------------------------

const bigAmount = (max: bigint) => fc.bigInt({ min: 0n, max });
const arbRow = fc
  .record({
    symbol: fc.constantFrom("cbBTC", "WETH", "USDC") as fc.Arbitrary<"cbBTC" | "WETH" | "USDC">,
    aTokenBalance: bigAmount(10n ** 22n),
    debt: bigAmount(10n ** 22n),
    usingAsCollateral: fc.boolean(),
  })
  .map((r) => row(r));

/** Distinct-symbol row sets (Aave has one row per reserve). */
const arbRows = fc
  .uniqueArray(arbRow, { minLength: 0, maxLength: 3, selector: (r) => r.symbol })
  .map((rows) => rows.sort((a, b) => a.symbol.localeCompare(b.symbol)));

type Poison =
  | { t: "unreadable" }
  | { t: "aavePriceZero"; i: number }
  | { t: "clZero"; i: number }
  | { t: "clStale"; i: number }
  | { t: "clFuture"; i: number }
  | { t: "clRound"; i: number }
  | { t: "clDeviate"; i: number; bps: number }
  | { t: "clMissing"; i: number }
  | { t: "hfMax" }
  | { t: "hfZero" }
  | { t: "hfScale"; bps: number }
  | { t: "debtTotalScale"; bps: number }
  | { t: "collTotalScale"; bps: number }
  | { t: "ltZero"; i: number }
  | { t: "ltPool"; delta: number };

const arbPoison: fc.Arbitrary<Poison> = fc.oneof(
  fc.constant({ t: "unreadable" } as Poison),
  fc.record({ t: fc.constant("aavePriceZero" as const), i: fc.nat(2) }),
  fc.record({ t: fc.constant("clZero" as const), i: fc.nat(2) }),
  fc.record({ t: fc.constant("clStale" as const), i: fc.nat(2) }),
  fc.record({ t: fc.constant("clFuture" as const), i: fc.nat(2) }),
  fc.record({ t: fc.constant("clRound" as const), i: fc.nat(2) }),
  // Tolerance is measured against the larger value, so +x% needs x/(1+x) > 3%: start at 320.
  fc.record({ t: fc.constant("clDeviate" as const), i: fc.nat(2), bps: fc.integer({ min: 320, max: 5000 }) }),
  fc.record({ t: fc.constant("clMissing" as const), i: fc.nat(2) }),
  fc.constant({ t: "hfMax" } as Poison),
  fc.constant({ t: "hfZero" } as Poison),
  fc.record({ t: fc.constant("hfScale" as const), bps: fc.integer({ min: 110, max: 9000 }) }),
  fc.record({ t: fc.constant("debtTotalScale" as const), bps: fc.integer({ min: 110, max: 9000 }) }),
  fc.record({ t: fc.constant("collTotalScale" as const), bps: fc.integer({ min: 110, max: 9000 }) }),
  fc.record({ t: fc.constant("ltZero" as const), i: fc.nat(2) }),
  fc.record({ t: fc.constant("ltPool" as const), delta: fc.integer({ min: 101, max: 2000 }) })
);

function exposureRows(s: AccountSnapshot): ReserveRow[] {
  return s.reserves.filter((r) => r.debt > 0n || (r.aTokenBalance > 0n && r.usingAsCollateral));
}

/** Apply a poison; returns false if it could not apply (no target row). */
function applyPoison(s: AccountSnapshot, p: Poison, sign: 1 | -1): boolean {
  const rows = exposureRows(s);
  const pick = (i: number) => rows[i % rows.length];
  const hasDebt = s.totalDebtBase > 0n;
  switch (p.t) {
    case "unreadable":
      s.unreadableReserves.push({ symbol: "cbBTC", reason: "test" });
      return true;
    case "aavePriceZero":
      if (!rows.length) return false;
      pick(p.i).aavePrice = 0n;
      return true;
    case "clZero":
      if (!rows.length || !pick(p.i).chainlink) return false;
      pick(p.i).chainlink!.answer = 0n;
      return true;
    case "clStale":
      if (!rows.length || !pick(p.i).chainlink) return false;
      pick(p.i).chainlink!.updatedAt = NOW - BigInt(PARAMS.priceMaxAgeS) - 1n;
      return true;
    case "clFuture":
      if (!rows.length || !pick(p.i).chainlink) return false;
      pick(p.i).chainlink!.updatedAt = NOW + 100_000n;
      return true;
    case "clRound":
      if (!rows.length || !pick(p.i).chainlink) return false;
      pick(p.i).chainlink!.answeredInRound = pick(p.i).chainlink!.roundId - 1n;
      return true;
    case "clDeviate": {
      if (!rows.length || !pick(p.i).chainlink) return false;
      const r = pick(p.i);
      r.chainlink!.answer = (r.chainlink!.answer * BigInt(10_000 + sign * p.bps)) / 10_000n;
      return true;
    }
    case "clMissing":
      if (!rows.length) return false;
      pick(p.i).chainlink = null;
      return true;
    case "hfMax":
      if (!hasDebt) return false;
      s.healthFactorWad = MAX_UINT256;
      return true;
    case "hfZero":
      if (!hasDebt) return false;
      s.healthFactorWad = 0n;
      return true;
    case "hfScale":
      if (!hasDebt) return false;
      s.healthFactorWad = (s.healthFactorWad * BigInt(10_000 + sign * p.bps)) / 10_000n;
      return true;
    case "debtTotalScale":
      if (!hasDebt) return false;
      s.totalDebtBase = (s.totalDebtBase * BigInt(10_000 + sign * p.bps)) / 10_000n;
      return true;
    case "collTotalScale":
      if (s.totalCollateralBase === 0n) return false;
      s.totalCollateralBase = (s.totalCollateralBase * BigInt(10_000 + sign * p.bps)) / 10_000n;
      return true;
    case "ltZero": {
      const coll = rows.filter((r) => r.aTokenBalance > 0n && r.usingAsCollateral);
      if (!coll.length) return false;
      coll[p.i % coll.length].liquidationThresholdBps = 0n;
      return true;
    }
    case "ltPool":
      if (s.totalCollateralBase === 0n) return false;
      s.currentLiquidationThresholdBps = s.currentLiquidationThresholdBps + BigInt(sign * p.delta);
      if (s.currentLiquidationThresholdBps < 0n) s.currentLiquidationThresholdBps = 0n;
      return true;
  }
}

describe("valuation — properties over adversarial account states", () => {
  it("non-empty debt ⇒ never NO_DEBT; OK only when the recomputed HF matches the pool's", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const s = consistent(rows);
        const v = evaluateSnapshot(s, PARAMS);
        // Slice C (RISKS §8): USDC debt at or below LOAN_DUST_UNITS is rounding and reads NO_DEBT; any
        // other debt — including a single unit of a collateral asset — is a book.
        const anyDebt = rows.some((r) => r.debt > 0n && !(r.symbol === "USDC" && isLoanDust(r.debt)));
        if (anyDebt) {
          assert.notEqual(v.kind, "NO_DEBT");
          if (v.kind === "OK") {
            assert.ok(v.hf > 0 && Number.isFinite(v.hf));
            // Recomputed HF agrees with the pool's (within tolerance) by construction.
            const poolHf = Number(s.healthFactorWad) / 1e18;
            assert.ok(Math.abs(v.hf - poolHf) <= poolHf * 0.01 + 1e-9);
            assert.ok(v.collateral.length > 0);
            assert.equal(v.dominantCollateral, v.collateral[0]);
          }
        } else {
          assert.notEqual(v.kind, "OK");
        }
      }),
      { numRuns: 1500 }
    );
  });

  it("a consistent, fully-priced snapshot with debt and collateral is OK (no false UNKNOWN)", () => {
    fc.assert(
      fc.property(
        fc.record({
          coll: fc.bigInt({ min: 10_000_000n, max: 10n ** 12n }), // ≥ 0.1 cbBTC
          debt: fc.bigInt({ min: 1_000_000n, max: 10n ** 12n }), // ≥ 1 USDC
        }),
        ({ coll, debt }) => {
          const s = consistent([row({ symbol: "cbBTC", aTokenBalance: coll, usingAsCollateral: true }), row({ symbol: "USDC", debt })]);
          const v = evaluateSnapshot(s, PARAMS);
          assert.equal(v.kind, "OK", JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
        }
      ),
      { numRuns: 500 }
    );
  });

  it("every poison applied to a consistent snapshot with exposure forces UNKNOWN (never NO_DEBT, never OK)", () => {
    let applied = 0;
    fc.assert(
      fc.property(arbRows, arbPoison, fc.constantFrom(1, -1) as fc.Arbitrary<1 | -1>, (rows, poison, sign) => {
        const clean = consistent(rows);
        if (evaluateSnapshot(clean, PARAMS).kind === "UNKNOWN") return; // dust etc.; not a clean baseline
        // Slice C (RISKS §8): a USDC residual at or below LOAN_DUST_UNITS is NO_DEBT by policy, so a
        // poison on the debt side of such a snapshot has nothing to register against; the collateral
        // side is covered by the dust-free baselines.
        if (rows.some((r) => r.symbol === "USDC" && r.debt > 0n && isLoanDust(r.debt))) return;
        const s = consistent(structuredClone(rows));
        if (!applyPoison(s, poison, sign)) return;
        // A poison that happens to leave the snapshot unchanged proves nothing.
        if (JSON.stringify(s, bigintJson) === JSON.stringify(clean, bigintJson)) return;
        applied++;
        const v = evaluateSnapshot(s, PARAMS);
        assert.equal(v.kind, "UNKNOWN", `${poison.t}: ${JSON.stringify(v, bigintJson)}`);
      }),
      { numRuns: 4000 }
    );
    assert.ok(applied > 1000, `only ${applied} poisons applied`);
  });

  it("UNKNOWN is sticky: adding poison never turns UNKNOWN into OK or NO_DEBT", () => {
    fc.assert(
      fc.property(arbRows, fc.array(arbPoison, { minLength: 1, maxLength: 4 }), (rows, poisons) => {
        const s = consistent(rows);
        let wasUnknown = evaluateSnapshot(s, PARAMS).kind === "UNKNOWN";
        for (const p of poisons) {
          applyPoison(s, p, 1);
          const k = evaluateSnapshot(s, PARAMS).kind;
          if (wasUnknown) assert.equal(k, "UNKNOWN");
          wasUnknown = k === "UNKNOWN";
        }
      }),
      { numRuns: 1000 }
    );
  });
});

function bigintJson(_: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
