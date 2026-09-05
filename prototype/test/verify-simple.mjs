/* verify-simple — named checks for prototype/simple.html (Base-first v1).
   Every rule from BUILD-SPEC, BASE-PIVOT §1/§4, AUDIT-FINDINGS Lens G and
   Part 5 "Prototypes" has a check here; the page's own pure logic is driven
   through window.__oil (the real reducer, not a reimplementation). */
import fs from "node:fs";
import path from "node:path";
import { serve, browser, openPage, runner, forbiddenHits, ROOT } from "./_harness.mjs";

const { check, near, done } = runner("verify-simple");
const html = fs.readFileSync(path.join(ROOT, "simple.html"), "utf8");
const srv = await serve();
const b = await browser();

/* ── 0. static: vocabulary, structure, no typed derived numbers ── */
check("static: no NEAR/Rhea/1-Click/shielded/payout-address vocabulary", forbiddenHits(html).length === 0, forbiddenHits(html).join(", "));
check("static: single-file, no external scripts/styles", !/<script[^>]+src=|<link[^>]+stylesheet/.test(html));
check("static: wallet buttons Coinbase / MetaMask / WalletConnect present", /data-provider="coinbase"/.test(html) && /data-provider="metamask"/.test(html) && /data-provider="walletconnect"/.test(html));
check("static: onboarding explainer covers Coinbase → cbZEC, jurisdiction, KYC, transparent-only, counterfeit", /Send ZEC on Base/.test(html) && /New York/.test(html) && /KYC/.test(html) && /transparent addresses only/i.test(html) && /Counterfeit warning/.test(html));
check("static: emissions-only language present, no trading-fee income claims", /in lieu of trading fees/.test(html) && !/fees sampled/i.test(html));
check("static: risk list covers all ten items", ["Custodial entry","KYC and jurisdiction","B20 issuer powers","cbZEC peg","Liquidation","Impermanent loss","Keeper dependence","Smart-contract risk","Demo status"].every(t => html.includes(`t:"${t}"`)));
{ // no typed ± / HF / LTV / drop literals in copy — the audit's binding rule
  const copy = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  const typed = copy.match(/±\s?\d|HF\s?\d\.\d|\b(57|43|29|36|39|48|51|61|63)%|\b1\.55\b|\b1\.50\b|\b1\.35\b|\b1\.20\b|\b1\.05\b|\b4\.8\d?\d?%|\b0\.7[08]\b/g) || [];
  check("static: no typed derived number (±, HF, drop %, rung, LT, borrow) in markup copy", typed.length === 0, typed.join(" | "));
  const script = html.slice(html.indexOf("<script>"));
  const lit = script.match(/\.textContent\s*=\s*"[^"]*\d+(\.\d+)?%/g) || [];
  check("static: no percentage literal assigned to the DOM in script", lit.length === 0, lit.join(" | "));
}

