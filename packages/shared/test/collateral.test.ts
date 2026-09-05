import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLATERAL_ASSETS,
  COLLATERAL_SYMBOLS,
  enabledCollateral,
  collateralBySymbol,
  collateralByAddress,
  isCollateralSymbol,
  tokenForCollateral,
  MAX_OFFERED_LTV_CAP_BPS,
  maxOfferedLtvBps,
  maxOfferedLtvStopBps,
  LTV_PRESET_FIXED_BPS,
  ltvPresets,
  isOfferableLtv,
  ENTRY_HF_FLOOR,
  BASE_TOKENS,
  AAVE_V3,
  CHAINLINK_FEEDS,
  PYTH,
} from "../dist/index.js";

test("registry: cbBTC + WETH enabled on aave-v3, cbZEC disabled with a reason", () => {
  assert.deepEqual([...COLLATERAL_SYMBOLS], ["cbBTC", "WETH", "cbZEC"]);
  assert.equal(COLLATERAL_ASSETS.cbBTC.enabled, true);
  assert.equal(COLLATERAL_ASSETS.WETH.enabled, true);
  assert.equal(COLLATERAL_ASSETS.cbZEC.enabled, false);
  assert.ok((COLLATERAL_ASSETS.cbZEC.disabledReason ?? "").length > 20);
  assert.match(COLLATERAL_ASSETS.cbZEC.disabledReason!, /no lending market|not listed/i);
  assert.deepEqual(
    enabledCollateral().map((a) => a.symbol),
    ["cbBTC", "WETH"],
  );
  for (const s of COLLATERAL_SYMBOLS) {
    const a = COLLATERAL_ASSETS[s];
    assert.equal(a.symbol, s);
    assert.equal(a.venue, "aave-v3");
    assert.equal(a.venueDataSource, AAVE_V3.poolDataProvider);
    assert.equal(a.address, BASE_TOKENS[s].address);
    assert.equal(a.decimals, BASE_TOKENS[s].decimals);
  }
  assert.equal(COLLATERAL_ASSETS.cbBTC.decimals, 8);
  assert.equal(COLLATERAL_ASSETS.WETH.decimals, 18);
  assert.equal(COLLATERAL_ASSETS.cbZEC.decimals, 8);
});

test("registry feeds: Chainlink for cbBTC/WETH, Pyth for cbZEC (no Chainlink ZEC feed)", () => {
  assert.deepEqual(COLLATERAL_ASSETS.cbBTC.feed, { kind: "chainlink", ...CHAINLINK_FEEDS.cbBTC_USD });
  assert.deepEqual(COLLATERAL_ASSETS.WETH.feed, { kind: "chainlink", ...CHAINLINK_FEEDS.ETH_USD });
  assert.equal(COLLATERAL_ASSETS.cbZEC.feed.kind, "pyth");
  if (COLLATERAL_ASSETS.cbZEC.feed.kind === "pyth") {
    assert.equal(COLLATERAL_ASSETS.cbZEC.feed.contract, PYTH.contract);
    assert.equal(COLLATERAL_ASSETS.cbZEC.feed.priceId, PYTH.priceIds.ZEC_USD);
  }
  assert.ok(COLLATERAL_ASSETS.cbZEC.riskNotes.some((n) => /rebase|multiplier/i.test(n)));
});

test("registry carries NO typed liquidation threshold / LTV / HF", () => {
  const forbiddenKeys = /ltv|liquidation|threshold|healthfactor|\bhf\b|entryhf/i;
  for (const a of Object.values(COLLATERAL_ASSETS)) {
    for (const k of Object.keys(a)) assert.doesNotMatch(k, forbiddenKeys, `${a.symbol}.${k}`);
    const json = JSON.stringify(a);
    for (const n of ["7800", "8300", "7300", "8000", "5000", "1.55"]) {
      assert.equal(json.includes(n), false, `${a.symbol} carries ${n}`);
    }
  }
});

test("lookups", () => {
  assert.equal(collateralBySymbol("WETH")?.symbol, "WETH");
  assert.equal(collateralBySymbol("USDC"), undefined);
  assert.equal(collateralBySymbol("__proto__"), undefined);
  assert.equal(collateralByAddress(BASE_TOKENS.cbBTC.address.toLowerCase())?.symbol, "cbBTC");
  assert.equal(collateralByAddress(BASE_TOKENS.USDC.address), undefined);
  assert.equal(isCollateralSymbol("cbZEC"), true);
  assert.equal(isCollateralSymbol("AERO"), false);
  assert.equal(tokenForCollateral("cbZEC").kind, "b20");
});

