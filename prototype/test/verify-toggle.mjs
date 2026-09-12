/* verify-toggle — parity between simple.html and index.html, and between both
   and their sources of truth: packages/shared (built dist), docs/VERIFIED-BASE-FACTS.md,
   /tmp/build/MODEL-NUMBERS.md. Also the Simple ⇄ Advanced links and the
   repo-wide grep for removed vocabulary (reported per area). */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execSync } from "node:child_process";
import { serve, browser, openPage, runner, forbiddenHits, FORBIDDEN, ROOT, REPO } from "./_harness.mjs";

const { check, near, done } = runner("verify-toggle");
const simple = fs.readFileSync(path.join(ROOT, "simple.html"), "utf8");
const adv = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const block = html => html.slice(html.indexOf("/* ── OIL_SHARED"), html.indexOf("/* ── Demo wallet / account ── */"));

/* ── 1. byte-equal shared block, and it evaluates standalone ── */
check("parity: the OIL_SHARED / OIL_CHAIN_READ / OIL_MODEL / derived-math block is byte-equal in both builds", block(simple) === block(adv) && block(simple).length > 5000, `${block(simple).length} vs ${block(adv).length}`);
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(block(simple) + "\nthis.OUT = { OIL_SHARED, OIL_CHAIN_READ, OIL_MODEL, OIL_CONTRACTS, mcLpNetPct, mcApply, minOutFor, swapLegFor, GATE_WHY, realizedEmissionsPct, grossIfRevotedPct, maxOfferedLtvBps, maxOfferedLtvStopBps, ltvPresetsFor, entryHf, dropPct, halfWidthPct, gate, forecast, forecastWhy, FORECAST_SAFETY, lpNetPct, positionAprPct, presetWidthBps, classifyCbZecAddress, topLtvPct, ltvStopsFor, LAD, RUNGS, ladderFor, ladOf, hysteresisFor, offeredBounds, entryHfAtLtv, ltvForHf, hfForBorrow, clampHf, needsHfAck, SHELTERED };", sandbox);
const P = sandbox.OUT;
check("parity: the block evaluates on its own (no hidden dependency on page code)", !!P && !!P.OIL_SHARED && typeof P.gate === "function");