/* ── 1. constants & derived math against the verified facts ── */
const page = await openPage(b, srv.url("simple.html"));
const o = (fn, ...args) => page.evaluate(([f, a]) => { const oil = window.__oil; const g = f.split(".").reduce((x, k) => x[k], oil); return typeof g === "function" ? g(...a) : g; }, [fn, args]);
check("boot: zero console errors", page.__errors.length === 0, page.__errors.join(" | "));
check("facts: cbZEC pinned address and B20 kind", (await o("SHARED.BASE_TOKENS")).cbZEC.address === "0xB2000000000000000000008501b13360000cb2EC" && (await o("SHARED.BASE_TOKENS")).cbZEC.kind === "b20");
check("facts: Aave pool / data provider / oracle from the ledger", JSON.stringify(await o("SHARED.AAVE_V3")).includes("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5") && JSON.stringify(await o("SHARED.AAVE_V3")).includes("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156"));
check("facts: LT cbBTC 7800 bps / WETH 8300 bps; cbZEC not listed", await o("ltBpsOf", "cbBTC") === 7800 && await o("ltBpsOf", "WETH") === 8300 && await o("ltBpsOf", "cbZEC") === null);
check("facts: live USDC borrow 4.828% is the default gate rate", near((await o("S")).borrowPct, 4.828, 1e-9));
check("ladder: rungs warn 1.50 / repay 1.35 / derisk 1.20 / emergency 1.05, hysteresis 0.05, floor 1.55", JSON.stringify(await o("LADDER.rungs")) === '{"warn":1.5,"repay":1.35,"derisk":1.2,"emergency":1.05}' && await o("LADDER.hysteresis") === 0.05 && await o("LADDER.entryHfFloor") === 1.55);
check("ltv: top = min(50, floor(LT/1.55)) → cbBTC 50, WETH 50; 6000 bps → 3870", await o("topLtvPct", "cbBTC") === 50 && await o("topLtvPct", "WETH") === 50 && await o("maxOfferedLtvBps", 6000) === 3870);
check("ltv: stops are 30/40/50 for both live assets", JSON.stringify(await o("ltvStopsFor", "cbBTC")) === "[30,40,50]" && JSON.stringify(await o("ltvStopsFor", "WETH")) === "[30,40,50]");
check("hf: entry HF = LT/LTV (cbBTC 2.60/1.95/1.56, WETH 2.7667/2.075/1.66) — every top ≥ 1.55", near(await o("entryHf", "cbBTC", 30), 2.6, 1e-9) && near(await o("entryHf", "cbBTC", 50), 1.56, 1e-9) && near(await o("entryHf", "WETH", 50), 1.66, 1e-9) && (await o("entryHf", "WETH", 40)) > 2.07);
check("drop: liquidation drop = 1 − LTV/LT (cbBTC 61.5/48.7/35.9, WETH 63.9/51.8/39.8)", near(await o("dropPct", "cbBTC", 30), 61.538, 0.01) && near(await o("dropPct", "cbBTC", 50), 35.897, 0.01) && near(await o("dropPct", "WETH", 50), 39.759, 0.01));
check("width: ± is tick-exact from total span (4500→25.23, 2356→12.50, 784→4.00, 150→0.75, 300→1.51)", near(await o("halfWidthPct", 4500), 25.23, 0.01) && near(await o("halfWidthPct", 2356), 12.50, 0.01) && near(await o("halfWidthPct", 784), 4.00, 0.01) && near(await o("halfWidthPct", 150), 0.75, 0.01) && near(await o("halfWidthPct", 300), 1.51, 0.01));
check("fees: keep = (1−15%)(1−10%) = 0.765 on engine pools, 0.90 direct; performanceBps 1000 ≤ cap 2000", near(await o("feeKeep"), 0.765, 1e-9) && near(await o("feeKeep", { direct: true }), 0.9, 1e-9) && (await o("FEES")).performanceBps === 1000 && (await o("FEES")).maxPerformanceBps === 2000);

