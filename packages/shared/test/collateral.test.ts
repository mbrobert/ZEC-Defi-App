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
  maxOfferedLtvBps,
  maxOfferedLtvStopBps,
  LTV_PRESET_FIXED_BPS,
  ltvPresets,
  isOfferableLtv,
  ENTRY_HF_FLOOR,
  BASE_TOKENS,
  AAVE_V3,
  CHAINLINK_FEEDS,
  ZEC_FORMS,
  zecFormForCollateral,
  collateralForZecForm,
  zecCollateral,
  zecFormRowFaults,
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

test("registry feeds: Chainlink throughout — cbBTC, WETH, and cbZEC by ZEC/USD at 18 decimals", () => {
  assert.deepEqual(COLLATERAL_ASSETS.cbBTC.feed, { kind: "chainlink", ...CHAINLINK_FEEDS.cbBTC_USD });
  assert.deepEqual(COLLATERAL_ASSETS.WETH.feed, { kind: "chainlink", ...CHAINLINK_FEEDS.ETH_USD });
  // The founder's decision of 2026-09-13 ("use chainlink zec/usd exclusively until a cbZEC/USD
  // source is available"), which ChainlinkOracleAdapter implements and PythOracleAdapter lost to.
  // Until 2026-09-13 this row was Pyth, on the belief that Base had no Chainlink ZEC feed;
  // VERIFIED-BASE-FACTS.md Addendum 16 read one live and superseded that.
  assert.deepEqual(COLLATERAL_ASSETS.cbZEC.feed, { kind: "chainlink", ...CHAINLINK_FEEDS.ZEC_USD });
  assert.ok(COLLATERAL_ASSETS.cbZEC.riskNotes.some((n) => /rebase|multiplier/i.test(n)));
});

test("cbZEC's feed carries its two hazards in data, not in a comment", () => {
  const feed = COLLATERAL_ASSETS.cbZEC.feed;
  assert.equal(feed.kind, "chainlink");
  if (feed.kind !== "chainlink") return;
  // Hazard 1 — 18 decimals, the only feed in this repo that is not 8. A consumer assuming 8 is
  // wrong by a factor of 10^10, so the number must travel with the feed and be read from it.
  assert.equal(feed.decimals, 18);
  assert.equal(COLLATERAL_ASSETS.cbBTC.feed.kind === "chainlink" && COLLATERAL_ASSETS.cbBTC.feed.decimals, 8);
  assert.equal(COLLATERAL_ASSETS.WETH.feed.kind === "chainlink" && COLLATERAL_ASSETS.WETH.feed.decimals, 8);
  // Hazard 2 — it prices ZEC, not cbZEC. A user reading riskNotes must be told that, because the
  // wrapper can trade below ZEC and this feed would not notice.
  assert.equal(feed.description, "ZEC / USD");
  assert.ok(
    COLLATERAL_ASSETS.cbZEC.riskNotes.some((n) => /prices ZEC and not cbZEC/i.test(n)),
    "riskNotes must say the feed prices ZEC rather than cbZEC",
  );
  // Pyth is no longer this row's source anywhere in the registry.
  assert.equal(JSON.stringify(COLLATERAL_ASSETS.cbZEC).toLowerCase().includes("pyth"), false);
});