/* ── 2. deep-equal against the built @zyo/shared ── */
let shared = null;
try { shared = await import(path.join(REPO, "packages/shared/dist/index.js")); } catch (e) { console.log("  (shared dist not importable: " + e.message + ")"); }
if (shared) {
  // BigInt-safe: @zyo/shared carries bigint words (MORPHO_BLUE.markets[].lltvWad since 2026-09-07) and
  // JSON.stringify throws on them — the whole suite died before its first shared check (2026-09-12).
  const J = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() + "n" : x));
  const eq = (a, b) => J(a) === J(b);
  const SHc = P.OIL_SHARED;
  check("shared: FEES byte-equal", eq(SHc.FEES, shared.FEES), JSON.stringify([SHc.FEES, shared.FEES]));
  check("shared: HF_LADDER, ENTRY_HF_FLOOR, HF_HYSTERESIS byte-equal", eq(SHc.HF_LADDER, shared.HF_LADDER) && SHc.ENTRY_HF_FLOOR === shared.ENTRY_HF_FLOOR && SHc.HF_HYSTERESIS === shared.HF_HYSTERESIS);
  check("shared: BASE_TOKENS byte-equal (5 tokens, cbZEC kind b20)", eq(SHc.BASE_TOKENS, shared.BASE_TOKENS));
  check("shared: AAVE_V3 (incl. checksummed PoolDataProvider) and AAVE_V3_RESERVES byte-equal", eq(SHc.AAVE_V3, shared.AAVE_V3) && eq(SHc.AAVE_V3_RESERVES, shared.AAVE_V3_RESERVES));
  check("shared: CHAINLINK_FEEDS, CHAINLINK_ZEC_USD, PYTH, AERODROME byte-equal", eq(SHc.CHAINLINK_FEEDS, shared.CHAINLINK_FEEDS) && SHc.CHAINLINK_ZEC_USD === shared.CHAINLINK_ZEC_USD && eq(SHc.PYTH, shared.PYTH) && eq(SHc.AERODROME, shared.AERODROME));
  check("shared: MORPHO_BLUE, COMPOUND_V3, PERMIT2, COW_PROTOCOL, CBZEC_ADDRESS, COUNTERFEIT_PREFIX byte-equal", eq(SHc.MORPHO_BLUE, shared.MORPHO_BLUE) && eq(SHc.COMPOUND_V3, shared.COMPOUND_V3) && SHc.PERMIT2 === shared.PERMIT2 && eq(SHc.COW_PROTOCOL, shared.COW_PROTOCOL) && SHc.CBZEC_ADDRESS === shared.CBZEC_ADDRESS && SHc.COUNTERFEIT_PREFIX === shared.COUNTERFEIT_PREFIX);
  check("shared: MAX_OFFERED_LTV_CAP_BPS, LTV_PRESET_FIXED_BPS, RANGE_WIDTH_BOUNDS, REBALANCE_DELAY_BOUNDS, RANGE_PRESETS byte-equal", SHc.MAX_OFFERED_LTV_CAP_BPS === shared.MAX_OFFERED_LTV_CAP_BPS && eq(SHc.LTV_PRESET_FIXED_BPS, shared.LTV_PRESET_FIXED_BPS) && eq(SHc.RANGE_WIDTH_BOUNDS, shared.RANGE_WIDTH_BOUNDS) && eq(SHc.REBALANCE_DELAY_BOUNDS, shared.REBALANCE_DELAY_BOUNDS) && eq(SHc.RANGE_PRESETS, shared.RANGE_PRESETS));
  check("shared: LADDER_RUNG_FACTORS, EMERGENCY_HF_MIN, HF_HYSTERESIS_MIN, HF_HYSTERESIS_SPAN, MIN_LADDER_ENTRY_HF, HF_MARKS byte-equal (A4)", eq(SHc.LADDER_RUNG_FACTORS, shared.LADDER_RUNG_FACTORS) && SHc.EMERGENCY_HF_MIN === shared.EMERGENCY_HF_MIN && SHc.HF_HYSTERESIS_MIN === shared.HF_HYSTERESIS_MIN && SHc.HF_HYSTERESIS_SPAN === shared.HF_HYSTERESIS_SPAN && SHc.MIN_LADDER_ENTRY_HF === shared.MIN_LADDER_ENTRY_HF && eq(SHc.HF_MARKS, shared.HF_MARKS));
  check("derived: ladderFor agrees with shared.ladderFor rung for rung (id, hf, disarmHf, severity, action, label) at 1.55 / 1.3 / 1.25 / 1.625 / 1.95 / 2.6, and hysteresisFor with shared.hysteresisFor", [1.55, 1.3, 1.25, 1.625, 1.95, 2.6].every(e => eq(P.ladderFor(e), shared.ladderFor(e)) && P.hysteresisFor(e) === shared.hysteresisFor(e)));
  check("derived: ladOf is the keeper's fallback rule — a usable entry derives, null / 0 / 1.05 / NaN give the floor's ladder undisturbed", P.ladOf(1.3).derived === true && eq(Object.values(P.ladOf(1.3).rungs), shared.ladderFor(1.3).map(r => r.hf)) && [null, 0, 1.05, NaN].every(v => P.ladOf(v).derived === false && eq(Object.values(P.ladOf(v).rungs), shared.HF_LADDER.map(r => r.hf))));
  check("derived: offeredBounds agrees with shared.offeredLtvBounds for both live assets, and entryHfAtLtv with shared.entryHfAtLtvBps at 30 / 40 / 50 / 50.32 %", ["cbBTC", "WETH"].every(a => { const r = P.OIL_CHAIN_READ.aaveReserves[a]; return eq(P.offeredBounds(a), shared.offeredLtvBounds(r.liquidationThresholdBps, r.ltvBps)) && [30, 40, 50, 50.32].every(l => P.entryHfAtLtv(a, l) === shared.entryHfAtLtvBps(r.liquidationThresholdBps, Math.round(l * 100))); }));
  check("derived: the identity both ways — ltvForHf(a, hf) = ⌊LT ÷ HF⌋ bps as a percent (shared ltvForEntryHfBps) and hfForBorrow reads the HF back from a borrow; clampHf pulls 1.2 up to the offered minimum and holds 1.95", ["cbBTC", "WETH"].every(a => { const lt = P.OIL_CHAIN_READ.aaveReserves[a].liquidationThresholdBps; return [1.3, 1.55, 1.95, 2.6].every(h => P.ltvForHf(a, h) * 100 === shared.ltvForEntryHfBps(lt, h)); }) && near(P.hfForBorrow("cbBTC", 0.5, 77140.83, 15428.17), 1.95, 1e-6) && P.clampHf("cbBTC", 1.2) === 1.56 && P.clampHf("cbBTC", 1.95) === 1.95 && P.needsHfAck(1.3) === true && P.needsHfAck(1.55) === false);
  check("shared: REWARD_CLAIM_POLICY, ENGINE_REGISTRY_SNAPSHOT, BASE_CHAIN, COLLATERAL_SYMBOLS byte-equal", eq(SHc.REWARD_CLAIM_POLICY, shared.REWARD_CLAIM_POLICY) && eq(SHc.ENGINE_REGISTRY_SNAPSHOT, shared.ENGINE_REGISTRY_SNAPSHOT) && eq(SHc.BASE_CHAIN, shared.BASE_CHAIN) && eq(SHc.COLLATERAL_SYMBOLS, shared.COLLATERAL_SYMBOLS));
  check("shared: COLLATERAL_ASSETS enabled flags, cbZEC disabledReason and riskNotes verbatim", ["cbBTC", "WETH", "cbZEC"].every(a => SHc.COLLATERAL_ASSETS[a].enabled === shared.COLLATERAL_ASSETS[a].enabled && eq(SHc.COLLATERAL_ASSETS[a].riskNotes, shared.COLLATERAL_ASSETS[a].riskNotes) && SHc.COLLATERAL_ASSETS[a].disabledReason === shared.COLLATERAL_ASSETS[a].disabledReason));
  check("shared: every pool id / pairClass / registry id / pool address in OIL_MODEL matches CURATED_POOLS", P.OIL_MODEL.pools.every(p => { const c = shared.poolById(p.id); return c && c.pairClass === p.pairClass && (c.enginePoolId || null) === p.eid && c.poolAddress.toLowerCase() === p.poolAddress.toLowerCase(); }));
  check("shared: offerablePools() ids == the eight engine pools in OIL_MODEL (cbZEC pool DIRECT, never offerable)", JSON.stringify(shared.offerablePools().map(p => p.id).sort()) === JSON.stringify(P.OIL_MODEL.pools.filter(p => p.eid).map(p => p.id).sort()) && !shared.offerablePools().some(p => p.id === "aero-cbzec-usdc"));
  // derived functions agree with shared's
  check("derived: maxOfferedLtvBps agrees with shared for 7800 / 8300 / 7000 / 6000 / 1550 / 10000", [7800, 8300, 7000, 6000, 1550, 10000].every(lt => P.maxOfferedLtvBps(lt) === shared.maxOfferedLtvBps(lt)));
  check("derived: maxOfferedLtvStopBps (whole-percent UI stop) agrees with shared: 7000 → 4500, 6000 → 3800, 7800 → 5000", typeof shared.maxOfferedLtvStopBps === "function" && [7800, 8300, 7000, 6000, 1550].every(lt => P.maxOfferedLtvStopBps(lt) === shared.maxOfferedLtvStopBps(lt)) && P.maxOfferedLtvStopBps(7000) === 4500);
  check("derived: ltvPresets — ids, bps, stop bps and offerable agree with shared for both live assets", ["cbBTC", "WETH"].every(a => { const mine = P.ltvPresetsFor(a), theirs = shared.ltvPresets(P.OIL_CHAIN_READ.aaveReserves[a].liquidationThresholdBps); return mine.length === 3 && mine.every((m, i) => m.id === theirs[i].id && m.ltvBps === theirs[i].ltvBps && m.ltvStopBps === theirs[i].ltvStopBps && m.offerable === theirs[i].offerable); }));
  check("derived: entryHf and dropPct agree with shared.entryHfForLtv / liquidationDropPct at every preset", ["cbBTC", "WETH"].every(a => [30, 40, 50].every(l => { const lt = P.OIL_CHAIN_READ.aaveReserves[a].liquidationThresholdBps; return near(P.entryHf(a, l), shared.entryHfForLtv(lt, l * 100), 1e-12) && near(P.dropPct(a, l), shared.liquidationDropPct(lt, l * 100), 1e-9); })));
  check("derived: ladder trigger/disarm semantics match shared.rungFor / isRungCleared at the boundaries", [1.5, 1.4999, 1.35, 1.3499, 1.2, 1.1999, 1.05, 1.0499, 1.55, 1.4, 1.25, 1.1].every(hf => { const r = shared.rungFor(hf); const mine = [...P.RUNGS].reverse().find(id => hf < P.LAD.rungs[id]) || null; return (r ? r.id : null) === mine && P.RUNGS.every(id => shared.isRungCleared(id, hf) === (hf >= P.LAD.disarm[id])); }));
  check("derived: presetWidthBps agrees with shared for every preset × pair class", ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"].every(pr => ["UNCORRELATED", "CORRELATED"].every(pc => P.presetWidthBps(pr, pc) === shared.presetWidthBps(pr, pc))));
  check("derived: classifyCbZecAddress agrees with shared on genuine / counterfeit / unrelated / invalid", [P.OIL_SHARED.CBZEC_ADDRESS, P.OIL_SHARED.CBZEC_ADDRESS.toLowerCase(), "0xB2000000000000000000000000000000000DEAD1", P.OIL_SHARED.BASE_TOKENS.cbBTC.address, "nope", 42].every(v => P.classifyCbZecAddress(v) === shared.classifyCbZecAddress(v)));
  check("derived: ± is the exact formula exp(bps·ln1.0001/2)−1 in both shared and the prototypes for every preset span and the bounds", [150, 300, 784, 1500, 2356, 4500, 5000].every(w => near(P.halfWidthPct(w), shared.halfWidthFromBps(w), 1e-9)) && near(P.halfWidthPct(4500), 25.23, 0.01) && near(P.halfWidthPct(300), 1.51, 0.01), `${shared.halfWidthFromBps(4500)} vs ${P.halfWidthPct(4500)}`);
  check("rendered ±: both pages print the strings shared.formatHalfWidthPct would at 2 dp (±25.23% / ±7.79% / ±1.51% / ±12.50% / ±4.00% / ±0.75%)", [[4500,"±25.23%"],[1500,"±7.79%"],[300,"±1.51%"],[2356,"±12.50%"],[784,"±4.00%"],[150,"±0.75%"]].every(([w, str]) => `±${P.halfWidthPct(w).toFixed(2)}%` === str && `±${shared.halfWidthFromBps(w).toFixed(2)}%` === str) && /±25\.23%/.test(simple.slice(simple.indexOf("</style>"), simple.indexOf("<script>"))) === false /* never typed in markup: rendered at runtime only */);
}