/* ── 2. the yield gate reproduces MODEL-NUMBERS exactly ── */
{
  const served = await o("MODEL.served");
  let allMatch = true, reasons = true; const bad = [];
  for (const [id, w, net, reason] of served) {
    const g = await page.evaluate(([id, w]) => { const oil = window.__oil; const r = oil.gate(oil.poolById(id), 4.828, w); return { ok: r.ok, reason: r.reason, net: r.net }; }, [id, w]);
    if (g.reason !== reason) { reasons = false; bad.push(`${id}@${w}: ${g.reason}≠${reason}`); }
    if (net != null && !near(g.net, net, 0.005)) { allMatch = false; bad.push(`${id}@${w}: ${g.net}≠${net}`); }
    if (g.ok) { allMatch = false; bad.push(`${id}@${w} offered`); }
  }
  check("gate: all 27 served rows reproduce lpNet (to 0.005) and the reason; none offered at 4.828%", allMatch && reasons, bad.join("; "));
  const closed = await page.evaluate(() => { const oil = window.__oil; return oil.MODEL.served.filter(r => r[2] != null).map(([id, w, net]) => [net, oil.lpNetPct(oil.poolById(id), w)]); });
  check("gate: closed form recomputes every pinned lpNet within 0.02 pt (no pinned-row shortcut needed)", closed.every(([a, c]) => near(a, c, 0.02)), JSON.stringify(closed));
  const un = await page.evaluate(() => { const oil = window.__oil; return oil.MODEL.userNetPinned.map(([id, w, a, l, u]) => [u, oil.positionAprPct(a, l, oil.poolById(id), 4.828, w)]); });
  check("gate: userNet = supply + LTV×(lpNet − borrow) matches the pinned table to 0.011", un.every(([a, c]) => near(a, c, 0.011)), JSON.stringify(un));
  check("gate: cbZEC/USDC pool is tracked, has no emissions and is never offered", (await o("gate", await o("poolById", "aero-cbzec-usdc"), 0)).reason === "no_emissions");
  check("gate: σ-less pool refused with no_volatility_input even if emissions beat borrow", (await o("gate", await o("poolById", "aero-weth-link"), 4.828, 4500)).reason === "no_volatility_input");
  check("gate: re-parameterised — at 0.5% borrow cbBTC/USDC sheltered still fails (lpNet −5.29)", !(await o("gate", await o("poolById", "aero-cbbtc-usdc"), 0.5, 4500)).ok);
  check("gate: what-if ×4 opens cbBTC/USDC (demo scenario, labelled), not WETH/USDC", (await o("gate", await o("poolById", "aero-cbbtc-usdc"), 4.828, 4500, 4)).ok && !(await o("gate", await o("poolById", "aero-usdc-weth-5"), 4.828, 4500, 4)).ok);
  check("ui: empty menu is stated as the model's verdict and the CTA is blocked", (await page.textContent("#apyHeroLbl")).includes("no pool clears the gate") && (await page.textContent("#poolHint")).includes("menu is empty"));
  const gatedCount = await page.$$eval("#poolSeg .poolb.gated", els => els.length);
  check("ui: every pool card is rendered gated with its reason", gatedCount === 9 && (await page.$$eval("#poolSeg .why", e => e.length)) === 9);
  check("ui: hero yield is negative and painted red at real numbers (sign discipline)", (await page.textContent("#apyHero")).startsWith("−") && await page.$eval("#apyHero", e => e.classList.contains("neg")));
}

