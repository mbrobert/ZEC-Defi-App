import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_TOKENS, HF_LADDER } from "@zyo/shared";
import { DEMO_KEEPER_GRANT } from "../lib/demo";
import { GRANT_EXPIRY_WARN_DAYS, RUNGS_SERVED_BY_UNWIND, describeGrant, grantMatchesPlan, rungPlain, type KeeperGrantRead } from "../lib/keeper";
import { DEMO_DEPLOYMENT, KEEPER_GRANT_EXPIRY_DAYS, UNWIND_SELECTOR } from "../lib/plan";

const NOW = 1_800_000_000;
const LIVE = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" as const };

const grant = (over: Partial<KeeperGrantRead> = {}): KeeperGrantRead => ({
  keeper: LIVE.keeper,
  target: LIVE.router,
  selector: UNWIND_SELECTOR,
  active: true,
  maxValuePerPeriod: 0n,
  valueSpent: 0n,
  period: 86_400,
  expiry: NOW + 10 * 86_400,
  periodStart: NOW,
  allowCallback: true,
  tokens: [{ token: BASE_TOKENS.USDC.address, symbol: "USDC", amountPerPeriod: 1_000_000n, spent: 0n }],
  readAt: new Date(NOW * 1000).toISOString(),
  ...over,
});