test("the cbZEC row points at its ZEC form and keeps no second copy of the form's facts", () => {
  const form = ZEC_FORMS["cbzec-base"];
  assert.equal(COLLATERAL_ASSETS.cbZEC.zecForm, "cbzec-base");
  assert.equal(zecFormForCollateral("cbZEC"), form);
  assert.equal(collateralForZecForm("cbzec-base")?.symbol, "cbZEC");
  assert.deepEqual(zecCollateral().map((a) => a.symbol), ["cbZEC"]);

  // cbBTC and WETH are not ZEC and say so by absence, not by a sentinel.
  assert.equal(COLLATERAL_ASSETS.cbBTC.zecForm, undefined);
  assert.equal(COLLATERAL_ASSETS.WETH.zecForm, undefined);
  assert.equal(zecFormForCollateral("WETH"), undefined);
  // A Solana form has no Base collateral row, and asking for one is not an error.
  assert.equal(collateralForZecForm("zec-solana-bridged"), undefined);

  // The reason and the risks are the form's own objects, not copies that could drift apart.
  assert.equal(COLLATERAL_ASSETS.cbZEC.disabledReason, form.disabledReason);
  assert.equal(COLLATERAL_ASSETS.cbZEC.enabled, form.enabled);
  for (const note of form.riskNotes) assert.ok(COLLATERAL_ASSETS.cbZEC.riskNotes.includes(note), note.slice(0, 40));
});

test("the two registries agree — zecFormRowFaults() is empty", () => {
  assert.deepEqual(zecFormRowFaults(), []);
});

test("cbZEC's disabled reason is D3's, not the superseded 'v1.1 market' claim", () => {
  const reason = COLLATERAL_ASSETS.cbZEC.disabledReason ?? "";
  // Until 2026-09-15 this row said cbZEC collateral was "Planned for v1.1 once the Oilskin
  // cbZEC/USDC market ships" — a promise decision D3 of 2026-09-12 had already reversed. Oilskin
  // does not create that market; it waits for an external one. Pin the reversal, not the wording.
  assert.doesNotMatch(reason, /Oilskin cbZEC\/USDC market ships/i);
  assert.match(reason, /does not create that market/i);
  assert.match(reason, /D3/);
  // And it points the ZEC holder at the route that does work today rather than leaving a dead end.
  assert.match(reason, /Solana/i);
});