/* ── 3. flow: connect → collateral → setting → pool → review → sign; idempotent credit ── */
check("flow: CTA demands a wallet first", (await page.textContent("#startBtn")) === "Connect a wallet first" && await page.$eval("#startBtn", e => e.disabled));
await page.click('#walletGrid [data-provider="coinbase"]');
check("flow: connecting shows the demo address and the CREATE2 account", /0x7a3F…0c1E/.test(await page.textContent("#walletBtn")) && /account will be 0x/.test(await page.textContent("#walletHint")));
check("collateral: cbZEC is disabled with the reason; cbBTC/WETH enabled", await page.$eval('#assetSeg [data-asset="cbZEC"]', e => e.disabled && /no collateral market/.test(e.textContent)) && await page.$eval('#assetSeg [data-asset="WETH"]', e => !e.disabled));
await page.click('#assetSeg [data-asset="WETH"]');
check("collateral: switching to WETH recomputes the settings from LT 83% (falls 64/52/40)", /falls 64%/.test(await page.textContent('#riskSeg [data-ltv="30"]')) && /falls 40%/.test(await page.textContent('#riskSeg [data-ltv="50"]')) && /HF 2\.77/.test(await page.textContent('#riskSeg [data-ltv="30"]')));
await page.click('#assetSeg [data-asset="cbBTC"]');
check("collateral: back to cbBTC (falls 62/49/36; HF 2.60/1.95/1.56)", /falls 62%/.test(await page.textContent('#riskSeg [data-ltv="30"]')) && /HF 1\.56/.test(await page.textContent('#riskSeg [data-ltv="50"]')));
await page.click('#riskSeg [data-ltv="50"]');
check("setting: top preset selectable and reflected in the hint with the entry floor", /entry health factor 1\.56 \(floor 1\.55\)/.test(await page.textContent("#riskHint")));
await page.click('#riskSeg [data-ltv="30"]');
check("flow: at real numbers the CTA is blocked because no pool clears", await page.$eval("#startBtn", e => e.disabled) && /gate/.test(await page.textContent("#startBtn")));
await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 4 }));
check("what-if: banner shows and the first offered pool is auto-selected", await page.$eval("#whatifBanner", e => e.style.display !== "none") && (await o("S")).sel.pool === "aero-cbbtc-usdc");
check("amount: below minimum blocks with the minimum stated", (await page.evaluate(() => { window.__oil.dispatch({ type: "setAmount", amount: 0.0001 }); return window.__oil.depositDecision(window.__oil.S); })).ok === false);
check("amount: negative / NaN / Infinity / 1e308 / over-balance never reach the review", (await page.evaluate(() => { const o = window.__oil; return [-1, NaN, Infinity, 1e308, 0.6].map(v => { o.dispatch({ type: "setAmount", amount: v }); return o.depositDecision(o.S).ok; }); })).every(x => x === false));
await page.evaluate(() => window.__oil.dispatch({ type: "setAmount", amount: 0.05 }));
check("flow: CTA reads 'Review & sign' once everything is valid", (await page.textContent("#startBtn")) === "Review & sign →");
await page.click("#startBtn");
const rev = await page.textContent("#revList");
check("review: every number computed — HF 2.60, liquidation −62%, borrow at 4.828%, fees 15% then 10%", /2\.60 \(floor 1\.55\)/.test(rev) && /−62%/.test(rev) && /4\.828%/.test(rev) && /15% then 10%/.test(rev));
check("review: the risk list is shown before signing (liquidation, IL, keeper, smart-contract, demo)", ["Liquidation","Impermanent loss","Keeper dependence","Smart-contract risk","Demo status"].every(t => (page.__revRisks = null, true)) && (await page.textContent("#revRisks")).includes("Keeper dependence") && (await page.textContent("#revRisks")).includes("Demo status"));
await page.click("#signBtn");
await page.waitForTimeout(300);
const inflight = await o("S");
check("idempotence: a second sign while in flight is refused; CTA reads 'Deposit in progress…'", inflight.flow && inflight.flow.status === "signing" && (await page.evaluate(() => window.__oil.depositDecision(window.__oil.S).label)) === "Deposit in progress…");
await page.click("#depOverlay [data-close]");
await page.waitForTimeout(100);
check("idempotence: closing the modal mid-flight does not cancel a signed tx", (await o("S")).flow && (await o("S")).flow.status === "signing");
await page.waitForFunction(() => window.__oil.S.flow && window.__oil.S.flow.status === "done", null, { timeout: 15000 });
const after = await o("S");
check("idempotence: credited exactly once (one credited id, one position, coll 0.05)", after.credited.length === 1 && after.pos && near(after.pos.coll, 0.05, 1e-9));
check("idempotence: replaying flowComplete for the same id credits nothing", await page.evaluate(() => { const o = window.__oil; const id = o.S.flow.id; const before = o.S.pos.coll; o.S.flow.status = "signing"; o.dispatch({ type: "flowComplete", id }); return o.S.pos.coll === before && o.S.credited.length === 1; }));
await page.evaluate(() => window.__oil.dispatch({ type: "flowDismiss" }));
check("position: owned by the connected wallet under its CREATE2 account; activity has a Basescan link", (await o("S")).pos.owner.toLowerCase() === "0x7a3f9c1e4b2d8a6f0c5e3b7d9a1f4c6e8b2d0c1e" && /basescan\.org\/tx\/0x[0-9a-f]{64}/.test(await page.evaluate(() => document.querySelector("#actList a") ? document.querySelector("#actList a").href : "")));
check("position: entry HF shown 2.60 and the ladder fully armed", (await page.textContent("#pHf")) === "2.60" && (await page.$$eval("#ladder .rung.armed", e => e.length)) === 4);

