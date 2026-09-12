import { test } from "node:test";
import assert from "node:assert/strict";
import { HF_LADDER, rungById } from "@zyo/shared";
import { planProtect, type PlanInput } from "../src/solana/policy.js";
import type { SolanaValuation } from "../src/solana/valuation.js";

type Ok = Extract<SolanaValuation, { kind: "OK" }>;
const ZEC = 100_000_000n;
const USDC = 1_000_000n;

/** 10 ZEC at `price`, `debt` USDC, LT 65 %, Kamino cap 40 %. */
function ok(price: number, debt: number, idleUsdc = 0): Ok {
  const collateralUsd = 10 * price;
  return {
    kind: "OK",
    hf: (collateralUsd * 0.65) / debt,
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
const base = (v: Ok, r: ReturnType<typeof rung>, over: Partial<PlanInput> = {}): PlanInput => ({ valuation: v, rung: r, grant: grant(), keeperUsdc: 10_000n * USDC, saleDiscountBps: 0, marginBps: 50, ...over });

test("repay-only from idle USDC when it covers the lift to the disarm level (HF 1.30 → ≥ 1.40)", () => {
  // 10 ZEC at $800 = $8,000; debt $3,990 → HF 1.303 (the localnet scenario); idle = the borrowed USDC
  const p = planProtect(base(ok(800, 3990, 3990), rung("repay")));
  assert.equal(p.kind, "repay-only");
  if (p.kind === "repay-only") {
    // need: 3990 − 8000×0.65/(1.40×1.005) ≈ 3990 − 3696 = 294 USDC
    assert.ok(p.repayUsdc > 280n * USDC && p.repayUsdc < 320n * USDC, p.repayUsdc.toString());
    assert.ok(p.expectedHf >= rungById("repay").disarmHf, String(p.expectedHf));
    assert.equal(p.sellZec, 0n);
  }
});

test("a sale when idle USDC is short: sized so HF reaches the disarm level AND Kamino's 40 % cap allows the withdraw; the keeper pays fair value by default", () => {
  // 10 ZEC at $660 = $6,600; debt $3,990 → HF 1.075 (below de-risk 1.20, above emergency 1.05); no idle USDC
  const v = ok(660, 3990, 0);
  const p = planProtect(base(v, rung("derisk")));
  assert.equal(p.kind, "sale");
  if (p.kind === "sale") {
    const Y = Number(p.sellZec) / 1e8, X = Number(p.keeperUsdcIn) / 1e6;
    // fair value: X ≈ Y × 660
    assert.ok(Math.abs(X - Y * 660) < 1, `X=${X} Y=${Y}`);
    // HF after ≥ 1.25 and LTV after ≤ 40 %
    const debtAfter = 3990 - X, collAfter = (10 - Y) * 660;
    assert.ok((collAfter * 0.65) / debtAfter >= rungById("derisk").disarmHf, `hf ${(collAfter * 0.65) / debtAfter}`);
    assert.ok(debtAfter / collAfter <= 0.4 + 1e-6, `ltv ${debtAfter / collAfter}`);
    assert.ok(p.expectedHf >= rungById("derisk").disarmHf);
    assert.equal(p.repayUsdc, p.keeperUsdcIn, "no idle USDC: the whole repayment is the keeper's");
  }
});

test("idle USDC is used first, then the keeper's; a discount within the allowance lowers what the keeper pays", () => {
  const v = ok(660, 3990, 500);
  const fair = planProtect(base(v, rung("derisk")));
  const discounted = planProtect(base(v, rung("derisk"), { saleDiscountBps: 100 }));
  assert.equal(fair.kind, "sale");
  assert.equal(discounted.kind, "sale");
  if (fair.kind === "sale" && discounted.kind === "sale") {
    assert.equal(fair.repayUsdc - fair.keeperUsdcIn, 500n * USDC, "the 500 idle USDC repays first");
    assert.ok(discounted.keeperUsdcIn < fair.keeperUsdcIn || discounted.sellZec > fair.sellZec);
  }
  const tooMuch = planProtect(base(v, rung("derisk"), { saleDiscountBps: 300 }));
  assert.equal(tooMuch.kind, "refused");
  if (tooMuch.kind === "refused") assert.equal(tooMuch.permanent, true);
});

test("bounds: a binding grant budget clamps and says so (the program accepts an exhausted budget); short keeper capital refuses", () => {
  const v = ok(660, 3990, 0);
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
  const repayOnlyClamped = planProtect(base(ok(800, 3990, 3990), rung("repay"), { grant: grant({ repayLeft: 100n * USDC }) }));
  assert.equal(repayOnlyClamped.kind, "repay-only");
  if (repayOnlyClamped.kind === "repay-only") {
    assert.equal(repayOnlyClamped.repayUsdc, 100n * USDC);
    assert.match(repayOnlyClamped.note ?? "", /repay budget binds/);
  }
});

test("refusals by name: no live grant, a rung the grant excludes, an account already above the disarm level", () => {
  const v = ok(800, 3990, 3990);
  assert.equal(planProtect(base(v, rung("repay"), { grant: grant({ live: false }) })).kind, "refused");
  const notAllowed = planProtect(base(v, rung("repay"), { grant: grant({ allowedRungs: 0b1000 }) }));
  assert.equal(notAllowed.kind, "refused");
  if (notAllowed.kind === "refused") assert.equal(notAllowed.permanent, true);
  const healthy = planProtect(base(ok(1000, 3990, 3990), rung("repay")));
  assert.equal(healthy.kind, "refused");
  if (healthy.kind === "refused") assert.match(healthy.reason, /already at or above/);
});