test("registry carries NO typed liquidation threshold / LTV / HF", () => {
  const forbiddenKeys = /ltv|liquidation|threshold|healthfactor|\bhf\b|entryhf/i;
  for (const a of Object.values(COLLATERAL_ASSETS)) {
    for (const k of Object.keys(a)) assert.doesNotMatch(k, forbiddenKeys, `${a.symbol}.${k}`);
    const json = JSON.stringify(a);
    for (const n of ["7800", "8300", "7300", "8000", "6240", "1.25"]) {
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

test("maxOfferedLtvBps = floor(LT / 1.25), no product cap — cbBTC 7800 → 6240, WETH 8300 → 6640, 6000 → 4800", () => {
  assert.equal(maxOfferedLtvBps(7800), 6240);
  assert.equal(maxOfferedLtvBps(8300), 6640);
  assert.equal(maxOfferedLtvBps(6000), 4800);
  assert.equal(maxOfferedLtvBps(7750), 6200); // 7750/1.25 = 6200 exactly
  assert.equal(maxOfferedLtvBps(7749), 6199);
  assert.equal(maxOfferedLtvBps(1250), 1000); // exact-division edge that floats get wrong
  assert.equal(maxOfferedLtvBps(0), 0);
  assert.equal(maxOfferedLtvBps(10000), 8000, "no cap: only the floor and, at the registry, the venue's own LTV bound the offer");
  // agrees with the float definition wherever the float is not on a boundary
  for (const lt of [4000, 4650, 5500, 6000, 6500, 7000, 7800, 8300, 9000]) {
    const derived = Math.floor(lt / ENTRY_HF_FLOOR);
    assert.equal(maxOfferedLtvBps(lt), derived, `lt ${lt}`);
    // and the result always opens at or above the entry floor
    if (maxOfferedLtvBps(lt) > 0) assert.ok(lt / maxOfferedLtvBps(lt) >= ENTRY_HF_FLOOR - 1e-12);
  }
  assert.throws(() => maxOfferedLtvBps(78.5), RangeError);
  assert.throws(() => maxOfferedLtvBps(NaN), RangeError);
});

test("maxOfferedLtvStopBps floors to a whole percent: 7000 → 5600, 7800 → 6240 → 6200", () => {
  assert.equal(maxOfferedLtvBps(7000), 5600);
  assert.equal(maxOfferedLtvStopBps(7000), 5600);
  assert.equal(maxOfferedLtvStopBps(7800), 6200);
  assert.equal(maxOfferedLtvStopBps(6000), 4800);
  assert.equal(maxOfferedLtvStopBps(0), 0);
  for (const lt of [4000, 5500, 6000, 6500, 7000, 7800, 8300]) {
    const stop = maxOfferedLtvStopBps(lt);
    assert.equal(stop % 100, 0);
    assert.ok(stop <= maxOfferedLtvBps(lt) && stop > maxOfferedLtvBps(lt) - 100);
  }
  // presets carry the same rounding
  const p = ltvPresets(7800);
  assert.equal(p[2].ltvBps, 6240);
  assert.equal(p[2].ltvStopBps, 6200);
  assert.equal(p[0].ltvStopBps, 3000);
  assert.equal(ltvPresets(6000)[2].ltvStopBps, 4800);
});

test("ltvPresets cbBTC (LT 7800): 30/40/top all offerable, top = 62.40 % at entry HF 1.25 exactly", () => {
  const p = ltvPresets(7800);
  assert.deepEqual(
    p.map((x) => [x.id, x.ltvBps, x.offerable]),
    [
      ["p30", 3000, true],
      ["p40", 4000, true],
      ["top", 6240, true],
    ],
  );
  assert.equal(LTV_PRESET_FIXED_BPS.p30, 3000);
  assert.equal(LTV_PRESET_FIXED_BPS.p40, 4000);
  assert.ok(Math.abs(p[2].entryHf! - 1.25) < 1e-9);
  assert.ok(Math.abs(p[0].entryHf! - 2.6) < 1e-9);
  assert.ok(p[2].entryHf! >= ENTRY_HF_FLOOR);
  assert.ok(p[0].liquidationDropPct > p[1].liquidationDropPct && p[1].liquidationDropPct > p[2].liquidationDropPct);
  assert.equal(p[0].label, "30%");
  assert.equal(p[1].label, "40%");
  assert.equal(p[2].label, "Top");
});

test("ltvPresets WETH (LT 8300): top = 66.40 %, entry HF 1.25", () => {
  const p = ltvPresets(8300);
  assert.equal(p[2].ltvBps, 6640);
  assert.equal(p.every((x) => x.offerable), true);
  assert.ok(Math.abs(p[2].entryHf! - 1.25) < 1e-9);
});

test("ltvPresets low-LT asset (6000): 30 % and 40 % offerable at the 1.25 floor (40 % was not at 1.55), top = 48.00 %", () => {
  const p = ltvPresets(6000);
  assert.deepEqual(
    p.map((x) => [x.id, x.ltvBps, x.offerable]),
    [
      ["p30", 3000, true],
      ["p40", 4000, true],
      ["top", 4800, true],
    ],
  );
  assert.ok(p[1].entryHf! >= ENTRY_HF_FLOOR, "40 % opens at HF 1.50, above the 1.25 floor");
  assert.equal(ltvPresets(6000, 1.55)[1].offerable, false, "at the old 1.55 floor 40 % would have opened below it");
  assert.ok(p[2].entryHf! >= ENTRY_HF_FLOOR);
  assert.equal(Math.floor(p[2].ltvBps / 100), 48);
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
  assert.equal(isOfferableLtv(7800, 6240), true);
  assert.equal(isOfferableLtv(7800, 6241), false);
  assert.equal(isOfferableLtv(6000, 4000), true);
  assert.equal(isOfferableLtv(6000, 4800), true);
  assert.equal(isOfferableLtv(6000, 4801), false);
  assert.equal(isOfferableLtv(6000, 0), false);
  assert.throws(() => isOfferableLtv(6000, 1.5), RangeError);
});