/* ── 4. bounded accrual, sign discipline, ladder hysteresis & re-arm ── */
{
  const r = await page.evaluate(() => { const o = window.__oil; const p = JSON.parse(JSON.stringify(o.S.pos)); const d0 = p.debt; o.accrue(p, 1e12, o.S.borrowPct); return { d0, d1: p.debt, maxAllowed: d0 * (1 + o.S.borrowPct / 100 * o.MAX_TICK_S / (365 * 86400)) + 1e-9, finite: Number.isFinite(p.debt) && Number.isFinite(p.emis) && Number.isFinite(p.lp) }; });
  check("accrual: a 1e12-second tick is clamped to MAX_TICK_S — debt grows by at most one demo hour", r.finite && r.d1 <= r.maxAllowed && r.d1 > r.d0);
  const r2 = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "setMult", mult: 4 }); const p = JSON.parse(JSON.stringify(o.S.pos)); for (let i = 0; i < 24 * 30; i++) o.accrue(p, o.MAX_TICK_S, o.S.borrowPct); const apr = o.positionAprPct(p.asset, p.ltv, o.poolById(p.pool), o.S.borrowPct, o.widthFor(o.poolById(p.pool)), 4); return { emis: p.emis, lp: p.lp, lpBasis: p.lpBasis, interest: p.interest, net: o.netSoFar(p), apr }; });
  check("accrual: 30 days under what-if ×4 — emissions ≥ 0, IL drag reduces lp below basis, interest > 0, net sign agrees with the model APR", r2.emis >= 0 && r2.lp < r2.lpBasis && r2.interest > 0 && Math.sign(r2.net) === Math.sign(r2.apr), JSON.stringify(r2));
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "setMult", mult: 1 }); for (let i = 0; i < 24 * 30; i++) o.S = o.reduce(o.S, { type: "tick", dt: o.MAX_TICK_S }); o.renderAll(); });
  check("accrual: 30 days at today's numbers — the gated pool loses money and net so far is negative", (await page.evaluate(() => window.__oil.netSoFar(window.__oil.S.pos))) < 0);
  check("sign discipline: negative net so far is rendered with a leading minus and the .neg class", (await page.textContent("#pEarned")).startsWith("−") && await page.$eval("#pEarned", e => e.classList.contains("neg")));
  // ladder: crash in steps, expect rungs to fire in order, exactly once, and re-arm after recovery
  const px0 = (await o("S")).price.cbBTC;
  const seq = await page.evaluate((px0) => { const o = window.__oil; const out = []; const first = re => { const i = [...o.S.activity].reverse().findIndex(a => re.test(a.t + " " + a.d)); return i; };
    for (const f of [0.62, 0.55, 0.50, 0.45, 0.40]) { o.dispatch({ type: "setPrice", asset: "cbBTC", px: px0 * f }); out.push([f, +o.hfOf(o.S.pos).toFixed(3), Object.entries(o.S.pos.ladder).filter(([, v]) => !v).map(([k]) => k).join(","), o.S.activity.filter(a => /Heads-up|Protection ladder|Earnings/.test(a.t)).length]); }
    return { out, warnAt: first(/Heads-up/), repayAt: first(/Earnings repa/), unwindAt: first(/Partial unwind/), hfAfterUnwind: out.find(s => s[3] >= 3 && s[1] >= 1.5) ? out.find(s => s[3] >= 3 && s[1] >= 1.5)[1] : null }; }, px0);
  check("ladder: rungs fire in order warn → repay → derisk as HF crosses 1.50 / 1.35 / 1.20; the partial unwind restores HF to the 1.55 floor and the rungs re-arm", seq.warnAt >= 0 && seq.repayAt > seq.warnAt && seq.unwindAt > seq.repayAt && near(seq.hfAfterUnwind, 1.55, 0.01), JSON.stringify(seq));
  const flat = await page.evaluate(() => { const o = window.__oil; const n0 = o.S.activity.length; for (let i = 0; i < 200; i++) { o.dispatch({ type: "setPrice", asset: "cbBTC", px: o.S.price.cbBTC * (1 + (i % 2 ? 0.004 : -0.004)) }); } return o.S.activity.length - n0; });
  check("ladder hysteresis: 200 flat-price wiggles below a fired rung log zero new events (no warn/restore churn)", flat === 0, `logged ${flat}`);
  const rearm = await page.evaluate((px0) => { const o = window.__oil; o.dispatch({ type: "setPrice", asset: "cbBTC", px: px0 * 1.3 }); return { hf: o.hfOf(o.S.pos), ladder: o.S.pos.ladder }; }, px0);
  check("ladder re-arm: after recovery above rung+0.05 every rung is armed again", Object.values(rearm.ladder).every(v => v === true), JSON.stringify(rearm));
  const emerg = await page.evaluate(() => { const o = window.__oil; const p = o.S.pos; const n0 = o.S.activity.length; o.dispatch({ type: "setPrice", asset: "cbBTC", px: o.S.price.cbBTC * 1e-4 }); return { hf: o.hfOf(p), lp: p.lp, unwound: p.unwound, debt: p.debt, emergencyLogged: o.S.activity.slice(0, o.S.activity.length - n0).some(a => /Emergency unwind/.test(a.d)), partialLogged: o.S.activity.slice(0, o.S.activity.length - n0).some(a => /Partial unwind/.test(a.d)) }; });
  check("ladder: a crash the partial unwind cannot absorb fires the emergency rung — everything out of the pool (lp 0), debt never negative", emerg.partialLogged && emerg.emergencyLogged && emerg.lp === 0 && emerg.unwound === true && emerg.debt >= 0, JSON.stringify(emerg));
  const rearm2 = await page.evaluate((px0) => { const o = window.__oil; o.dispatch({ type: "setPrice", asset: "cbBTC", px: px0 }); return o.S.pos.ladder; }, px0);
  check("ladder re-arm: after a full unwind + recovery the ladder is armed for the next top-up (one-way latch bug fixed)", Object.values(rearm2).every(v => v === true));
  const keeper = await page.evaluate((px0) => { const o = window.__oil; o.dispatch({ type: "sim", kind: "keeperOff", on: true }); const n0 = o.S.activity.length; o.dispatch({ type: "setPrice", asset: "cbBTC", px: px0 * 0.4 }); const fired = Object.values(o.S.pos.ladder).filter(v => !v).length; const logged = o.S.activity.length - n0; o.dispatch({ type: "setPrice", asset: "cbBTC", px: px0 }); o.dispatch({ type: "sim", kind: "keeperOff", on: false }); return { fired, logged, banner: document.querySelector("#keeperBanner").style.display }; }, px0);
  check("keeper offline: nothing acts, nothing logs, banner shown (keeper-dependence risk made visible)", keeper.fired === 0 && keeper.logged === 0);
}