test("a live grant reports the rungs it can actually serve, and never claims the warning rung", () => {
  const s = describeGrant(grant(), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(s.kind, "active");
  assert.equal(s.daysLeft, 10);
  assert.match(s.label, /10 days left/);
  assert.deepEqual(
    s.rungsCovered.map((r) => r.id),
    ["repay", "derisk", "emergency"],
  );
  assert.deepEqual(
    s.rungsUncovered.map((r) => r.id),
    ["warn"],
  );
  // The warning rung is a message. No permission produces it, so no permission
  // may be said to cover it.
  assert.equal(RUNGS_SERVED_BY_UNWIND.length, HF_LADDER.length - 1);
  assert.match(rungPlain(HF_LADDER[0], "cbBTC"), /nothing is signed or moved/);
});

test("a lapsed grant is reported as lapsed, not as silence", () => {
  const s = describeGrant(grant({ expiry: NOW - 1 }), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(s.kind, "expired");
  assert.equal(s.tone, "crit");
  assert.deepEqual(s.rungsCovered, []);
  assert.match(s.plain, /expired/);
  assert.match(s.plain, /nobody will reduce it for you/);
});

/**
 * The exact failure this round exists to prevent: a grant that LOOKS live but
 * cannot act, because `allowCallback` is false. Every keeper dispatch would
 * revert `NotActivePeripheral` inside the router and nothing would be
 * broadcast while the position rode to liquidation.
 */
test("a grant without allowCallback is reported as unable to act, in plain words", () => {
  const s = describeGrant(grant({ allowCallback: false }), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(s.kind, "cannot-act");
  assert.equal(s.tone, "crit");
  assert.deepEqual(s.rungsCovered, []);
  assert.match(s.plain, /every keeper attempt would fail/);
  assert.ok(!/allowCallback/.test(s.plain), "the plain sentence must not require reading the ABI");
  assert.equal(grantMatchesPlan(grant({ allowCallback: false }), { router: LIVE.router, selector: UNWIND_SELECTOR, keeper: LIVE.keeper }), false);
});

test("a grant with no token budget cannot repay or close, and says so", () => {
  const s = describeGrant(grant({ tokens: [] }), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(s.kind, "no-budget");
  assert.match(s.plain, /refused by your own account/);
  const zeroed = describeGrant(grant({ tokens: [{ token: BASE_TOKENS.USDC.address, symbol: "USDC", amountPerPeriod: 0n, spent: 0n }] }), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(zeroed.kind, "no-budget");
});

test("no grant, and no keeper at all, are different states and both say what it means for the user", () => {
  const none = describeGrant(null, { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(none.kind, "not-granted");
  assert.match(none.plain, /nobody will reduce it for you/);
  const noKeeper = describeGrant(grant(), { keeperConfigured: false, nowSeconds: NOW });
  assert.equal(noKeeper.kind, "not-configured");
  assert.match(noKeeper.plain, /nothing watches this position/);
  for (const s of [none, noKeeper]) assert.deepEqual(s.rungsCovered, []);
});

test("an expiry inside the keeper's own warning window is amber here too, not a green light", () => {
  const s = describeGrant(grant({ expiry: NOW + (GRANT_EXPIRY_WARN_DAYS - 1) * 86_400 }), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(s.kind, "active");
  assert.equal(s.tone, "warn");
  assert.match(s.plain, /very soon/);
  // The keeper warns and notifies inside GRANT_EXPIRY_WARN_S (7 days); the two
  // surfaces must agree on when protection is "about to lapse".
  const cfg = readFileSync(join(__dirname, "../../agent/src/config.ts"), "utf8");
  const m = cfg.match(/grantExpiryWarnS:\s*([0-9_ *]+),/);
  assert.ok(m, "the keeper no longer declares grantExpiryWarnS");
  // e.g. "7 * 86_400"
  const seconds = m![1]
    .split("*")
    .map((x) => Number(x.replace(/[_\s]/g, "")))
    .reduce((a, b) => a * b, 1);
  assert.equal(GRANT_EXPIRY_WARN_DAYS * 86_400, seconds, "the UI's amber window must equal the keeper's");
  assert.equal(describeGrant(grant({ expiry: NOW + (GRANT_EXPIRY_WARN_DAYS + 3) * 86_400 }), { keeperConfigured: true, nowSeconds: NOW }).tone, "good");
});

test("grantMatchesPlan only accepts the exact grant this build asks users to sign", () => {
  const expected = { router: LIVE.router, selector: UNWIND_SELECTOR, keeper: LIVE.keeper };
  assert.equal(grantMatchesPlan(grant(), expected), true);
  assert.equal(grantMatchesPlan(grant({ target: BASE_TOKENS.USDC.address }), expected), false);
  assert.equal(grantMatchesPlan(grant({ selector: "0xdeadbeef" }), expected), false);
  assert.equal(grantMatchesPlan(grant({ keeper: "0x1111111111111111111111111111111111111111" }), expected), false);
  assert.equal(grantMatchesPlan(grant({ active: false }), expected), false);
  assert.equal(grantMatchesPlan(null, expected), false);
});

test("the demo grant is the same shape the wizard asks for, so demo mode cannot show a permission the product does not build", () => {
  assert.equal(DEMO_KEEPER_GRANT.selector, UNWIND_SELECTOR);
  assert.equal(DEMO_KEEPER_GRANT.target, DEMO_DEPLOYMENT.router);
  assert.equal(DEMO_KEEPER_GRANT.allowCallback, true);
  assert.equal(DEMO_KEEPER_GRANT.maxValuePerPeriod, 0n);
  assert.equal(DEMO_KEEPER_GRANT.period, 86_400);
  assert.ok(DEMO_KEEPER_GRANT.tokens.length >= 3);
  assert.ok(DEMO_KEEPER_GRANT.tokens.every((t) => t.amountPerPeriod > 0n), "the chain refuses a zero budget line");
  const granted = DEMO_KEEPER_GRANT.expiry - KEEPER_GRANT_EXPIRY_DAYS * 86_400;
  assert.equal(new Date(granted * 1000).toISOString(), "2026-08-30T14:03:00.000Z", "the demo grant expires exactly 30 days after the demo position was opened");
});

/**
 * CROSS-AREA SEAM. The previous round's worst outcome was a grant the user
 * signed that the keeper could not use: it broadcast nothing while positions
 * rode to liquidation. The keeper publishes the shape it needs in
 * `agent/src/abi/oilskin.ts`; this asserts the grant this UI actually builds is
 * that shape, read from the keeper's own source rather than agreed in prose.
 */
test("the grant the web asks users to sign is exactly the grant the keeper plans", () => {
  const p = join(__dirname, "../../agent/src/abi/oilskin.ts");
  assert.ok(existsSync(p), "the keeper's ABI module is missing — the seam cannot be checked");
  const src = readFileSync(p, "utf8");

  // The selector the keeper reads its grant with, by SIGNATURE, not by hex.
  const sig = src.match(/"StrategyRouter\.unwind":\s*toFunctionSelector\(\s*"([^"]+)"/);
  assert.ok(sig, "the keeper no longer derives the unwind selector from a signature");
  assert.equal(sig![1], "unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))");

  const shape = src.slice(src.indexOf("export const KEEPER_GRANT_SHAPE"));
  assert.ok(shape.length > 0, "the keeper no longer publishes KEEPER_GRANT_SHAPE");
  assert.match(shape, /targetRole:\s*"StrategyRouter"/);
  assert.match(shape, /selector:\s*GRANT_SELECTORS\["StrategyRouter\.unwind"\]/);
  assert.match(shape, /allowCallback:\s*true/);

  // …and what this UI builds.
  const built = describeGrant(grant(), { keeperConfigured: true, nowSeconds: NOW });
  assert.equal(built.kind, "active");
  assert.equal(grantMatchesPlan(grant(), { router: LIVE.router, selector: UNWIND_SELECTOR, keeper: LIVE.keeper }), true);
});