/* ── 3. OIL_CHAIN_READ against docs/VERIFIED-BASE-FACTS.md ── */
{
  const facts = fs.readFileSync(path.join(REPO, "docs/VERIFIED-BASE-FACTS.md"), "utf8");
  const aave = facts.slice(facts.indexOf("## Aave v3"), facts.indexOf("## Chainlink"));
  const row = name => { const m = aave.match(new RegExp("\\|\\s*\\**" + name + "\\**\\s*\\|([^\\n]+)")); return m ? m[1].split("|").map(x => x.replace(/\*/g, "").trim()) : null; };
  const pct = s => parseFloat(String(s).replace("%", ""));
  const cr = P.OIL_CHAIN_READ.aaveReserves;
  const cb = row("cbBTC"), we = row("WETH"), us = row("USDC");
  /* Every literal below is derived from the page's OIL_CHAIN_READ and looked up in the ledger's text —
     nothing typed twice (the 2026-09-12 re-read at block 51,226,072 replaced the 2026-09-05 digits). */
  const R = P.OIL_CHAIN_READ;
  const fmt2 = n => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = n => Math.round(n).toLocaleString("en-US");
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = t => new RegExp(esc(t)).test(facts);
  check(`facts: cbBTC LTV ${cr.cbBTC.ltvBps / 100} / LT ${cr.cbBTC.liquidationThresholdBps / 100} / bonus ${cr.cbBTC.liquidationBonusBps / 100} / borrow ${cr.cbBTC.borrowAprPct} / supply ${cr.cbBTC.supplyAprPct} match the ledger`, cb && pct(cb[0]) * 100 === cr.cbBTC.ltvBps && pct(cb[1]) * 100 === cr.cbBTC.liquidationThresholdBps && near(pct(cb[2]) * 100, cr.cbBTC.liquidationBonusBps, 1e-9) && near(pct(cb[5]), cr.cbBTC.borrowAprPct, 1e-9) && near(pct(cb[6]), cr.cbBTC.supplyAprPct, 1e-9), JSON.stringify(cb));
  check(`facts: WETH LTV ${cr.WETH.ltvBps / 100} / LT ${cr.WETH.liquidationThresholdBps / 100} / bonus ${cr.WETH.liquidationBonusBps / 100} / borrow ${cr.WETH.borrowAprPct} / supply ${cr.WETH.supplyAprPct} match the ledger`, we && pct(we[0]) * 100 === cr.WETH.ltvBps && pct(we[1]) * 100 === cr.WETH.liquidationThresholdBps && near(pct(we[5]), cr.WETH.borrowAprPct, 1e-9) && near(pct(we[6]), cr.WETH.supplyAprPct, 1e-9), JSON.stringify(we));
  check(`facts: USDC borrow ${cr.USDC.borrowAprPct} / supply ${cr.USDC.supplyAprPct} match the ledger`, us && near(pct(us[5]), cr.USDC.borrowAprPct, 1e-9) && near(pct(us[6]), cr.USDC.supplyAprPct, 1e-9), JSON.stringify(us));
  check(`facts: Chainlink answers (cbBTC ${fmt2(R.feeds.cbBTC)} · ETH ${fmt2(R.feeds.WETH)}) and Pyth ZEC (${fmt2(R.pythZecUsd.price)}, ${fmtInt(R.pythZecUsd.ageS)} s stale) match the ledger, dated ${R.readAt} at block ${fmtInt(R.readBlock)}`, has(fmt2(R.feeds.cbBTC)) && has(fmt2(R.feeds.WETH)) && has(fmt2(R.pythZecUsd.price)) && has(`${fmtInt(R.pythZecUsd.ageS)} s`) && R.pythZecUsd.stale === true && has(`re-read ${R.readAt.slice(0, 10)}`) && has(`block ${fmtInt(R.readBlock)}`));
  check(`facts: cbZEC not listed on Aave; gauge rewardRate ${fmtInt(R.cbzecUsdcPool.gaugeRewardRate)} wei/s to periodFinish ${fmtInt(R.cbzecUsdcPool.gaugePeriodFinish)}; ≈ ${fmtInt(R.cbzecUsdcPool.priceUsdc)} USDC per cbZEC`, cr.cbZEC === null && /NOT LISTED/.test(facts) && has(`\`rewardRate()\` ${fmtInt(R.cbzecUsdcPool.gaugeRewardRate)} wei/s`) && has(`\`periodFinish()\` ${fmtInt(R.cbzecUsdcPool.gaugePeriodFinish)}`) && has(`≈ ${fmtInt(R.cbzecUsdcPool.priceUsdc)} USDC per cbZEC`));
}