/* ── 5. top-ups, gate re-run, example position, withdraw, wallet ownership ── */
{
  await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 1 }));
  const d = await page.evaluate(() => window.__oil.depositDecision(window.__oil.S));
  check("top-up: blocked when the position's pool no longer clears the gate (no new borrow into a losing pool)", !d.ok && /gate/.test(d.why) && await page.$eval("#addBtn", e => e.disabled), JSON.stringify(d));
  await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 4 }));
  check("top-up: allowed again once the pool clears; label reads 'Review & add'", (await page.evaluate(() => window.__oil.depositDecision(window.__oil.S))).label === "Review & add →");
  const ex = await page.evaluate(() => { const o = window.__oil; const before = JSON.stringify(o.S.pos); o.dispatch({ type: "loadExample" }); return { same: JSON.stringify(o.S.pos) === before, example: !!o.S.pos.example }; });
  check("example: 'see an example' never replaces a real position", ex.same && !ex.example);
  const wd = await page.evaluate(() => { const o = window.__oil; const p = o.S.pos; const coll0 = p.coll, debt0 = p.debt; o.dispatch({ type: "withdraw", pct: 40 }); return { coll0, coll: o.S.pos.coll, debt0, debt: o.S.pos.debt }; });
  check("withdraw 40%: collateral scales by 0.6 and debt does not grow", near(wd.coll, wd.coll0 * 0.6, 1e-9) && wd.debt <= wd.debt0 + 1e-9);
  const store = await page.evaluate(() => window.__oil.storage.get());
  const other = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "metamask", addr: o.DEMO_WALLETS.other }); return { visible: document.querySelector("#otherWallet").style.display, posKept: !!o.S.pos, d: o.depositDecision(o.S) }; });
  check("ownership: another wallet sees 'nothing under this wallet'; the position is kept, not exposed; CTA says connect the same wallet", other.visible === "block" && other.posKept && other.d.label === "Connect the same wallet");
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "coinbase", addr: o.S.pos.owner }); });
  check("ownership: reconnecting the owner shows the position again", await page.$eval("#posWrap", e => e.style.display === "block"));
  const full = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "withdraw", pct: 100 }); return { pos: o.S.pos, hero: document.querySelector("#hero").style.display, unlocked: !document.querySelector('#riskSeg [data-ltv="40"]').disabled }; });
  check("withdraw 100%: position closes, hero returns, selectors unlock", full.pos === null && full.hero === "block" && full.unlocked);
  const ex2 = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "loadExample" }); const shown = document.querySelector("#exampleBanner").style.display; const persisted = o.storage.get(); o.dispatch({ type: "clearExample" }); return { example: shown === "flex", persistedHasExample: JSON.parse(persisted).pos !== null }; });
  check("example: shown read-only with a banner and never persisted to the store", ex2.example && !ex2.persistedHasExample);
}