test("maxOfferedLtvBps = min(5000, floor(LT / 1.55)) — cbBTC 7800 → 5000, WETH 8300 → 5000, 6000 → 3870", () => {
  assert.equal(MAX_OFFERED_LTV_CAP_BPS, 5000);
  assert.equal(maxOfferedLtvBps(7800), 5000);
  assert.equal(maxOfferedLtvBps(8300), 5000);
  assert.equal(maxOfferedLtvBps(6000), 3870);
  assert.equal(maxOfferedLtvBps(7750), 5000); // 7750/1.55 = 5000 exactly
  assert.equal(maxOfferedLtvBps(7749), 4999);
  assert.equal(maxOfferedLtvBps(1550), 1000); // exact-division edge that floats get wrong
  assert.equal(maxOfferedLtvBps(0), 0);
  assert.equal(maxOfferedLtvBps(10000), 5000);
  // agrees with the float definition wherever the float is not on a boundary
  for (const lt of [4000, 4650, 5500, 6000, 6500, 7000, 7800, 8300, 9000]) {
    const derived = Math.min(5000, Math.floor(lt / ENTRY_HF_FLOOR));
    assert.equal(maxOfferedLtvBps(lt), derived, `lt ${lt}`);
    // and the result always opens at or above the entry floor
    if (maxOfferedLtvBps(lt) > 0) assert.ok(lt / maxOfferedLtvBps(lt) >= ENTRY_HF_FLOOR - 1e-12);
  }
  assert.throws(() => maxOfferedLtvBps(78.5), RangeError);
  assert.throws(() => maxOfferedLtvBps(NaN), RangeError);
});

test("maxOfferedLtvStopBps floors to a whole percent: 7000 → 4516 → 4500", () => {
  assert.equal(maxOfferedLtvBps(7000), 4516);
  assert.equal(maxOfferedLtvStopBps(7000), 4500);
  assert.equal(maxOfferedLtvStopBps(7800), 5000);
  assert.equal(maxOfferedLtvStopBps(6000), 3800); // 3870 → 38 %
  assert.equal(maxOfferedLtvStopBps(0), 0);
  for (const lt of [4000, 5500, 6000, 6500, 7000, 7800, 8300]) {
    const stop = maxOfferedLtvStopBps(lt);
    assert.equal(stop % 100, 0);
    assert.ok(stop <= maxOfferedLtvBps(lt) && stop > maxOfferedLtvBps(lt) - 100);
  }
  // presets carry the same rounding
  const p = ltvPresets(7000);
  assert.equal(p[2].ltvBps, 4516);
  assert.equal(p[2].ltvStopBps, 4500);
  assert.equal(p[0].ltvStopBps, 3000);
  assert.equal(ltvPresets(6000)[2].ltvStopBps, 3800);
});

test("ltvPresets cbBTC (LT 7800): 30/40/50 all offerable, top = 50%", () => {
  const p = ltvPresets(7800);
  assert.deepEqual(
    p.map((x) => [x.id, x.ltvBps, x.offerable]),
    [
      ["p30", 3000, true],
      ["p40", 4000, true],
      ["top", 5000, true],
    ],
  );
  assert.equal(LTV_PRESET_FIXED_BPS.p30, 3000);
  assert.equal(LTV_PRESET_FIXED_BPS.p40, 4000);
  assert.ok(Math.abs(p[2].entryHf! - 1.56) < 1e-9);
  assert.ok(Math.abs(p[0].entryHf! - 2.6) < 1e-9);
  assert.ok(p[2].entryHf! >= ENTRY_HF_FLOOR);
  assert.ok(p[0].liquidationDropPct > p[1].liquidationDropPct && p[1].liquidationDropPct > p[2].liquidationDropPct);
  assert.equal(p[0].label, "30%");
  assert.equal(p[1].label, "40%");
  assert.equal(p[2].label, "Top");
});

test("ltvPresets WETH (LT 8300): top = 50%, entry HF 1.66", () => {
  const p = ltvPresets(8300);
  assert.equal(p[2].ltvBps, 5000);
  assert.equal(p.every((x) => x.offerable), true);
  assert.ok(Math.abs(p[2].entryHf! - 1.66) < 1e-9);
});

test("ltvPresets low-LT asset (6000): 30% ok, 40% NOT offerable, top = 38.70%", () => {
  const p = ltvPresets(6000);
  assert.deepEqual(
    p.map((x) => [x.id, x.ltvBps, x.offerable]),
    [
      ["p30", 3000, true],
      ["p40", 4000, false],
      ["top", 3870, true],
    ],
  );
  assert.ok(p[1].entryHf! < ENTRY_HF_FLOOR, "40% would open below the floor");
  assert.ok(p[2].entryHf! >= ENTRY_HF_FLOOR);
  assert.equal(Math.round(p[2].ltvBps / 100), 39); // "≈ 38%" in the spec; exact value 38.70 %
  assert.equal(Math.floor(p[2].ltvBps / 100), 38);
});

test("ltvPresets unlisted asset (LT 0, e.g. cbZEC): nothing offerable, top is 0 with null HF", () => {
  const p = ltvPresets(0);
  assert.equal(p.every((x) => !x.offerable), true);
  assert.equal(p[2].ltvBps, 0);
  assert.equal(p[2].entryHf, null);
  assert.equal(p[0].entryHf, 0);
});

test("presets never carry a typed HF or ± — every number is computed from the input", () => {
  const a = ltvPresets(7800);
  const b = ltvPresets(6000);
  assert.notEqual(a[0].entryHf, b[0].entryHf);
  assert.notEqual(a[2].ltvBps, b[2].ltvBps);
  assert.notEqual(a[0].liquidationDropPct, b[0].liquidationDropPct);
});

test("isOfferableLtv", () => {
  assert.equal(isOfferableLtv(7800, 5000), true);
  assert.equal(isOfferableLtv(7800, 5001), false);
  assert.equal(isOfferableLtv(6000, 4000), false);
  assert.equal(isOfferableLtv(6000, 3870), true);
  assert.equal(isOfferableLtv(6000, 0), false);
  assert.throws(() => isOfferableLtv(6000, 1.5), RangeError);
});