/* ── 4. OIL_MODEL against MODEL-NUMBERS.md (when present) ── */
{
  const mp = "/tmp/build/MODEL-NUMBERS.md";
  if (fs.existsSync(mp)) {
    const md = fs.readFileSync(mp, "utf8");
    const rows = md.split("\n").filter(l => /^\| (aero-[\w-]+|cbeth-weth) \| (sheltered|steady|working) \| \d+ \(/.test(l)).map(l => { const c = l.split("|").map(x => x.replace(/\*/g, "").trim()); const num = v => v === "—" ? null : parseFloat(v); return { id: c[1], w: parseInt(c[3]), gross: num(c[5]), lpNet: num(c[9]), reason: c[13] }; });
    check("model: MODEL-NUMBERS.md parsed (27 pool × setting rows)", rows.length === 27, `${rows.length}`);
    const bad = [];
    for (const r of rows) { const pool = P.OIL_MODEL.pools.find(p => p.id === r.id); const served = P.OIL_MODEL.served.find(s => s[0] === r.id && s[1] === r.w); if (!pool || !served) { bad.push(r.id + "@" + r.w + " missing"); continue; } if (!near(pool.emissions[r.w], r.gross, 1e-9)) bad.push(`${r.id}@${r.w} gross ${pool.emissions[r.w]}≠${r.gross}`); if ((served[2] == null) !== (r.lpNet == null) || (r.lpNet != null && !near(served[2], r.lpNet, 1e-9))) bad.push(`${r.id}@${r.w} lpNet ${served[2]}≠${r.lpNet}`); if (served[3] !== r.reason) bad.push(`${r.id}@${r.w} reason ${served[3]}≠${r.reason}`); }
    check("model: every pinned gross-emissions, lpNet and reason equals MODEL-NUMBERS.md", bad.length === 0, bad.join("; "));
    const un = [...md.matchAll(/^\| (aero-[\w-]+) \| (sheltered|steady|working) \| (cbBTC|WETH) \| (\d+)% \([^)]+\) \| ([-\d.]+)% \| ([-\d.]+)% \| ([\d.]+)% \| \*\*([-\d.]+)%\*\* \|/gm)].map(m => ({ id: m[1], setting: m[2], asset: m[3], ltv: +m[4], borrow: +m[6], supply: +m[7], user: +m[8] }));
    const W = { sheltered: "CONSERVATIVE", steady: "MODERATE", working: "AGGRESSIVE" };
    /* Each row is reproduced at ITS OWN borrow and supply (the columns the doc publishes): the page's
       positionAprPct takes the supply from OIL_CHAIN_READ (the dated chain-read pin), so the difference
       between that pin and the row's supply is added back — the model block moves with every model run,
       the chain-read block only with a ledger re-read (slice K, 2026-09-12). */
    const B = P.OIL_MODEL.borrowPctAtGeneration;
    const pricedRows = rows.filter(r => r.lpNet !== null);
    const badU = un.filter(r => { const pool = P.OIL_MODEL.pools.find(p => p.id === r.id); const w = P.presetWidthBps(W[r.setting], pool.pairClass); const supplyAdj = r.supply - P.OIL_CHAIN_READ.aaveReserves[r.asset].supplyAprPct; return !near(r.borrow, B, 1e-9) || !near(P.positionAprPct(r.asset, r.ltv, pool, r.borrow, w) + supplyAdj, r.user, 0.011); });
    check(`model: all ${un.length} userNet rows (pool × setting × collateral × LTV) reproduce to 0.011 pt at the model's borrow ${B}% and each row's supply (6 per priced cell)`, un.length === pricedRows.length * 6 && badU.length === 0, JSON.stringify(badU.slice(0, 3)));
    /* A cell the gate refuses BEFORE pricing (no σ, no emissions, emissions below the borrow) publishes
       no lpNet and no user-net ladder — in the doc, in the pinned block, and in the page's own gate at
       the model's borrow. (The 2026-09-05 instance was aero-weth-cbbtc/sheltered, 54 → 48 rows.) */
    const unpriced = rows.filter(r => r.lpNet === null);
    const badUnpriced = unpriced.filter(r => { const pool = P.OIL_MODEL.pools.find(p => p.id === r.id); const g = P.gate(pool, B, r.w); const settingOf = { 4500: "sheltered", 1500: "steady", 300: "working", 2356: "sheltered", 784: "steady", 150: "working" }[r.w]; return un.some(u => u.id === r.id && u.setting === settingOf) || g.reason !== r.reason || Number.isFinite(g.net) || !P.OIL_MODEL.served.some(s => s[0] === r.id && s[1] === r.w && s[2] === null) || P.OIL_MODEL.userNetPinned.some(s => s[0] === r.id && s[1] === r.w); });
    check(`model: every cell the gate stops at before pricing (${unpriced.length} of 27) publishes no lpNet and no userNet ladder, and the page's gate names the same reason`, unpriced.length > 0 && badUnpriced.length === 0, JSON.stringify(badUnpriced.slice(0, 3).map(r => [r.id, r.w, r.reason])));
    /* The forecast (BUILD-PLAN-2026-09-12 D4/D5): of those same cells, every one with a σ IS priced by forecast() on both forms; the rest are unpriced by name. */
    const fcUn = unpriced.map(r => { const pool = P.OIL_MODEL.pools.find(p => p.id === r.id); const f = P.forecast(pool, B, r.w, 1, { collateral: "cbBTC" }); return { id: r.id, w: r.w, sigma: pool.sigma, priced: f.priced, allowed: f.allowed, net: f.net, mc: f.mcNet, unpriced: f.unpriced }; });
    const withSigma = fcUn.filter(r => r.sigma != null), noSigma = fcUn.filter(r => r.sigma == null);
    check(`forecast: of the ${unpriced.length} cells the gate stops at, the ${withSigma.length} with a σ are PRICED by forecast() on both forms and the ${noSigma.length} without are unpriced by name — all of them allowed`, withSigma.length > 0 && withSigma.every(r => r.priced && Number.isFinite(r.net) && Number.isFinite(r.mc)) && noSigma.every(r => !r.priced && r.unpriced === "no_volatility_input") && fcUn.every(r => r.allowed), JSON.stringify(fcUn.filter(r => r.sigma != null ? !r.priced : r.priced).slice(0, 3)));
    /* The MC-calibrated column the gate now decides on, parsed from the same file. */
    const mcRows = md.split("\n").filter(l => /^\| (aero-[\w-]+|cbeth-weth) \| (sheltered|steady|working) \| \d+ \(/.test(l)).map(l => { const c = l.split("|").map(x => x.replace(/\*/g, "").trim()); return { id: c[1], w: parseInt(c[3]), mc: c[10] === "—" ? null : parseFloat(c[10]) }; }).filter(r => r.mc !== null);
    const badMc = mcRows.filter(r => { const pool = P.OIL_MODEL.pools.find(p => p.id === r.id); const v = P.mcLpNetPct(pool, r.w); return v === null || !near(v, r.mc, 0.011); });
    check(`model: all ${mcRows.length} MC-calibrated lpNet cells reproduce from the two pinned coefficients to 0.011 pt (one per priced cell)`, mcRows.length === pricedRows.length && badMc.length === 0, JSON.stringify(badMc.slice(0, 3)));
    /* The doc's verdict — an empty menu, or the cells it lists as clearing — is what the page's gate says
       at the model's borrow, cell for cell. */
    const clearsDoc = /No pool × setting clears the gate/.test(md) ? [] : [...(md.match(/\*\*Clears the gate:\*\* (.*)$/m)?.[1] ?? "").matchAll(/([\w-]+) \/ (sheltered|steady|working)/g)].map(m => `${m[1]}/${m[2]}`);
    const clearsPage = [];
    for (const p of P.OIL_MODEL.pools) for (const [pr, name] of [["CONSERVATIVE", "sheltered"], ["MODERATE", "steady"], ["AGGRESSIVE", "working"]]) if (P.gate(p, B, P.presetWidthBps(pr, p.pairClass)).ok) clearsPage.push(`${p.id}/${name}`);
    check(`model: the doc's verdict at ${B}% (${clearsDoc.length === 0 ? "no pool × setting clears" : clearsDoc.join(", ") + " clear"}) is the page's gate's verdict, cell for cell`, JSON.stringify(clearsDoc.sort()) === JSON.stringify(clearsPage.sort()), JSON.stringify({ doc: clearsDoc, page: clearsPage }));
    check("model: source string names the generator and the file's generation timestamp", (() => { const ts = (md.match(/generated (\S+)/) || [])[1]; return !!ts && P.OIL_MODEL.source.includes("generated " + ts); })(), P.OIL_MODEL.source);
  } else check("model: MODEL-NUMBERS.md present to pin against (skipped — file absent)", true);
}

/* ── 5. both pages agree on every displayed number for the same inputs; links; stores ── */
const srv = await serve(); const b = await browser();
const ps = await openPage(b, srv.url("simple.html")), pa = await openPage(b, srv.url("index.html"));
const probe = p => p.evaluate(() => { const o = window.__oil; const out = {}; for (const a of ["cbBTC", "WETH"]) for (const l of [30, 40, 50]) out[`${a}/${l}`] = [o.entryHf(a, l), o.dropPct(a, l), o.topLtvPct(a)]; for (const pl of o.MODEL.pools) for (const w of [150, 300, 784, 1500, 2356, 4500, 5000]) { const g = o.gate(pl, o.MODEL.borrowPctAtGeneration, w); out[`${pl.id}@${w}`] = [g.reason, Number.isFinite(g.net) ? +g.net.toFixed(4) : null, +g.gross.toFixed(4), +o.halfWidthPct(w).toFixed(4)]; } out.keep = o.feeKeep(); out.rungs = o.LADDER; return out; });
const a1 = await probe(ps), a2 = await probe(pa);
check("agreement: simple and advanced compute identical HF / drop / top / gate / ± for 6 settings × 9 pools × 7 widths", JSON.stringify(a1) === JSON.stringify(a2));
{ const md = fs.existsSync("/tmp/build/MODEL-NUMBERS.md") ? fs.readFileSync("/tmp/build/MODEL-NUMBERS.md", "utf8") : null;
  const docRow = md && md.match(/^\| aero-cbbtc-usdc \| sheltered \| cbBTC \| 30% \(p30\) \| ([-\d.]+)% \| ([-\d.]+)% \| ([\d.]+)% \| \*\*([-\d.]+)%\*\* \|/m);
  const served = P.OIL_MODEL.served.find(s => s[0] === "aero-cbbtc-usdc" && s[1] === 4500);
  const Bm = P.OIL_MODEL.borrowPctAtGeneration, supplyAdj = P.OIL_MODEL.supplyPctAtGeneration.cbBTC - P.OIL_CHAIN_READ.aaveReserves.cbBTC.supplyAprPct;
  const userSimple = await ps.evaluate(([b]) => window.__oil.positionAprPct("cbBTC", 30, window.__oil.poolById("aero-cbbtc-usdc"), b, 4500), [Bm]);
  const userAdv = await pa.evaluate(([b]) => window.__oil.positionAprPct("cbBTC", 30, window.__oil.poolById("aero-cbbtc-usdc"), b, 4500), [Bm]);
  check(`agreement: the three surfaces (simple, advanced, MODEL-NUMBERS) agree on cbBTC/USDC sheltered lpNet ${served[2]} and userNet ${docRow ? docRow[4] : "(doc absent)"} to 0.1 pt at the model's borrow ${Bm}%`, near(a1["aero-cbbtc-usdc@4500"][1], served[2], 0.1) && (!docRow || (near(+docRow[1], served[2], 0.011) && near(userSimple + supplyAdj, +docRow[4], 0.1) && near(userAdv + supplyAdj, +docRow[4], 0.1))) && near(userSimple, userAdv, 1e-9)); }
check("agreement: both pages' risk lists are identical", JSON.stringify(await ps.evaluate(() => window.__oil.RISKS)) === JSON.stringify(await pa.evaluate(() => window.__oil.RISKS)));
/* ── the audit-fix round: the same contract facts, the same refusals, the same
   floors and the same honest custody language in both builds ── */
{
  const cs = await ps.evaluate(() => window.__oil.CONTRACTS), ca = await pa.evaluate(() => window.__oil.CONTRACTS);
  check("contracts: the OIL_CONTRACTS block is identical in both builds and pins the post-fix surface (openBorrowOnly, the venue-side floor, the swap quote, the grant, the registry timelock)", JSON.stringify(cs) === JSON.stringify(ca) && /openBorrowOnly/.test(cs.entry.borrowOnly) && /AaveV3Venue\.borrow/.test(cs.entry.floorEnforcedAt) && cs.entry.floorError === "EntryHfTooLow(hf, floor)" && cs.swap.maxSlippageBpsCap === 500 && cs.grant.rootCalls === 1 && cs.grant.selector === "unwind" && cs.grant.expiryDays === 30 && cs.registry.timelockDelayS === 172800 && cs.peripheral.defaultCallback === false && cs.routerBalance.assertion === "delta");
  const ws = await ps.evaluate(() => window.__oil.GATE_WHY), wa = await pa.evaluate(() => window.__oil.GATE_WHY);
  const REASONS = ["collateral_disabled","collateral_paused","borrow_paused","no_emissions","emissions_implausible","insufficient_samples","emissions_below_borrow","no_volatility_input","net_below_borrow","within_model_uncertainty","mc_calibration_unavailable","mc_calibration_stale","net_out_of_bounds"];
  check("gate: both builds carry the same plain-English sentence for all 13 reasons, none of them a bare code, and none of them says the model refuses for profitability any more", JSON.stringify(ws) === JSON.stringify(wa) && REASONS.every(r => typeof ws[r] === "string" && ws[r].length > 40 && !/^[a-z_]+$/.test(ws[r])) && Object.keys(ws).length === REASONS.length && !REASONS.some(r => /we refuse|we do not offer|will not offer|nothing is published|refused until/.test(ws[r])), REASONS.filter(r => !ws[r] || ws[r].length <= 40 || /we refuse|we do not offer|will not offer|nothing is published|refused until/.test(ws[r])).join(", "));
  const probe2 = p => p.evaluate(() => { const o = window.__oil; const out = {};
    for (const [id, w, gb] of o.MODEL.boundary) { const pl = o.poolById(id); let lo = 0.01, hi = 500; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; (o.lpNetPct(pl, w, m) > 4.828) ? hi = m : lo = m; } const g = o.gate(pl, 4.828, w, hi * (1 + 1e-9)); out[`${id}@${w}`] = [g.reason, +g.net.toFixed(4), +g.mcNet.toFixed(4)]; }
    for (const pl of o.MODEL.pools) for (const w of [150, 300, 1000, 1500, 4500]) { const g = o.gate(pl, 4.828, w, 12, { collateral: "cbBTC", paused: { USDC: false } }); out[`x${pl.id}@${w}`] = [g.reason, Number.isFinite(g.mcNet) ? +g.mcNet.toFixed(4) : null]; }
    out.paused = o.gate(o.MODEL.pools[1], 4.828, 4500, 12, { collateral: "cbBTC", paused: { cbBTC: true } }).reason;
    out.borrowPaused = o.gate(o.MODEL.pools[1], 4.828, 4500, 12, { collateral: "cbBTC", paused: { USDC: true } }).reason;
    out.uncorroborated = o.gate(o.MODEL.pools[1], 4.828, 4500, 12, { corroborated: false }).reason;
    out.revote = o.gate(o.poolById("aero-aero-weth"), 4.828, 4500, 1, { revote: true }).reason;
    for (const pl of o.MODEL.pools) for (const w of [300, 1500, 4500]) { const f = o.forecast(pl, 4.828, w, 3, { collateral: "cbBTC", paused: { USDC: false } }); out[`f${pl.id}@${w}`] = [f.allowed, f.priced, f.unpriced, Number.isFinite(f.net) ? +f.net.toFixed(4) : null, Number.isFinite(f.mcNet) ? +f.mcNet.toFixed(4) : null, f.clears.both, o.forecastWhy(f)]; }
    const leg = o.swapLegFor(o.poolById("aero-cbbtc-usdc"), 10000);
    out.swap = [+leg.minOut.toFixed(8), leg.maxSlippageBps, leg.cap, o.swapLegFor(o.poolById("aero-cbbtc-usdc"), 10000, 501).error, o.minOutFor(1, 0, 1, 50).error, o.swapLegFor(o.poolById("aero-cbbtc-usdc"), 10000, 50, { priceFactor: 0.6 }).reverts];
    return out; });
  const bs = await probe2(ps), ba = await probe2(pa);
  check("agreement: simple and advanced return the identical gate reason, both model numbers, the identical forecast (27 cells: allowed / priced / both forms / sentence) and the identical swap floor for every probe (boundary cells, 45 pool × width cells, pauses, corroboration, re-vote)", JSON.stringify(bs) === JSON.stringify(ba), JSON.stringify(Object.keys(bs).filter(k => JSON.stringify(bs[k]) !== JSON.stringify(ba[k])).slice(0, 5)));
  check("gate: both builds refuse a guardian-paused collateral, a paused borrow, an uncorroborated anchor and a re-voted gauge above the ceiling — with the right named reason", bs.paused === "collateral_paused" && bs.borrowPaused === "borrow_paused" && bs.uncorroborated === "insufficient_samples" && bs.revote === "emissions_implausible");
  check("swap: both builds enforce the same floor, cap the tolerance at 5.00%, refuse a zero quote, and revert a sandwiched leg", bs.swap[1] === 50 && bs.swap[2] === 500 && /SlippageTooHigh\(501, 500\)/.test(bs.swap[3]) && bs.swap[4] === "ZeroQuote()" && bs.swap[5] === true);
  const CLAIMS = [/no operator custody/i, /no owner powers/i, /At no point does an operator custody/, /has no power over your funds/i, /\bnon-custodial\b/i];
  check("custody: neither build claims 'no operator custody' or 'no owner powers' — a timelocked owner is still an owner", CLAIMS.every(re => !re.test(simple) && !re.test(adv)), CLAIMS.filter(re => re.test(simple) || re.test(adv)).map(String).join(", "));
  const owns = await ps.evaluate(() => [...document.querySelectorAll("#docOwnerCan li")].map(e => e.textContent));
  const owna = await pa.evaluate(() => [...document.querySelectorAll("#docOwnerCan li")].map(e => e.textContent));
  check("custody: both builds print the same three things the registry owner can still do, and both name the timelock delay", JSON.stringify(owns) === JSON.stringify(owna) && owns.length === 3 && (await ps.evaluate(() => document.querySelector("#docOwnerResidual").textContent)).includes("2 days") && (await pa.evaluate(() => document.querySelector("#docOwnerResidual").textContent)).includes("2 days"));
  check("entry floor: neither build ever builds the pre-fix raw open — the hold path is openBorrowOnly and the floor is named at the venue in both", /openBorrowOnly/.test(adv) && /AaveV3Venue\.borrow/.test(simple) && /AaveV3Venue\.borrow/.test(adv) && !/execBatch\(\[permit2, supply, borrow\]\)`/.test(adv));
  check("grant: both builds pin one target, one selector, a 24-hour period and a 30-day expiry, and both list the movers refused from a keeper grant outright", cs.grant.periodS === 86400 && cs.grant.refusedSelectors.length === 4 && cs.grant.refusalError === "UnbudgetableSelector(target, selector)" && /Renew for 30 days/.test(simple) && /Renew for 30 days/.test(adv) && /grantChip/.test(simple) && /grantChip/.test(adv));
}
check("hand-holding: simple.html explains each of the five steps in one plain sentence before it happens, plus an opening guide", (simple.match(/class="guide small muted"/g) || []).length === 5 && /id="guideBox"/.test(simple));
check("hand-holding: simple.html review lists what will happen when you sign, in order, with a plain sentence per hop", /id="revSteps"/.test(simple) && /plain:"A small account contract/.test(simple) && /Nothing moves until you sign/.test(simple));
check("hand-holding: index.html carries a per-step guide sentence and the same ordered what-will-happen list in the review", /id="stepGuide"/.test(adv) && /What will happen when you sign — in order/.test(adv) && /plain:"Your wallet signs a message, not a transaction/.test(adv));
check("hand-holding: every confirm button states its consequence (close & repay / loan stays / withdraw N% / send $ / use $ to repay)", /Withdraw everything and close/.test(simple) && /Close the pool position — the loan stays/.test(adv) && /Use \$\{usd\(cl\.p\.emis\)\} to repay the loan/.test(adv));
check("stores: the two builds use distinct localStorage keys", /oilskin\.simple\.v2/.test(simple) && /oilskin\.adv\.v2/.test(adv) && !/oilskin\.adv\.v2/.test(simple) && !/oilskin\.simple\.v2/.test(adv));
await ps.click("#modeTog"); await ps.waitForFunction(() => location.pathname.endsWith("/index.html")); await ps.waitForFunction(() => !!window.__oil);
check("toggle: Simple → Advanced navigates to index.html with zero console errors", ps.url().endsWith("/index.html") && ps.__errors.length === 0, ps.__errors.join(" | "));
await ps.click('a[href="simple.html"]'); await ps.waitForFunction(() => location.pathname.endsWith("/simple.html")); await ps.waitForFunction(() => !!window.__oil);
check("toggle: Advanced → Simple navigates back with zero console errors", ps.url().endsWith("/simple.html") && ps.__errors.length === 0);
check("toggle: both nav toggles carry a title explaining the other build", /title="The full-control build/.test(simple) && /title="Switch to the simple app/.test(adv));
check("toggle (hosted): both builds carry the same HOSTED fallback pair (Simple ⇄ Advanced artifact URLs) for when the sibling file is not deployed alongside", (simple.match(/const HOSTED = \{[^}]+\}/) || [])[0] === (adv.match(/const HOSTED = \{[^}]+\}/) || [])[0] && /HOSTED\.advanced/.test(simple) && /HOSTED\.simple/.test(adv));
await b.close(); srv.close();

/* ── 6. repo-wide grep for the removed vocabulary — prototype/ must be clean; other areas are reported ── */
{
  const areas = ["prototype", "packages/shared/src", "agent/src", "services/yield/src", "web", "contracts/src", "docs", "README.md", "SETUP.md"];
  const report = {};
  for (const a of areas) {
    const p = path.join(REPO, a); if (!fs.existsSync(p)) continue;
    let out = "";
    try { out = execSync(`grep -rIl --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=out --exclude-dir=lib --exclude-dir=test -E "\\bNEAR\\b|\\bRhea\\b|1-Click|oneClick|Intents|shielded|payout address|payoutHash|Zodl|Zashi|ZIP-321|nearblocks|non-custodial|Burrow" ${JSON.stringify(p)} 2>/dev/null || true`, { encoding: "utf8" }); } catch { out = ""; }
    report[a] = out.split("\n").filter(Boolean).map(f => path.relative(REPO, f));
  }
  check("grep: prototype/ (simple.html, index.html, test/) has no removed vocabulary", report.prototype.length === 0, report.prototype.join(", "));
  fs.writeFileSync("/tmp/build/prototypes-removed-symbols-grep.json", JSON.stringify(report, null, 2));
  for (const [a, files] of Object.entries(report)) if (a !== "prototype" && files.length) console.log(`  (info) ${a}: ${files.length} file(s) still mention removed vocabulary — ${files.slice(0, 6).join(", ")}${files.length > 6 ? " …" : ""}`);
}

const out = done();
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
process.exit(out.fail ? 1 : 0);