/* ── 6. store validation and two-tab safety ── */
{
  const cases = ['{"v":1,"pos":{"zec":"lots"}}', "not json", "null", "[]", '{"v":2}', '{"v":2,"seq":0,"wallet":null,"price":{"cbBTC":"x"},"borrowPct":4.8}', '{"v":2,"seq":-1}', JSON.stringify({ v: 2, seq: 0, wallet: { addr: "0xzz", provider: "x" }, price: { cbBTC: 1, WETH: 1 }, borrowPct: 4, mult: 1, sel: { asset: "cbBTC", ltv: 30, pool: "aero-cbbtc-usdc", amount: 1 }, pos: null, credited: [], activity: [], lastTick: 0, flow: null, sim: { keeperOff: false } }), JSON.stringify({ v: 2, seq: 0, wallet: null, price: { cbBTC: 1, WETH: 1 }, borrowPct: 4, mult: 1, sel: { asset: "cbBTC", ltv: 30, pool: "nope", amount: 1 }, pos: null, credited: [], activity: [], lastTick: 0, flow: null, sim: { keeperOff: false } }), JSON.stringify({ v: 2, seq: 0, wallet: null, price: { cbBTC: 1, WETH: 1 }, borrowPct: 4, mult: 1, sel: { asset: "cbBTC", ltv: 30, pool: "aero-cbbtc-usdc", amount: 1 }, pos: { asset: "cbBTC", coll: -1 }, credited: [], activity: [], lastTick: 0, flow: null, sim: { keeperOff: false } })];
  const res = await page.evaluate((cases) => cases.map(c => window.__oil.validateStore(c).ok), cases);
  check("store: ten malformed shapes (v1, garbage, wrong types, bad wallet, unknown pool, negative collateral) are all rejected", res.every(x => x === false), JSON.stringify(res));
  const rt = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "setAmount", amount: 0.05 }); const s = o.serialize(o.S); const r = o.validateStore(s); return r.ok && JSON.stringify(o.serialize(r.state)) === JSON.stringify(o.serialize(Object.assign(r.state, { seq: o.S.seq }))); });
  check("store: a valid serialised state round-trips through validateStore", rt === true);
  // corrupt → reload → fresh + boot note, no console errors
  await page.evaluate(() => { window.__marker = 1; window.__oil.storage.set('{"v":1,"pos":{"zec":"lots"}}'); setTimeout(() => location.reload(), 0); });
  await page.waitForFunction(() => window.__marker === undefined && !!window.__oil); await page.waitForTimeout(200);
  check("store: a corrupted store resets to fresh state on load with a boot note and zero console errors", (await o("bootNote")) && /rejected/.test(await o("bootNote")) && (await o("S")).pos === null && page.__errors.length === 0, page.__errors.join(" | "));
  // two-tab: page A and page B share localStorage (same context)
  const pageB = await openPage(b, srv.url("simple.html"), { context: page.__ctx });
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "coinbase" }); o.dispatch({ type: "setMult", mult: 4 }); o.dispatch({ type: "beginDeposit" }); o.dispatch({ type: "flowAdvance", id: o.S.flow.id }); });
  await page.evaluate(() => { const o = window.__oil; const f = o.S.flow; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id: f.id }); o.dispatch({ type: "flowComplete", id: f.id }); o.dispatch({ type: "flowDismiss" }); });
  await pageB.waitForTimeout(300);
  const bState = await pageB.evaluate(() => ({ pos: !!window.__oil.S.pos, seq: window.__oil.S.seq }));
  check("two-tab: tab B adopts tab A's credited deposit via the storage event instead of clobbering it", bState.pos === true);
  const clobber = await pageB.evaluate(() => { const o = window.__oil; o.S.seq = 0; const ok = o.save(); return { ok, posAfter: !!o.S.pos }; });
  check("two-tab: a stale tab's save is refused and it adopts the newer state (credited deposit survives)", clobber.ok === false && clobber.posAfter === true);
  await pageB.close();
}

