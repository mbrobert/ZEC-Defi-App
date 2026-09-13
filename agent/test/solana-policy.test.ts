import { test } from "node:test";
import assert from "node:assert/strict";
import { HF_LADDER, rungById } from "@zyo/shared";
import { planProtect, type PlanInput } from "../src/solana/policy.js";
import type { SolanaValuation } from "../src/solana/valuation.js";

type Ok = Extract<SolanaValuation, { kind: "OK" }>;
const ZEC = 100_000_000n;
const USDC = 1_000_000n;
const LT = 0.65;
const CAP = 0.4;
const DEBT = 3990; // the localnet fixture: 10 ZEC at $1,000, borrowed at Kamino's 40 % cap → HF 1.629
const R = { warn: rungById("warn"), repay: rungById("repay"), derisk: rungById("derisk"), emergency: rungById("emergency") };
/** Midway between two adjacent rungs' thresholds: inside the milder rung's band, above the more severe one. */
const between = (mild: typeof R.warn, severe: typeof R.warn) => (mild.hf + severe.hf) / 2;
/** The price that puts 10 ZEC against `debt` USDC at `hf`. */
const priceAt = (hf: number, debt = DEBT) => (hf * debt) / (10 * LT);
const P_REPAY = priceAt(between(R.repay, R.derisk)); // HF 1.125 on the floor's ladder, ≈ $690.58
const P_DERISK = priceAt(between(R.derisk, R.emergency)); // HF 1.07, ≈ $656.83
const MARGIN_BPS = 50;
/** What the plan aims at: the disarm level plus the margin. */
const targetHf = (r: typeof R.warn) => r.disarmHf * (1 + MARGIN_BPS / 10_000);

/** 10 ZEC at `price`, `debt` USDC, LT 65 %, Kamino cap 40 %. */
function ok(price: number, debt: number, idleUsdc = 0): Ok {
  const collateralUsd = 10 * price;
  return {
    kind: "OK",
    hf: (collateralUsd * LT) / debt,
    debtUsdc: BigInt(Math.round(debt * 1e6)),
    collateralZec: 10n * ZEC,
    collateralCtokens: 10n * ZEC,
    zecUsd: price,
    liquidationThresholdBps: 6500,
    loanToValueBps: Math.round((debt / collateralUsd) * 10_000),
    ltvCapBps: 4000,
    idleUsdc: BigInt(Math.round(idleUsdc * 1e6)),
    idleZec: 0n,
    independent: true,
  };
}
const rung = (id: "repay" | "derisk" | "emergency") => ({ id: HF_LADDER.findIndex((r) => r.id === id), disarmHf: rungById(id).disarmHf });
const grant = (over: Partial<PlanInput["grant"]> = {}): PlanInput["grant"] => ({ live: true, allowedRungs: 0b1111, repayLeft: 5_000n * USDC, sellLeft: 5n * ZEC, maxSellSlippageBps: 200, ...over });
const base = (v: Ok, r: ReturnType<typeof rung>, over: Partial<PlanInput> = {}): PlanInput => ({ valuation: v, rung: r, grant: grant(), keeperUsdc: 10_000n * USDC, saleDiscountBps: 0, marginBps: MARGIN_BPS, ...over });

test("repay-only from idle USDC when it covers the lift to the disarm level (HF inside the repay band → ≥ repay's disarm)", () => {
  // 10 ZEC at P_REPAY; debt $3,990 → HF midway between repay (1.16) and de-risk (1.09), the localnet scenario; idle = the borrowed USDC
  const v = ok(P_REPAY, DEBT, DEBT);
  assert.ok(v.hf < R.repay.hf && v.hf > R.derisk.hf, `hf ${v.hf}`);
  const p = planProtect(base(v, rung("repay")));
  assert.equal(p.kind, "repay-only");
  if (p.kind === "repay-only") {
    // need = D − C·P·LT ÷ (disarm × 1.005): 3990 − 10 × 690.58 × 0.65 ÷ 1.1859 ≈ 204.9 USDC
    const need = DEBT - (10 * P_REPAY * LT) / targetHf(R.repay);
    assert.ok(Math.abs(Number(p.repayUsdc) / 1e6 - need) < 0.01, `${p.repayUsdc} vs ${need}`);
    assert.ok(p.expectedHf >= R.repay.disarmHf, String(p.expectedHf));
    assert.ok(p.expectedHf < R.repay.disarmHf + 0.03, `sized to the level, not a blanket repay: ${p.expectedHf}`);
    assert.equal(p.sellZec, 0n);
  }
});