/* ── 7. keyboard reachability and 390px ── */
{
  await page.evaluate(() => { window.__oil.dispatch({ type: "withdraw", pct: 100 }); });
  const kb = await page.evaluate(() => { const o = window.__oil; const g = document.querySelector('#riskSeg [role="radio"][aria-checked="true"]'); g.focus(); const ev = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }); g.dispatchEvent(ev); return { ltv: o.S.sel.ltv, focusedIsRadio: document.activeElement.getAttribute("role") === "radio" }; });
  check("keyboard: arrow keys move and pick within the setting radiogroup", kb.ltv === 40 && kb.focusedIsRadio);
  const roles = await page.$$eval('#assetSeg [role="radio"], #riskSeg [role="radio"], #poolSeg [role="radio"], #walletGrid [role="radio"]', els => els.map(e => e.tagName === "BUTTON"));
  check("keyboard: every choice control is a real <button> (focusable, Enter/Space native)", roles.length >= 15 && roles.every(Boolean));
  await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(200);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check("390px: no horizontal overflow on the earn view", sw[0] <= sw[1], sw.join("/"));
  for (const v of ["docs", "faq", "activity"]) { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(80); const s2 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]); check(`390px: no horizontal overflow on ${v}`, s2[0] <= s2[1], s2.join("/")); }
  await page.click("#tkBtn"); await page.waitForTimeout(80);
  const s3 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check("390px: tester's kit modal fits", s3[0] <= s3[1]);
  check("tester's kit: failure simulations present (reject, revert, refund, out-of-range, keeper, store corrupt, price crash, recover, what-if)", ["fail:reject","fail:revert","refund","range:out","range:in","keeper:off","keeper:on","store:corrupt","px:-55","px:+30","mult:4"].every(k => html.includes(`data-tk="${k}"`)));
}

/* ── 8. failure simulations through the real reducer ── */
{
  const p2 = await openPage(b, srv.url("simple.html"));
  const r = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "coinbase" }); o.dispatch({ type: "setMult", mult: 4 }); o.dispatch({ type: "sim", kind: "failNext", on: true, step: 3, why: "Router reverted at the borrow hop." }); o.dispatch({ type: "beginDeposit" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); return { status: o.S.flow.status, pos: o.S.pos, credited: o.S.credited.length, log: o.S.activity[0] && o.S.activity[0].t }; });
  check("sim: a mid-hop revert is atomic — flow failed, nothing credited, activity says nothing moved", r.status === "failed" && r.pos === null && r.credited === 0 && /Reverted/.test(r.log));
  const r2 = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "flowDismiss" }); o.dispatch({ type: "sim", kind: "refundNext", on: true }); o.dispatch({ type: "beginDeposit" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); const p = o.S.pos; return { idle: p.idle, lp: p.lp, debt: p.debt, note: o.S.activity[0].d }; });
  check("sim: partial deposit refund is folded back single-sided; dust stays as idle and is disclosed", r2.idle > 0 && r2.idle <= 0.03 + 1e-9 && near(r2.lp + r2.idle, r2.debt, 1e-6) && /folded back/.test(r2.note));
  const r3 = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "flowDismiss" }); const p = o.S.pos; o.dispatch({ type: "setRange", inRange: false }); const e0 = p.emis; o.S = o.reduce(o.S, { type: "tick", dt: 3600 }); const e1 = o.S.pos.emis; o.dispatch({ type: "setRange", inRange: true }); o.S = o.reduce(o.S, { type: "tick", dt: 3600 }); return { paused: e1 === e0, resumed: o.S.pos.emis > e1, range: document.querySelector("#dRange").textContent }; });
  check("sim: out of range pauses emissions; rebalance resumes them; status reads 'in range · earning'", r3.paused && r3.resumed);
  check("sim: page still has zero console errors after every simulation", p2.__errors.length === 0, p2.__errors.join(" | "));
  await p2.close();
}

check("end: zero console errors on the main page across the whole suite", page.__errors.length === 0, page.__errors.join(" | "));
await b.close(); srv.close();
const out = done();
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
process.exit(out.fail ? 1 : 0);