test("a sale when idle USDC is short: sized so HF reaches the disarm level AND Kamino's 40 % cap allows the withdraw; the keeper pays fair value by default", () => {
  // 10 ZEC at P_DERISK; debt $3,990 → HF midway between de-risk (1.09) and emergency (1.05); no idle USDC
  const v = ok(P_DERISK, DEBT, 0);
  assert.ok(v.hf < R.derisk.hf && v.hf > R.emergency.hf, `hf ${v.hf}`);
  const p = planProtect(base(v, rung("derisk")));
  assert.equal(p.kind, "sale");
  if (p.kind === "sale") {
    const Y = Number(p.sellZec) / 1e8, X = Number(p.keeperUsdcIn) / 1e6;
    // fair value: X ≈ Y × the price
    assert.ok(Math.abs(X - Y * P_DERISK) < 1, `X=${X} Y=${Y}`);
    // HF after ≥ de-risk's disarm level (1.11) and LTV after ≤ 40 %
    const debtAfter = DEBT - X, collAfter = (10 - Y) * P_DERISK;
    assert.ok((collAfter * LT) / debtAfter >= R.derisk.disarmHf, `hf ${(collAfter * LT) / debtAfter}`);
    assert.ok(debtAfter / collAfter <= CAP + 1e-6, `ltv ${debtAfter / collAfter}`);
    // the cap, not the level, decides the size here: the debt-to-collateral it needs is the larger of the two
    const yLevel = (targetHf(R.derisk) * DEBT - 10 * P_DERISK * LT) / (P_DERISK * (targetHf(R.derisk) - LT));
    const yCap = (DEBT - 10 * P_DERISK * CAP) / (P_DERISK * (1 - CAP));
    assert.ok(yCap > yLevel, `cap ${yCap} vs level ${yLevel}`);
    assert.ok(Math.abs(Y - yCap * (1 + MARGIN_BPS / 10_000)) < 1e-4, `Y ${Y} vs ${yCap}`);
    assert.ok(p.expectedHf >= R.derisk.disarmHf);
    assert.equal(p.repayUsdc, p.keeperUsdcIn, "no idle USDC: the whole repayment is the keeper's");
  }
});

test("idle USDC is used first, then the keeper's; a discount within the allowance lowers what the keeper pays", () => {
  // idle USDC worth half the lift to de-risk's disarm level (≈ 163 USDC at 1.11 × 1.005 from HF 1.07): not enough alone
  const need = DEBT - (10 * P_DERISK * LT) / targetHf(R.derisk);
  const idle = Math.floor(need / 2);
  const v = ok(P_DERISK, DEBT, idle);
  const fair = planProtect(base(v, rung("derisk")));
  const discounted = planProtect(base(v, rung("derisk"), { saleDiscountBps: 100 }));
  assert.equal(fair.kind, "sale");
  assert.equal(discounted.kind, "sale");
  if (fair.kind === "sale" && discounted.kind === "sale") {
    assert.equal(fair.repayUsdc - fair.keeperUsdcIn, BigInt(idle) * USDC, "the idle USDC repays first");
    assert.ok(discounted.keeperUsdcIn < fair.keeperUsdcIn || discounted.sellZec > fair.sellZec);
  }
  const tooMuch = planProtect(base(v, rung("derisk"), { saleDiscountBps: 300 }));
  assert.equal(tooMuch.kind, "refused");
  if (tooMuch.kind === "refused") assert.equal(tooMuch.permanent, true);
});

test("bounds: a binding grant budget clamps and says so (the program accepts an exhausted budget); short keeper capital refuses", () => {
  const v = ok(P_DERISK, DEBT, 0);
  const clamped = planProtect(base(v, rung("derisk"), { grant: grant({ sellLeft: ZEC / 2n }) }));
  assert.equal(clamped.kind, "sale");
  if (clamped.kind === "sale") {
    assert.equal(clamped.sellZec, ZEC / 2n);
    assert.match(clamped.note ?? "", /sell budget binds/);
  }
  const broke = planProtect(base(v, rung("derisk"), { keeperUsdc: 100n * USDC }));
  assert.equal(broke.kind, "refused");
  if (broke.kind === "refused") {
    assert.match(broke.reason, /keeper capital short/);
    assert.equal(broke.permanent, false);
  }
  const repayOnlyClamped = planProtect(base(ok(P_REPAY, DEBT, DEBT), rung("repay"), { grant: grant({ repayLeft: 100n * USDC }) }));
  assert.equal(repayOnlyClamped.kind, "repay-only");
  if (repayOnlyClamped.kind === "repay-only") {
    assert.equal(repayOnlyClamped.repayUsdc, 100n * USDC);
    assert.match(repayOnlyClamped.note ?? "", /repay budget binds/);
  }
});

test("refusals by name: no live grant, a rung the grant excludes, an account already above the disarm level", () => {
  const v = ok(P_REPAY, DEBT, DEBT);
  assert.equal(planProtect(base(v, rung("repay"), { grant: grant({ live: false }) })).kind, "refused");
  const notAllowed = planProtect(base(v, rung("repay"), { grant: grant({ allowedRungs: 0b1000 }) }));
  assert.equal(notAllowed.kind, "refused");
  if (notAllowed.kind === "refused") assert.equal(notAllowed.permanent, true);
  const healthy = planProtect(base(ok(1000, DEBT, DEBT), rung("repay")));
  assert.equal(healthy.kind, "refused");
  if (healthy.kind === "refused") assert.match(healthy.reason, /already at or above/);
  // just above repay's disarm level (1.18) — inside warn's band, but not repay's to act on
  const aboveDisarm = planProtect(base(ok(priceAt(R.repay.disarmHf + 0.005), DEBT, DEBT), rung("repay")));
  assert.equal(aboveDisarm.kind, "refused");
  if (aboveDisarm.kind === "refused") assert.match(aboveDisarm.reason, /already at or above/);
});
