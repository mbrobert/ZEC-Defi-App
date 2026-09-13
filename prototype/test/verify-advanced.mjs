/* verify-advanced — named checks for prototype/index.html (the Base module, Advanced, full control).
   Covers the Lens H findings (net-APY sign, 100% LP withdrawal keeps debt, one
   position per confirm, absurd amounts, width bounds and computed ±, keyboard
   reachability) plus the pivot rules shared with the simple build. */
import fs from "node:fs";
import path from "node:path";
import { serve, browser, openPage, runner, forbiddenHits, ROOT } from "./_harness.mjs";

const { check, near, done } = runner("verify-advanced");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const srv = await serve();
const b = await browser();

/* ── 0. static ── */
check("static: no NEAR/Rhea/1-Click/shielded/payout-address vocabulary", forbiddenHits(html).length === 0, forbiddenHits(html).join(", "));
check("static: single-file, no external scripts/styles", !/<script[^>]+src=|<link[^>]+stylesheet/.test(html));
check("static: wallet buttons in wizard and modal (Coinbase / MetaMask / WalletConnect)", (html.match(/data-provider="coinbase"/g) || []).length >= 2 && /data-provider="walletconnect"/.test(html));
check("static: Risks & cbZEC tab with onboarding, jurisdiction, KYC, transparent-only, counterfeit checker", /Send ZEC on Base/.test(html) && /New York/.test(html) && /KYC/.test(html) && /transparent addresses only/i.test(html) && /id="cfInput"/.test(html));
check("static: risk list covers all items", ["Custodial entry","KYC and jurisdiction","B20 issuer powers","cbZEC peg","Liquidation","Impermanent loss","Keeper dependence","Smart-contract risk","Demo status"].every(t => html.includes(`t:"${t}"`)));
check("static: emissions-only language; no 'fees sampled' income claims", /in lieu of trading fees/.test(html) && !/fees sampled/i.test(html));
check("static: strategies = leveraged LP / hold USDC / supply only / spot via CoW", /data-mode="LP"/.test(html) && /data-mode="HOLD"/.test(html) && /data-mode="SUPPLY"/.test(html) && /data-mode="SPOT"/.test(html));
{
  const copy = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  const typed = copy.match(/±\s?\d|HF\s?\d\.\d|\b(57|43|29|36|39|48|51|61|63)%|\b1\.55\b|\b1\.50\b|\b1\.35\b|\b1\.20\b|\b1\.05\b|\b4\.8\d?\d?%|\b0\.7[08]\b|\b(70|78|83)%/g) || [];
  check("static: no typed derived number (±, HF, drop %, rung, LT, borrow) in markup copy", typed.length === 0, typed.join(" | "));
  const rangeAttrs = copy.match(/id="(rw|prmRw)"[^>]*/g) || [];
  check("static: width sliders carry no typed bounds other than the engine's [150, 5000]", rangeAttrs.length === 2 && rangeAttrs.every(a => /min="150"/.test(a) && /max="5000"/.test(a)), rangeAttrs.join(" | "));
}

/* ── 1. boot, constants, shared-block parity with simple.html ── */
const page = await openPage(b, srv.url("index.html"));
const o = (fn, ...args) => page.evaluate(([f, a]) => { const oil = window.__oil; const g = f.split(".").reduce((x, k) => x[k], oil); return typeof g === "function" ? g(...a) : g; }, [fn, args]);
/* The borrow rate the pinned model was generated at (OIL_MODEL.borrowPctAtGeneration): every check that reproduces a MODEL-NUMBERS row uses it, never a literal (slice K, 2026-09-12). */
const B = await o("MODEL.borrowPctAtGeneration");
check("boot: zero console errors", page.__errors.length === 0, page.__errors.join(" | "));
check("boot: no wallet → dashboard shows the connect banner; positions are per-wallet", await page.$eval("#noWalletBanner", e => e.style.display !== "none") && /Connect a wallet/.test(await page.textContent("#posList")));
check("facts: LT cbBTC 7800 / WETH 8300; top 62/66 at the 1.25 floor (no product cap); 6000 → 4800", await o("ltBpsOf", "cbBTC") === 7800 && await o("ltBpsOf", "WETH") === 8300 && await o("topLtvPct", "cbBTC") === 62 && await o("topLtvPct", "WETH") === 66 && await o("maxOfferedLtvBps", 6000) === 4800);
check("facts: ladder & fees mirror shared (the 1.25 floor's rungs)", JSON.stringify(await o("LADDER.rungs")) === '{"warn":1.23,"repay":1.16,"derisk":1.09,"emergency":1.05}' && (await o("FEES")).performanceBps === 1000 && (await o("SHARED.RANGE_WIDTH_BOUNDS")).max === 5000);
{
  const served = await o("MODEL.served");
  const bad = [];
  for (const [id, w, net, reason] of served) { const g = await page.evaluate(([id, w]) => { const oil = window.__oil; const r = oil.gate(oil.poolById(id), oil.MODEL.borrowPctAtGeneration, w); return { ok: r.ok, reason: r.reason, net: r.net }; }, [id, w]); if (g.reason !== reason || (net != null && !near(g.net, net, 0.005)) || g.ok !== (reason === "ok")) bad.push(`${id}@${w}`); }
  check(`gate: all 27 served MODEL-NUMBERS rows reproduce at the model's borrow ${B}%; offered exactly where the doc says ok`, bad.length === 0, bad.join(", "));
  const offeredDoc = served.filter(r => r[3] === "ok").map(r => `${r[0]}@${r[1]}`);
  const sweep = await page.evaluate(() => { const oil = window.__oil; const B = oil.MODEL.borrowPctAtGeneration; const out = []; for (const p of oil.MODEL.pools) for (let w = oil.SHARED.RANGE_WIDTH_BOUNDS.min; w <= oil.SHARED.RANGE_WIDTH_BOUNDS.max; w += 25) { const g = oil.gate(p, B, w); if (g.ok) out.push([p.id, w, g.net]); } return out; });
  check(`net-APY model: across 9 pools × every width 150..5000 (step 25) the gate offers a width only for a pool whose PRESET cell the doc offers (${offeredDoc.length === 0 ? "none today" : offeredDoc.join(", ")}) — nothing flips positive off the doc (Lens H High)`, sweep.every(([id]) => offeredDoc.some(o => o.startsWith(id + "@"))), JSON.stringify(sweep.slice(0, 5)));
  const mono = await page.evaluate(() => { const oil = window.__oil; const p = oil.poolById("aero-cbbtc-usdc"); let prev = null, ok = true; for (let w = 5000; w >= 150; w -= 10) { const n = oil.lpNetPct(p, w); if (prev !== null && n > prev + 1e-9) ok = false; prev = n; } return ok; });
  check("net-APY model: lpNet is monotone non-increasing as the band tightens (drag grows faster than emissions)", mono);
}

/* ── 2. wizard: wallet, collateral, amount, strategy ── */
await page.click(".tab[data-view=wiz]");
check("wizard: Continue demands a wallet", (await page.textContent("#nextBtn")) === "Connect a wallet first");
await page.click('#wizWallets [data-provider="metamask"]');
check("wizard: MetaMask (demo) connected; account address shown", /0x7a3F…0c1E/.test(await page.textContent("#connectBtn")) && /account 0x/.test(await page.textContent("#wizWalletHint")));
check("collateral: cbZEC listed 'spot only' with the shared disabledReason on hover; cbBTC/WETH enabled", /cbZEC · spot only/.test(await page.textContent("#assetSeg")) && await page.$eval('#assetSeg [data-asset="cbZEC"]', e => /No lending market accepts cbZEC/.test(e.dataset.tip || e.title)));
await page.click('#assetSeg [data-asset="cbZEC"]');
check("collateral: picking cbZEC forces the Spot strategy and greys the borrow modes", (await o("S")).wiz.mode === "SPOT" && await page.$eval('#modeCards [data-mode="LP"]', e => e.getAttribute("aria-disabled") === "true"));
await page.click('#assetSeg [data-asset="WETH"]');
await page.click('#modeCards [data-mode="LP"]');
check("collateral: WETH hint names the slider's stop — lowest HF offered 1.25, the registry floor binding under Aave's 80 %, no product cap — and the most you can borrow, 66.40%", /Lowest health factor offered 1\.25 — the registry's entry floor of 1\.25 \(registry floor 1\.25; Aave's max LTV 80%; no product cap\); most you can borrow 66\.40% LTV/.test(await page.textContent("#assetHint")));
{
  const r = await page.evaluate(() => { const o = window.__oil; return [-100, NaN, Infinity, 1e308, 0, 13].map(v => { o.dispatch({ type: "wiz", key: "amount", value: v }); return o.stepGate().ok; }); });
  check("amount: −100 / NaN / Infinity / 1e308 / 0 / over-balance all block Continue (Lens H)", r.every(x => x === false), JSON.stringify(r));
  await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "amount", value: 1 }));
  check("amount: a valid amount unblocks Continue", (await page.textContent("#nextBtn")) === "Continue →");
}
await page.click("#nextBtn");
check("setting: the two marks are rendered and both offered on WETH at the 1.25 floor, each with its numbers in the title", (await page.$$eval("#hfMarks [data-mark]", e => e.map(x => x.dataset.mark))).join() === "sheltered,expert" && await page.$$eval("#hfMarks [data-mark]", e => e.every(x => !x.disabled && /entry HF 1\.(55|30) · borrow/.test(x.title))));
check("setting: the slider is linear in the borrow, from 1 % LTV to the offered maximum (6640 bps on WETH), the stop named beside it", await page.$eval("#hf", e => e.min === "100" && e.max === "6640") && /lowest offered 1\.25 · the registry's entry floor of 1\.25/.test(await page.textContent("#hfMin")));
check("setting: the default is the Sheltered mark, offered as is — HF 1.55 after deposit on WETH (53.54 % LTV), the 1.25 floor stated, the ladder for THIS entry (1.50 / 1.35 / 1.20 / 1.05)", /HF 1\.55 after · floor 1\.25 · ladder 1\.50 \/ 1\.35 \/ 1\.20 \/ 1\.05/.test(await page.textContent("#ltvHf")) && (await page.textContent("#hfLbl")) === "1.55" && (await page.textContent("#ltvLbl")) === "53.54%");
{
  const r = await page.evaluate(() => { const o = window.__oil; const g = () => [o.S.wiz.hf, o.S.wiz.ltv]; o.dispatch({ type: "wiz", key: "hf", value: 1.2 }); const a = g(); o.dispatch({ type: "wiz", key: "hf", value: 2.5 }); const b = g(); o.dispatch({ type: "wiz", key: "hf", value: NaN }); const c = g(); o.dispatch({ type: "wiz", key: "hf", value: 0 }); const d = g(); o.dispatch({ type: "wiz", key: "borrow", value: 500 }); const e = g(); o.dispatch({ type: "wiz", key: "borrow", value: 5e6 }); const f = g(); o.dispatch({ type: "wiz", key: "hf", value: 1.55 }); return { a, b, c, d, e, f, px: o.S.price.WETH, amount: o.S.wiz.amount }; });
  check("setting: the reducer pulls an HF under the 1.25 floor up to it (1.2 → 1.25, 66.4 %), takes 2.5, ignores NaN and 0, derives the LTV as ⌊LT ÷ HF⌋, and a typed borrow drives the HF back (500 USDC → 1 WETH × price × 0.83 ÷ 500; 5,000,000 → pulled to 1.25)", r.a[0] === 1.25 && r.a[1] === 66.4 && r.b[0] === 2.5 && r.b[1] === 33.2 && r.c[0] === 2.5 && r.d[0] === 2.5 && Math.abs(r.e[0] - (r.amount * r.px * 0.83) / 500) < 1e-9 && r.f[0] === 1.25, JSON.stringify(r));
}
check("pool: at today's numbers 0 of 9 pools beat the borrow and the count says every one can still be opened; the best forecast is pre-selected and Continue is on (D4/D5)", /0 of 9 pools beat the borrow on both models/.test(await page.textContent("#poolCount")) && /every one of the 9 that can be opened shows its forecast/.test(await page.textContent("#poolCount")) && (await o("S")).wiz.pool === "aero-cbbtc-usdc" && (await page.textContent("#nextBtn")) === "Continue →");
check("pool: no row is aria-disabled at today's numbers, every row carries its forecast sentence, and the σ-less rows say 'no forecast'", (await page.$$eval("#poolList .pool-row", e => e.every(x => x.getAttribute("aria-disabled") === "false"))) && (await page.$$eval("#poolList .why", e => e.length)) === 9 && (await page.$$eval("#poolList .pool-row[data-priced='0'] .why", e => e.length === 6 && e.every(x => /no forecast/.test(x.textContent)))));
check("projection: the pre-selected best forecast is a negative number painted red — not a dash", (await page.textContent("#pApy")).startsWith("−") && await page.$eval("#pApy", e => e.classList.contains("neg")));
{ const paused = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "sim", kind: "paused", asset: "WETH", on: true }); o.renderAll(); const r = { dis: [...document.querySelectorAll("#poolList .pool-row")].every(x => x.getAttribute("aria-disabled") === "true"), why: document.querySelector("#poolList .why").textContent, next: document.querySelector("#nextBtn").textContent }; o.dispatch({ type: "sim", kind: "paused", asset: "WETH", on: false }); o.renderAll(); return r; });
  check("pool: a guardian pause on the collateral is the thing that greys every row out and blocks Continue — safety, by name", paused.dis && /cannot be opened/.test(paused.why) && /cannot be opened/.test(paused.next), JSON.stringify(paused).slice(0, 200)); }

/* ── 3. HOLD at today's numbers: negative carry, exactly-one on Enter/Space ── */
await page.click("#backBtn"); await page.click('#modeCards [data-mode="HOLD"]'); await page.click("#nextBtn");
// 30 % LTV on WETH = an entry HF of 8300 ÷ 3000 = 2.7666…: the reducer floors LT ÷ HF to whole bps, so 2.7666 lands on exactly 30.00 %.
await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "hf", value: 2.7666 }));
check("hold: a typed entry HF of 2.7666 on WETH is 30.00% LTV — the identity floors LT ÷ HF to whole bps", (await o("S")).wiz.ltv === 30);
const CRA = await o("CHAIN_READ"); const holdExp = CRA.aaveReserves.WETH.supplyAprPct - 0.3 * CRA.aaveReserves.USDC.borrowAprPct;
check(`hold: projection = supply − LTV × borrow (WETH ${CRA.aaveReserves.WETH.supplyAprPct}% − 30% × ${CRA.aaveReserves.USDC.borrowAprPct}% = ${holdExp >= 0 ? "+" : "−"}${Math.abs(holdExp).toFixed(2)}%) with the sign class matching`, near(parseFloat((await page.textContent("#pApy")).replace("−", "-")), holdExp, 0.06) && await page.$eval("#pApy", (e, cls) => e.classList.contains(cls), holdExp >= 0 ? "posv" : "neg"));
{ const r = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "asset", value: "cbBTC" }); o.dispatch({ type: "wiz", key: "amount", value: 0.1 }); o.dispatch({ type: "wiz", key: "hf", value: 1.56 }); return { apy: document.querySelector("#pApy").textContent, neg: document.querySelector("#pApy").classList.contains("neg") }; }); check(`hold: cbBTC at 50% is negative carry (${CRA.aaveReserves.cbBTC.supplyAprPct}% − 50% × ${CRA.aaveReserves.USDC.borrowAprPct}%) and painted red`, r.neg && r.apy.includes((CRA.aaveReserves.cbBTC.supplyAprPct - 0.5 * CRA.aaveReserves.USDC.borrowAprPct).toFixed(1).replace("-", "−")), JSON.stringify(r)); await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 1 }); o.dispatch({ type: "wiz", key: "hf", value: 2.7666 }); }); }
await page.click("#nextBtn");
check("review: HOLD review lists setting, HF after, LT read from Aave, fees, and the risk list", /Liquidation threshold \(WETH\)/.test(await page.textContent("#revList")) && /83% — read from Aave/.test(await page.textContent("#revList")) && /Keeper dependence/.test(await page.textContent("#revRisks")));
/* The acknowledgment (BUILD-PLAN-2026-09-12 D4/D5): Confirm stays off until it is ticked; the sentence names the loan and the drawdown; any change resets it. */
check("ack: Confirm & sign is off until the acknowledgment is ticked, and its sentence names the borrow cost and the drawdown for a HOLD (no forecast line)", await page.$eval("#nextBtn", e => e.disabled) && /tick the acknowledgment/.test(await page.textContent("#nextBtn")) && /I have read the numbers: the loan costs \d\.\d\d% a year today and that rate moves; a [\d.]+% fall in WETH would liquidate this position/.test(await page.textContent("#wizAckText")) && !/_/.test(await page.textContent("#wizAckText")));
check("ack: a confirm without it starts no flow; ticking it then changing the amount resets it", await page.evaluate(() => { const o = window.__oil; o.launch && o.launch(); const noFlow = !o.S.flow; o.dispatch({ type: "wiz", key: "ack", value: true }); const on = o.S.wiz.ack === true; o.dispatch({ type: "wiz", key: "amount", value: 1 }); return noFlow && on && o.S.wiz.ack === false; }));
await page.check("#wizAck");
check("ack: ticked — Confirm & sign is on", !(await page.$eval("#nextBtn", e => e.disabled)) && (await page.textContent("#nextBtn")) === "Confirm & sign ✓");
await page.focus("#nextBtn"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.press(" "); await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__oil.S.flow && window.__oil.S.flow.status === "done", null, { timeout: 15000 });
check("exactly-once: four Enter/Space presses on Confirm create ONE position (Lens H: three from one deposit)", (await o("S")).positions.length === 1 && (await o("S")).credited.length === 1);
await page.click("#goDone");
check("hold: dashboard shows HF 2.77, debt and the negative-carry chip", /HF 2\.77/.test(await page.textContent("#hfChip")) && /Negative carry/.test(await page.textContent("#posList")));

/* ── 4. what-if LP: presets, width bounds, computed ±, refunds, compound/claim/withdraw ── */
await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 2 }));
check("what-if: banner visible and labelled as not today's numbers", await page.$eval("#whatifBanner", e => e.style.display !== "none") && /not today/.test(await page.textContent("#whatifBanner")));
await page.click(".tab[data-view=wiz]"); await page.click('#assetSeg [data-asset="cbBTC"]'); await page.click('#modeCards [data-mode="LP"]');
await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "amount", value: 0.2 })); await page.click("#nextBtn");
check("pool: under what-if ×2 exactly one pool beats the borrow (cbBTC/USDC) and is the selection", /1 of 9 pools beat the borrow/.test(await page.textContent("#poolCount")) && (await o("S")).wiz.pool === "aero-cbbtc-usdc");
await page.click("#nextBtn");
{
  const cards = await page.$$eval("#presetCards .opt", e => e.map(x => x.textContent));
  check("range: presets show computed ± from the shared spans (25.23 / 7.79 / 1.51 for an uncorrelated pool)", /±25\.23%/.test(cards[0]) && /±7\.79%/.test(cards[1]) && /±1\.51%/.test(cards[2]));
  const r = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "rw", value: 8100 }); const a = o.S.wiz.rw; o.dispatch({ type: "wiz", key: "rw", value: 10 }); const b = o.S.wiz.rw; o.dispatch({ type: "wiz", key: "rw", value: 999 }); return [a, b, o.S.wiz.rw, o.S.wiz.preset, document.querySelector("#rwLbl").textContent, document.querySelector("#rwMax").textContent]; });
  check("range: width is clamped to [150, 5000] (8100 → 5000, 10 → 150); custom width flags CUSTOM and ± is derived (999 → ±5.12%)", r[0] === 5000 && r[1] === 150 && r[2] === 999 && r[3] === "CUSTOM" && /±5\.12%/.test(r[4]) && /±28\.40%/.test(r[5]), JSON.stringify(r));
  const tight = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "setMult", mult: 1 }); o.dispatch({ type: "wiz", key: "rw", value: 300 }); const r = { apy: document.querySelector("#pApy").textContent, neg: document.querySelector("#pApy").classList.contains("neg"), next: document.querySelector("#nextBtn").textContent }; o.dispatch({ type: "setMult", mult: 2 }); return r; });
  check("range: at today's numbers the Aggressive width is below the borrow; projection negative & red; Continue is NOT blocked by it (the forecast is shown, D4/D5)", tight.neg && tight.next === "Continue →" && tight.apy.startsWith("−"), JSON.stringify(tight));
  await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "preset", value: "CONSERVATIVE" }));
  check("range: preset restores width 4500 and delay 48h", (await o("S")).wiz.rw === 4500 && (await o("S")).wiz.rd === 48);
}
check("projection: positive APY under what-if is green and the note says WHAT-IF", await page.$eval("#pApy", e => e.classList.contains("posv")) && /WHAT-IF/.test(await page.textContent("#pNote")));
await page.evaluate(() => window.__oil.dispatch({ type: "sim", kind: "refundNext", on: true }));
await page.click("#nextBtn");
check("review: LP review carries registry id, ± range, working slice, keeper permission and the what-if label", /Registry id/.test(await page.textContent("#revList")) && /±25\.23%/.test(await page.textContent("#revList")) && /WHAT-IF ×2/.test(await page.textContent("#revList")));
check("ack: the LP acknowledgment names the pool's forecast on both models", /I have read the forecast: on cbBTC\/USDC the model projects [-−]?[\d.]+% a year on the deployed USDC \(the stricter model says [-−]?[\d.]+%\)/.test(await page.textContent("#wizAckText")));
await page.check("#wizAck");
await page.click("#nextBtn");
await page.waitForFunction(() => window.__oil.S.flow && window.__oil.S.flow.status === "done", null, { timeout: 20000 });
await page.click("#goDone");
{
  const s = await o("S"); const lp = s.positions.find(p => p.kind === "LP");
  const openLog = s.activity.find(a => a.t === "Position opened").d; const borrowed = parseFloat((openLog.match(/\$([\d.]+) USDC borrowed/) || [])[1]);
  check("refund folding: bounced 12% folded back; dust ≤ $0.03 kept as idle; basis + idle = borrowed", lp && lp.idle > 0 && lp.idle <= 0.03 + 1e-9 && near(lp.lpBasis + lp.idle, borrowed, 0.01) && /folded back/.test(openLog), JSON.stringify({ idle: lp && lp.idle, basis: lp && lp.lpBasis, borrowed }));
  check("account HF: two positions pool on one account (cbBTC LT 78% + WETH LT 83% over total debt)", near(await page.evaluate(() => { const o = window.__oil; return o.accountHf(o.S, o.S.wallet.addr); }), await page.evaluate(() => { const o = window.__oil; const s = o.S; const W = s.positions.reduce((a, p) => a + p.coll * s.price[p.asset] * o.ltOf(p.asset), 0), D = s.positions.reduce((a, p) => a + p.debt, 0); return W / D; }), 1e-9));
}
await page.evaluate(() => { const o = window.__oil; o.S.positions.forEach(p => p.cooldown = 0); for (let i = 0; i < 24 * 10; i++) o.S = o.reduce(o.S, { type: "tick", dt: o.MAX_TICK_S }); o.renderAll(); });
{
  const lp = (await o("S")).positions.find(p => p.kind === "LP");
  check("accrual: 10 days under what-if — claimable > 0, bounded per tick, finite", lp.emis > 0 && Number.isFinite(lp.emis) && lp.lp <= lp.lpBasis + 1e-9);
  const r = await page.evaluate(() => { const o = window.__oil; const p = o.S.positions.find(x => x.kind === "LP"); const lp0 = p.lp, e0 = p.emis; o.dispatch({ type: "compound", id: p.id }); return { lp1: p.lp, e1: p.emis, lp0, e0, cd: p.cooldown }; });
  check("compound: emissions move into the working slice, claimable resets, 60s hold restarts", near(r.lp1, r.lp0 + r.e0, 1e-9) && r.e1 === 0 && r.cd === 60);
  await page.evaluate(() => { const o = window.__oil; o.S.positions.forEach(p => p.cooldown = 0); for (let i = 0; i < 24 * 5; i++) o.S = o.reduce(o.S, { type: "tick", dt: o.MAX_TICK_S }); o.S.positions.forEach(p => p.cooldown = 0); o.renderAll(); });
  const c = await page.evaluate(() => { const o = window.__oil; const p = o.S.positions.find(x => x.kind === "LP"); const d0 = p.debt, e0 = p.emis, hf0 = o.accountHf(o.S, p.owner); o.dispatch({ type: "claim", id: p.id, dest: "REPAY" }); return { d0, d1: p.debt, e0, e1: p.emis, hf0, hf1: o.accountHf(o.S, p.owner) }; });
  check("claim → repay: debt falls by the claimed amount, HF rises, claimable resets", near(c.d1, c.d0 - c.e0, 1e-9) && c.e1 === 0 && c.hf1 > c.hf0);
  const w = await page.evaluate(() => { const o = window.__oil; const p = o.S.positions.find(x => x.kind === "LP"); const d0 = p.debt, id = p.id; o.dispatch({ type: "withdraw", id, pct: 100, dest: "WALLET" }); const q = o.S.positions.find(x => x.id === id); return { d0, kind: q && q.kind, debt: q && q.debt, coll: q && q.coll, log: o.S.activity[1].d }; });
  check("withdraw 100% LP → wallet: debt is NOT deleted — record stays with its debt and collateral (Lens H Med)", w.kind === "HOLD" && near(w.debt, w.d0, 1e-9) && w.coll > 0 && /debt unchanged/.test(w.log), JSON.stringify(w));
  const cap = await page.evaluate(() => { const o = window.__oil; const p = o.S.positions.find(x => x.kind === "HOLD" && x.asset === "cbBTC"); const cap = o.withdrawCapPct(o.S, p); const coll0 = p.coll; o.dispatch({ type: "withdraw", id: p.id, pct: 100, dest: "WALLET" }); const refused = p.coll === coll0; o.dispatch({ type: "withdraw", id: p.id, pct: cap, dest: "WALLET" }); return { cap, refused, hf: o.accountHf(o.S, p.owner) }; });
  check("collateral withdrawal: capped so the account never leaves the 1.25 entry floor (the exit floor is the registry floor); an over-cap request is refused", cap.cap < 100 && cap.refused && cap.hf >= 1.25 - 1e-9, JSON.stringify(cap));
}

/* ── 5. ladder (account-level), hysteresis, re-arm, keeper offline ── */
{
  // The withdrawal tests above pulled the account's HF down to the exit floor while its recorded entry HF (the HOLD's 2.77)
  // stayed — so the ladder DERIVED from that entry has its warn rung fired and new borrows are blocked, exactly as the
  // keeper would. Lift the prices so every rung re-arms, then open the LP (which re-records the entry, as the router does).
  await page.evaluate(() => { const o = window.__oil; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.S.price[a] * 2 }); });
  check("ladder setup: after the withdrawal tests the account's HF sat under the warn rung of the ladder derived from its recorded entry (blocking new borrows); a price recovery re-arms every rung", Object.values(await page.evaluate(() => window.__oil.ladderOf(window.__oil.S, window.__oil.S.wallet.addr))).every(v => v === true));
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "mode", value: "LP" }); o.dispatch({ type: "wiz", key: "asset", value: "cbBTC" }); o.dispatch({ type: "wiz", key: "amount", value: 0.25 }); o.dispatch({ type: "wiz", key: "hf", value: 1.95 }); o.dispatch({ type: "wiz", key: "pool", value: "aero-cbbtc-usdc" }); o.dispatch({ type: "wiz", key: "preset", value: "CONSERVATIVE" }); o.dispatch({ type: "wiz", key: "ack", value: true }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 7; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); o.dispatch({ type: "flowDismiss" }); });
  check("ladder setup: a what-if LP position exists to unwind", (await o("S")).positions.some(p => p.kind === "LP" && p.lp > 0));
  const seq = await page.evaluate(() => { const o = window.__oil; const owner = o.S.wallet.addr; const L = () => Object.entries(o.ladderOf(o.S, owner)).filter(([, v]) => !v).map(([k]) => k).join(","); const out = []; const px = { ...o.S.price };
    const hf0 = o.accountHf(o.S, owner); const entry = o.entryOf(o.S, owner); const lad = o.ladOf(entry);
    // Drop the prices to just under each rung of THIS account's ladder, in order; the factors are derived from the rungs, never typed.
    // Each factor chains from the HF the previous rung's ACTION left (a repay lifts it), so every step lands just under its rung.
    let f = 1; for (const r of [lad.rungs.warn, lad.rungs.repay, lad.rungs.derisk]) { f = f * ((r - 0.01) / o.accountHf(o.S, owner)); for (const a of ["cbBTC", "WETH"]) o.S = o.reduce(o.S, { type: "setPrice", asset: a, px: px[a] * f }); out.push([+f.toFixed(4), +o.accountHf(o.S, owner).toFixed(3), L()]); }
    const unwinds = o.S.activity.filter(a => /Partial unwind/.test(a.d)).length; const n0 = o.S.activity.length; for (let i = 0; i < 100; i++) o.S = o.reduce(o.S, { type: "setPrice", asset: "cbBTC", px: o.S.price.cbBTC * (i % 2 ? 1.003 : 0.997) }); const churn = o.S.activity.length - n0;
    for (const a of ["cbBTC", "WETH"]) o.S = o.reduce(o.S, { type: "setPrice", asset: a, px: px[a] * 1.5 }); const rearmed = L() === "";
    o.renderAll(); return { out, churn, rearmed, unwinds, hf0, entry, rungs: lad.rungs, disarm: lad.disarm, expectWarn: Math.round((1 + (entry - 1) * o.SHARED.LADDER_RUNG_FACTORS.warn) * 100) / 100 }; });
  check("ladder: the account's entry HF is recorded at the open as the router would (the account's HF after it, four decimals) and its ladder derives from it (warn = 1 + (entry − 1) × 0.91); rungs fire in order (warn → repay → partial unwind) as both collaterals fall to just under each rung, the unwind lifts HF back to the de-risk rung's re-arm level, and the lower rungs re-arm", seq.entry === Math.floor(seq.hf0 * 1e4) / 1e4 && seq.rungs.warn === seq.expectWarn && seq.out[0][2] === "warn" && seq.out[1][2] === "warn,repay" && seq.unwinds >= 1 && seq.out[2][1] >= seq.disarm.derisk - 0.01, JSON.stringify(seq));
  check("ladder hysteresis: 100 flat wiggles log zero events; recovery re-arms every rung", seq.churn === 0 && seq.rearmed, JSON.stringify(seq));
  const k = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "sim", kind: "keeperOff", on: true }); const n0 = o.S.activity.length; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.S.price[a] * 0.3 }); const fired = Object.values(o.ladderOf(o.S, o.S.wallet.addr)).filter(v => !v).length; const logged = o.S.activity.length - n0; const banner = document.querySelector("#keeperBanner").style.display; o.dispatch({ type: "sim", kind: "keeperOff", on: false }); return { fired, logged, banner }; });
  check("keeper offline: nothing acts or logs; banner shown; keeper back evaluates the ladder", k.fired === 0 && k.logged === 0 && k.banner === "flex");
  check("wizard: new borrows are blocked while the heads-up rung is fired (HF parked at 1.45)", (await page.evaluate(() => { const o = window.__oil; const own = o.S.wallet.addr; const h = o.accountHf(o.S, own); const f = 1.45 / h; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.S.price[a] * f }); o.dispatch({ type: "wiz", key: "mode", value: "HOLD" }); o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 0.05 }); o.dispatch({ type: "wiz", key: "hf", value: 2.7666 }); return { hf: o.accountHf(o.S, own), warnFired: !o.ladderOf(o.S, own).warn, d: o.wizDecision(o.S) }; })).d.ok === false);
  await page.evaluate(() => { const o = window.__oil; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.PRICE_READ[a] }); });
}

/* ── 6. store validation & two-tab ── */
{
  const cases = ['{"v":1,"positions":"nope"}', "garbage", "null", '{"v":2}', '{"v":2,"seq":0,"nextId":1,"lastTick":0,"wallet":null,"price":{"cbBTC":1},"borrowPct":4}', JSON.stringify({ v: 2, seq: 0, nextId: 1, lastTick: 0, wallet: null, price: { cbBTC: 1, WETH: 1, cbZEC: 1 }, borrowPct: 4, mult: 1, positions: [{ id: 1, kind: "LP", owner: "0x0", asset: "cbBTC" }], activity: [], credited: [], flow: null, ladders: {}, sim: { keeperOff: false }, wiz: {} }), JSON.stringify({ v: 2, seq: 0, nextId: 1, lastTick: 0, wallet: null, price: { cbBTC: 1, WETH: 1, cbZEC: 1 }, borrowPct: 4, mult: 1, positions: [{ id: 1, kind: "SUPPLY", owner: "0x7a3F9c1E4B2d8A6f0C5e3B7D9a1F4c6E8b2D0c1E", asset: "cbBTC", coll: -1, debt: 0, interest: 0, openedAt: 0, ageS: 0 }], activity: [], credited: [], flow: null, ladders: {}, sim: { keeperOff: false }, wiz: {} })];
  const res = await page.evaluate(cases => cases.map(c => window.__oil.validateStore(c).ok), cases);
  check("store: seven malformed shapes rejected (v1, garbage, missing fields, bad position, negative collateral)", res.every(x => x === false), JSON.stringify(res));
  check("store: the live state round-trips through validateStore", await page.evaluate(() => { const o = window.__oil; const r = o.validateStore(o.serialize(o.S)); return r.ok && r.state.positions.length === o.S.positions.length && r.state.credited.length === o.S.credited.length; }));
  const pageB = await openPage(b, srv.url("index.html"), { context: page.__ctx });
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "mode", value: "SUPPLY" }); o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 1 }); o.dispatch({ type: "wiz", key: "ack", value: true }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); o.dispatch({ type: "flowDismiss" }); });
  await pageB.waitForTimeout(300);
  const nA = (await o("S")).positions.length, nB = await pageB.evaluate(() => window.__oil.S.positions.length);
  check("two-tab: tab B adopts tab A's new position via the storage event", nA === nB && nA >= 3, `${nA} vs ${nB}`);
  const clob = await pageB.evaluate(() => { const o = window.__oil; o.S.seq = 0; o.S.positions = []; const ok = o.save(); return { ok, n: o.S.positions.length }; });
  check("two-tab: a stale tab cannot clobber — its save is refused and it re-adopts the newer state", clob.ok === false && clob.n === nA);
  await pageB.close();
  await page.evaluate(() => { window.__marker = 1; window.__oil.storage.set('{"v":1,"positions":"nope"}'); setTimeout(() => location.reload(), 0); });
  await page.waitForFunction(() => window.__marker === undefined && !!window.__oil); await page.waitForTimeout(200);
  check("store: corrupted store → fresh state + boot note, zero console errors", /rejected/.test(await o("bootNote") || "") && (await o("S")).positions.length === 0 && page.__errors.length === 0, JSON.stringify([await o("bootNote"), (await o("S")).positions.length, page.__errors]));
}

/* ── 7. keyboard reachability (13 unreachable controls in the old build) ── */
{
  await page.click(".tab[data-view=wiz]");
  const roles = await page.$$eval('#modeCards .opt, #rewCards .opt, #presetCards .opt, #wizWallets .wbtn, #assetSeg button, #ltvSeg button', els => els.map(e => [e.getAttribute("role"), e.tabIndex >= -1 && e.hasAttribute("tabindex") || e.tagName === "BUTTON"]));
  check("keyboard: every choice card/button carries role=radio and a tabindex (or is a native button)", roles.length >= 8 && roles.every(([r, t]) => r === "radio" && t), JSON.stringify(roles));
  const k = await page.evaluate(() => { const o = window.__oil; const el = document.querySelector('#modeCards [data-mode="HOLD"]'); el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); const m1 = o.S.wiz.mode; const el2 = document.querySelector('#modeCards [aria-checked="true"]'); el2.focus(); el2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); return [m1, o.S.wiz.mode]; });
  check("keyboard: Enter picks a card; ArrowRight moves to the next card in the group", k[0] === "HOLD" && k[1] === "SUPPLY", JSON.stringify(k));
  const t = await page.evaluate(() => { const el = document.querySelector("#econToggle"); const before = el.classList.contains("on"); el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); return before !== el.classList.contains("on"); });
  check("keyboard: Space flips a role=switch toggle", t);
  check("keyboard: position cards expand with Enter (role=button, tabindex)", /role="button" tabindex="0"/.test(html.slice(html.indexOf("<script>"))) || /tabindex="0" role="button"/.test(html.slice(html.indexOf("<script>"))));
}

/* ── 8. counterfeit check, pools table, docs, 390px ── */
{
  const cf = await page.evaluate(() => { const o = window.__oil; return [o.classifyCbZecAddress(o.SHARED.CBZEC_ADDRESS.toLowerCase()), o.classifyCbZecAddress("0xB2000000000000000000000000000000000DEAD1"), o.classifyCbZecAddress(o.SHARED.BASE_TOKENS.cbBTC.address), o.classifyCbZecAddress("hello")]; });
  check("counterfeit: genuine (any case) / counterfeit (prefix) / unrelated / invalid classified like shared", cf.join() === "genuine,counterfeit,unrelated,invalid");
  await page.click(".tab[data-view=risks]"); await page.click('[data-cf="counterfeit"]');
  check("counterfeit UI: a look-alike is called out in red", /Counterfeit/.test(await page.textContent("#cfOut")) && await page.$eval("#cfOut", e => e.classList.contains("bad")));
  await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 1 }));
  await page.click(".tab[data-view=pools]");
  check("pools table: 9 rows, registry ids for engine pools, cbZEC row marked direct/no id, no cell beats the borrow at today's numbers and every cell names why", (await page.$$eval("#poolTable tbody tr", e => e.length)) === 9 && (await page.$$eval("#poolTable .ver", e => e.length)) === 8 && /no_emissions|no_volatility|below_borrow/.test(await page.textContent("#poolTable")) && !/beats the borrow/.test(await page.textContent("#poolTable")));
  await page.click(".tab[data-view=docs]"); await page.click('#docsNav [data-doc="health"]');
  check("docs: ladder rows computed from HF_LADDER — the 1.25 floor's, re-arm at rung + 0.02 stated (1.25 and 1.07), the 1.30 row beside each", /Re-arms at HF ≥ 1\.25/.test(await page.textContent("#docLadder")) && /Re-arms at HF ≥ 1\.07/.test(await page.textContent("#docLadder")) && /1\.27 for one opened at 1\.30/.test(await page.textContent("#docLadder")));
  await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(200);
  for (const v of ["dash", "wiz", "pools", "risks", "docs"]) { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(80); const s2 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]); check(`390px: no horizontal overflow on ${v}`, s2[0] <= s2[1], s2.join("/")); }
  await page.click("#tkBtn"); await page.waitForTimeout(80);
  const s3 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check("390px: tester's kit fits", s3[0] <= s3[1]);
  check("tester's kit: failure simulations present (reject, revert, refund, range, keeper, store, crash, recover, what-if, seed)", ["fail:reject","fail:revert","refund","range:out","range:in","keeper:off","keeper:on","store:corrupt","px:-55","px:+30","seed"].every(k => html.includes(`data-tk="${k}"`)) && /data-tk="mult:[2-9]\d*">WHAT-IF emissions ×/.test(html));
}

/* ── 9. failure simulations through the reducer; spot swap ── */
{
  const p2 = await openPage(b, srv.url("index.html"));
  const r = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "coinbase" }); o.dispatch({ type: "wiz", key: "mode", value: "SUPPLY" }); o.dispatch({ type: "wiz", key: "amount", value: 0.1 }); o.dispatch({ type: "sim", kind: "failNext", on: true, step: 1, why: "Wallet rejected the signature." }); o.dispatch({ type: "wiz", key: "ack", value: true }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); return { status: o.S.flow.status, n: o.S.positions.length, credited: o.S.credited.length, log: o.S.activity[0].t }; });
  check("sim: wallet rejection → flow failed, no position, nothing credited, 'Reverted — nothing moved' logged", r.status === "failed" && r.n === 0 && r.credited === 0 && /Reverted/.test(r.log));
  const sp = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "flowDismiss" }); o.dispatch({ type: "wiz", key: "asset", value: "cbZEC" }); o.dispatch({ type: "wiz", key: "amount", value: 2 }); const d = o.wizDecision(o.S); o.dispatch({ type: "wiz", key: "ack", value: true }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); const p = o.S.positions[0]; return { d, kind: p && p.kind, out: p && p.amountOut, hf: o.accountHf(o.S, o.S.wallet.addr) }; });
  check("spot: cbZEC → USDC via CoW is allowed (no collateral needed), records the disposal, HF stays ∞", sp.d.ok && sp.kind === "SPOT" && near(sp.out, 2 * CRA.cbzecUsdcPool.priceUsdc * (1 - 0.0002), 1e-6) && sp.hf === Infinity, JSON.stringify(sp));
  const ex = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "seed" }); return o.S.positions.map(p => p.kind); });
  check("tester's kit: example positions load under the connected wallet only when it has none (spot already there → refused)", ex.join() === "SPOT");
  check("sim: zero console errors after every simulation", p2.__errors.length === 0, p2.__errors.join(" | "));
  await p2.close();
}

/* ── 10. the fix round: the two-model gate, the new refusals, openBorrowOnly
   and the entry floor, the swap floor, the keeper's grant, honest custody ── */
{
  const CLAIMS = [/no operator custody/i, /No operator custody/, /no owner powers/i, /has no power over your funds/i, /\bnon-custodial\b/i];
  check("custody: the page never claims 'no operator custody', 'no owner powers' or that the router has no power over funds", CLAIMS.every(re => !re.test(html)), CLAIMS.filter(re => re.test(html)).map(String).join(", "));
  const C = await o("CONTRACTS");
  check("custody: the operator's remaining powers are enumerated and stated as a residual a watcher only partly mitigates", C.registry.ownerCanStill.length === 3 && C.registry.ownerCannot.length === 3 && /still an owner|not claim/i.test(C.registry.residual) && C.registry.timelockDelayS === 172800);
  const own = await page.evaluate(() => ({ can: [...document.querySelectorAll("#docOwnerCan li")].length, cannot: [...document.querySelectorAll("#docOwnerCannot li")].length, resid: document.querySelector("#docOwnerResidual").textContent, per: document.querySelector("#docPeripheral").textContent }));
  check("custody: Ownership & the keeper renders what the owner can and cannot do, names the delay, and explains that peripheral rights are opt-in per call", own.can === 3 && own.cannot === 3 && /2 days/.test(own.resid) && /plain call/.test(own.per) && /allowCallback/.test(own.per) && /bounded at 8/.test(own.per), JSON.stringify(own).slice(0, 260));
  check("router: the balance claim is the delta form, not an absolute zero", /balance of every token it will touch/.test(html) && /unchanged/.test(html) && C.routerBalance.assertion === "delta" && /RouterBalanceChanged/.test(C.routerBalance.error));

  /* the boundary guard, at custom widths too */
  const bnd = await page.evaluate(() => { const oil = window.__oil; const B = oil.MODEL.borrowPctAtGeneration; return oil.MODEL.boundary.map(([id, w, gb, cl, mc]) => { const pl = oil.poolById(id); const g0 = oil.gate(pl, B, w, gb / pl.emissions[w]);
    let lo = 0.01, hi = 500; for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; (oil.lpNetPct(pl, w, mid) > B) ? hi = mid : lo = mid; }
    const g1 = oil.gate(pl, B, w, hi * (1 + 1e-9)); return { id, w, cl, mc, gotCl: g0.net, gotMc: g0.mcNet, reason: g1.reason, ok: g1.ok }; }); });
  const nB = bnd.length, expRefused = bnd.filter(r => !(r.mc > B)).length;
  check(`model: all ${nB} boundary cells reproduce both forms from the pinned coefficients, and the ${expRefused} whose Monte-Carlo form does not clear are refused within_model_uncertainty just above their break-even (${nB - expRefused} offered)`, nB >= 1 && bnd.every(r => near(r.gotCl, r.cl, 0.02) && near(r.gotMc, r.mc, 0.02)) && bnd.every(r => (r.mc > B) === r.ok && (r.mc > B || r.reason === "within_model_uncertainty")), JSON.stringify(bnd.map(r => [r.id, r.w, r.reason])));
  const custom = await page.evaluate(() => { const oil = window.__oil; const B = oil.MODEL.borrowPctAtGeneration; const pl = oil.poolById("aero-cbbtc-usdc"); const g = oil.gate(pl, B, 1000, 12); const gp = oil.gate(pl, B, 1500, 12); const none = oil.gate(oil.poolById("aero-weth-link"), B, 4500, 12); return { custom: g.reason, why: g.why, preset: gp.reason, none: none.reason }; });
  check("gate: a width the Monte Carlo has never been run at is refused mc_calibration_stale — the advanced build cannot offer a cell the second model has not priced", custom.custom === "mc_calibration_stale" && /re-run/.test(custom.why) && custom.preset === "ok", JSON.stringify(custom).slice(0, 260));
  check("gate: a pool with no calibration at all is refused rather than falling back to the closed form", custom.none === "no_volatility_input" || custom.none === "mc_calibration_unavailable");
  const sweep = await page.evaluate(() => { const oil = window.__oil; const B = oil.MODEL.borrowPctAtGeneration; const bad = []; for (const pl of oil.MODEL.pools) for (let w = 150; w <= 5000; w += 50) for (const m of [1, 2, 4, 6.35, 12, 30, 60]) { const g = oil.gate(pl, B, w, m); if (g.ok && !(g.mcNet > B)) bad.push([pl.id, w, m]); } return bad; });
  check("gate: across every pool × every width in the engine's bounds × 7 emissions multiples, the served gate is never more permissive than the Monte-Carlo form", sweep.length === 0, JSON.stringify(sweep.slice(0, 3)));

  const p3 = await openPage(b, srv.url("index.html"));
  await p3.evaluate(() => { const oil = window.__oil; oil.dispatch({ type: "connect", provider: "coinbase" }); });
  const refusals = await p3.evaluate(() => { const oil = window.__oil; const out = {};
    const band = oil.gate(oil.poolById("aero-weth-cbbtc"), oil.S.borrowPct, 150, 23.1); out.band = { reason: band.reason, net: band.net, mc: band.mcNet, why: band.why, borrow: oil.S.borrowPct };
    oil.dispatch({ type: "sim", kind: "revote", on: true }); const im = oil.gate(oil.poolById("aero-aero-weth"), oil.S.borrowPct, 4500, 1, oil.gopt()); out.impl = { reason: im.reason, gross: im.gross, why: im.why }; oil.dispatch({ type: "sim", kind: "revote", on: false });
    oil.dispatch({ type: "sim", kind: "corroborated", on: false }); out.uncorr = oil.MODEL.pools.map(pl => oil.gate(pl, oil.S.borrowPct, 4500, 12, oil.gopt()).reason); oil.dispatch({ type: "sim", kind: "corroborated", on: true });
    oil.dispatch({ type: "sim", kind: "paused", asset: "cbBTC", on: true }); out.collPaused = oil.gate(oil.poolById("aero-cbbtc-usdc"), oil.S.borrowPct, 4500, 12, oil.gopt({ collateral: "cbBTC" })).reason; out.wiz = oil.wizDecision(oil.S).why; oil.dispatch({ type: "sim", kind: "paused", asset: "cbBTC", on: false });
    oil.dispatch({ type: "sim", kind: "paused", asset: "USDC", on: true }); out.borrowPaused = oil.gate(oil.poolById("aero-cbbtc-usdc"), oil.S.borrowPct, 4500, 12, oil.gopt({ collateral: "cbBTC" })).reason; oil.dispatch({ type: "sim", kind: "paused", asset: "USDC", on: false });
    const B = oil.MODEL.borrowPctAtGeneration;
    const oob = oil.gate(oil.poolById("aero-cbbtc-usdc"), B, 4500, 400, { maxEmissionsAprPct: 1e9, maxAbsNetPct: 100 }); out.oob = oob.reason;
    let reachable = false; for (let m = 1; m <= 100; m += 0.5) for (const pool of oil.MODEL.pools) for (const ww of [150, 300, 784, 1500, 2356, 4500]) if (oil.gate(pool, B, ww, m).reason === "net_out_of_bounds") reachable = true; out.reachable = reachable;
    return out; });
  check(`gate: WHAT-IF ×23.1 puts WETH/cbBTC at its tightest width inside the disagreement band at the page's ${refusals.band.borrow}% borrow — refused within_model_uncertainty with both numbers in the sentence`, refusals.band.reason === "within_model_uncertainty" && refusals.band.net > refusals.band.borrow && refusals.band.mc < refusals.band.borrow && /closed form/.test(refusals.band.why) && /Monte Carlo/.test(refusals.band.why), JSON.stringify(refusals.band).slice(0, 260));
  check("gate: the AERO/WETH gauge's own recorded reading is refused emissions_implausible above the 1,000% ceiling", refusals.impl.reason === "emissions_implausible" && refusals.impl.gross > 1000 && /plausibility ceiling/.test(refusals.impl.why));
  check("gate: an uncorroborated staked-liquidity anchor refuses every gauge that has emissions with insufficient_samples (a reading above the plausibility ceiling is refused as implausible first, the gate's order)", refusals.uncorr.filter(r => r === "insufficient_samples").length >= 6 && refusals.uncorr.every(r => r === "insufficient_samples" || r === "no_emissions" || r === "emissions_implausible"));
  check("gate: guardian pauses surface as collateral_paused / borrow_paused, and the wizard refuses to continue", refusals.collPaused === "collateral_paused" && refusals.borrowPaused === "borrow_paused", JSON.stringify(refusals).slice(0, 200));
  check("gate: net_out_of_bounds is a real branch, and the emissions ceiling makes it unreachable on any live input", refusals.oob === "net_out_of_bounds" && refusals.reachable === false);
  const docs = await p3.evaluate(() => ({ reasons: [...document.querySelectorAll("#docReasons tbody tr")].map(r => [r.children[0].textContent, r.children[1].textContent]), bnd: [...document.querySelectorAll("#docBoundary tbody tr")].length, note: document.querySelector("#docBoundaryNote").textContent, grant: [...document.querySelectorAll("#docGrant tbody tr")].length, floor: document.querySelector("#docFloorP").textContent, swap: document.querySelector("#docSwapP").textContent }));
  const btv = await p3.evaluate(() => [...document.querySelectorAll("#docBoundary tbody tr")].map(r => r.lastElementChild.textContent.trim()));
  const worstAdv = bnd.reduce((a, r) => Math.max(a, r.cl - r.mc), 0), mcPathsAdv = await o("MODEL.mc.paths");
  check(`docs: the boundary table's own served-gate column shows ${expRefused} cells that do not clear on the stricter form and ${nB - expRefused} that beat the borrow on both — the table is evaluated at the model's borrow, not narrated`, btv.filter(x => /within_model_uncertainty/.test(x)).length === expRefused && btv.filter(x => /beats the borrow/.test(x)).length === nB - expRefused, JSON.stringify(btv));
  check(`docs: all 13 gate refusals are catalogued with a plain-English sentence, and the boundary table renders its ${nB} cells with the worst optimism (${worstAdv.toFixed(2)} pt) named`, docs.reasons.length === 13 && docs.reasons.every(([k, v]) => v.length > 40) && docs.bnd === nB && new RegExp(worstAdv.toFixed(2).replace(".", "\\.") + " points").test(docs.note) && new RegExp(`${mcPathsAdv} paths`).test(docs.note), JSON.stringify({ n: docs.reasons.length, bnd: docs.bnd }));
  check("docs: the keeper's grant is tabulated field by field, and the entry-floor and swap-floor sections name the contract that enforces each", docs.grant === 6 && /AaveV3Venue\.borrow/.test(docs.floor) && /EntryHfTooLow/.test(docs.floor) && /1\.07/.test(docs.floor) && /minOutFor/.test(docs.swap) && /maxSlippageBps/.test(docs.swap));

  /* borrow-and-hold now goes through openBorrowOnly, and the floor is enforced */
  const hold = await p3.evaluate(() => { const oil = window.__oil; oil.dispatch({ type: "wiz", key: "mode", value: "HOLD" }); oil.dispatch({ type: "wiz", key: "amount", value: 0.1 }); oil.dispatch({ type: "wiz", key: "hf", value: 1.56 }); oil.dispatch({ type: "wiz", key: "step", value: 4 }); oil.renderAll();
    const steps = document.querySelector("#revTx").textContent; const rev = document.querySelector("#revList").textContent;
    oil.dispatch({ type: "wiz", key: "ack", value: true });   // the review's acknowledgment (D4/D5) — Confirm needs it
    return { steps, rev, decision: oil.wizDecision(oil.S) }; });
  check("hold: the borrow-and-hold flow is one openBorrowOnly router call, not a hand-built execBatch, and the review names the entry floor and where it is enforced", /openBorrowOnly/.test(hold.steps + hold.rev) && !/execBatch\(\[permit2/.test(hold.steps) && /AaveV3Venue\.borrow/.test(hold.rev) && /EntryHfTooLow/.test(hold.rev) && hold.decision.ok, JSON.stringify({ ok: hold.decision.ok }).slice(0, 120));
  const floorBlock = await p3.evaluate(() => { const oil = window.__oil; const r = oil.CHAIN_READ.aaveReserves.cbBTC; const hfRaw = r.liquidationThresholdBps / r.ltvBps;
    document.querySelector("#tkBtn").click(); document.querySelector('[data-tk="rawbatch"]').click();
    const why = oil.S.sim.failNext.why;
    oil.dispatch({ type: "wiz", key: "ack", value: true }); oil.dispatch({ type: "beginFlow" }); const id = oil.S.flow.id; for (let i = 0; i < 6; i++) oil.dispatch({ type: "flowAdvance", id }); oil.dispatch({ type: "flowComplete", id });
    const out = { why, hfRaw, status: oil.S.flow.status, n: oil.S.positions.length, credited: oil.S.credited.length }; oil.dispatch({ type: "flowDismiss" }); return out; });
  check("entry floor: the pre-fix raw execBatch at Aave's full LTV is refused — EntryHfTooLow(1.07, 1.25), computed, atomic, nothing opened", /EntryHfTooLow\(1\.07, 1\.25\)/.test(floorBlock.why) && near(floorBlock.hfRaw, 1.07, 0.005) && floorBlock.status === "failed" && floorBlock.n === 0 && floorBlock.credited === 0, JSON.stringify({ why: floorBlock.why.slice(0, 100) }));
  const opened = await p3.evaluate(() => { const oil = window.__oil; oil.dispatch({ type: "wiz", key: "mode", value: "HOLD" }); oil.dispatch({ type: "wiz", key: "amount", value: 0.1 }); oil.dispatch({ type: "wiz", key: "ack", value: true }); oil.dispatch({ type: "beginFlow" }); const id = oil.S.flow.id; for (let i = 0; i < 6; i++) oil.dispatch({ type: "flowAdvance", id }); oil.dispatch({ type: "flowComplete", id }); oil.dispatch({ type: "flowDismiss" });
    const p = oil.S.positions[0]; return { kind: p.kind, hf: oil.accountHf(oil.S, oil.S.wallet.addr), floor: oil.LADDER.entryHfFloor, grant: oil.grantOf(oil.S, oil.S.wallet.addr) }; });
  check("hold: a hold position really opens at or above the advertised floor, and signing it grants the keeper its permission", opened.kind === "HOLD" && opened.hf >= opened.floor - 1e-9 && opened.grant.live && Math.abs(opened.grant.remainingDays - 30) < 1e-9, JSON.stringify({ hf: opened.hf, days: opened.grant.remainingDays }));

  /* the swap floor on an LP unwind */
  const lp = await p3.evaluate(() => { const oil = window.__oil; oil.dispatch({ type: "setMult", mult: 2 }); oil.dispatch({ type: "wiz", key: "mode", value: "LP" }); oil.dispatch({ type: "wiz", key: "pool", value: "aero-cbbtc-usdc" }); oil.dispatch({ type: "wiz", key: "amount", value: 0.1 }); oil.dispatch({ type: "wiz", key: "ack", value: true }); oil.dispatch({ type: "beginFlow" }); const id = oil.S.flow.id; for (let i = 0; i < 6; i++) oil.dispatch({ type: "flowAdvance", id }); oil.dispatch({ type: "flowComplete", id }); oil.dispatch({ type: "flowDismiss" });
    const p = oil.S.positions.find(x => x.kind === "LP"); const pool = oil.poolById(p.pool);
    const l = oil.swapLegFor(pool, p.lp + p.idle);
    return { minOut: l.minOut, quotedOut: l.quotedOut, slip: l.maxSlippageBps, cap: l.cap,
      direct: oil.minOutFor(l.amountIn, l.quotedIn, l.quotedOut, l.maxSlippageBps).minOut,
      bigger: oil.swapLegFor(pool, p.lp + p.idle, 50, { sizeFactor: 1.4 }).reverts,
      sand: oil.swapLegFor(pool, p.lp + p.idle, 50, { priceFactor: 0.6 }).reverts,
      loose: oil.swapLegFor(pool, p.lp + p.idle, 501).error, zero: oil.minOutFor(1, 0, 1, 50).error, id: p.id }; });
  check("swap: the unwind's floor is the adapter's own formula, the tolerance is 0.50% under an on-chain cap of 5.00%, and a bare minimum-out cannot be expressed", near(lp.minOut, lp.direct, 1e-12) && near(lp.minOut, lp.quotedOut * (1 - lp.slip / 10000), 1e-9) && lp.cap === 500 && /SlippageTooHigh\(501, 500\)/.test(lp.loose) && lp.zero === "ZeroQuote()");
  check("swap: a leg that settles larger is protected in proportion; an adverse price is not, so the swap reverts", lp.bigger === false && lp.sand === true);
  const sandAdv = await p3.evaluate((id) => { const oil = window.__oil; oil.dispatch({ type: "sim", kind: "sandwich", on: true });
    oil.S = oil.reduce(oil.S, { type: "tick", dt: oil.MAX_TICK_S }); oil.renderAll();   // clear the engine's 60s hold so the LP is withdrawable
    const before = JSON.parse(JSON.stringify(oil.S.positions));
    const card = [...document.querySelectorAll("#posList .pos, #posList .card, #posList > div")].find(el => /cbBTC\/USDC/.test(el.textContent));
    const btn = card ? card.querySelector("[data-act='withdraw']") : null;
    if (!btn || btn.disabled) return { skipped: true, why: btn ? "disabled" : "no button" };
    btn.click();
    const swapTxt = document.querySelector("#wdSwap").textContent; const shown = document.querySelector("#wdRevert").style.display;
    document.querySelector("#wdConfirm").click();
    const moved = JSON.stringify(oil.S.positions) !== JSON.stringify(before); const act = oil.S.activity[0];
    oil.dispatch({ type: "sim", kind: "sandwich", on: false }); document.querySelector("#wdOverlay").classList.remove("on");
    return { swapTxt, shown, moved, act: act.t + " " + act.d }; }, lp.id);
  check("swap: a sandwiched unwind reverts in the UI — the modal shows the enforced floor and the confirm moves nothing", !sandAdv.skipped && /reverts below/.test(sandAdv.swapTxt) && sandAdv.shown === "block" && sandAdv.moved === false && /Withdrawal reverted/.test(sandAdv.act), JSON.stringify(sandAdv).slice(0, 240));

  /* the keeper's grant */
  const gr = await p3.evaluate(() => { const oil = window.__oil; oil.renderAll(); return { kv: document.querySelector("#grantKv").textContent, chip: document.querySelector("#grantChip").textContent, note: document.querySelector("#grantNote").textContent, shown: document.querySelector("#grantCard").style.display, C: oil.CONTRACTS.grant, g: oil.grantOf(oil.S, oil.S.wallet.addr) }; });
  check("grant: the account card names one target, one function, the daily limits, the 24h period and a live expiry countdown", gr.shown === "block" && /StrategyRouter\.unwind\(\)/.test(gr.kv) && /1 root call, nothing else/.test(gr.kv) && /24h/.test(gr.kv) && /Live · expires in \d+ days/.test(gr.chip) && gr.g.remainingDays > 29, JSON.stringify({ chip: gr.chip }).slice(0, 160));
  check("grant: it matches what the keeper plans (one root unwind) and says out loud what the per-day limits do not bound", gr.C.rootCalls === 1 && gr.C.selector === "unwind" && /trusted code chosen by Oilskin/.test(gr.note) && /UnbudgetableSelector/.test(gr.note) && /Permit2/.test(gr.note));
  const life = await p3.evaluate(() => { const oil = window.__oil; const px = oil.S.price.cbBTC; const own = oil.S.wallet.addr;
    oil.dispatch({ type: "expireGrant" }); oil.dispatch({ type: "setPrice", asset: "cbBTC", px: px * 0.45 });
    const firedExpired = Object.values(oil.ladderOf(oil.S, own)).filter(v => !v).length; const chip = document.querySelector("#grantChip").textContent; const logged = oil.S.activity.some(a => /Keeper permission expired/.test(a.t));
    const n0 = oil.S.activity.length; for (let i = 0; i < 30; i++) oil.dispatch({ type: "setPrice", asset: "cbBTC", px: px * (0.45 + i * 1e-7) }); const churn = oil.S.activity.length - n0;
    const n1 = oil.S.activity.length; oil.dispatch({ type: "renewGrant" }); const acted = oil.S.activity.slice(0, oil.S.activity.length - n1).some(a => /Heads-up|Protection ladder|Earnings repaid/.test(a.t));
    oil.dispatch({ type: "setPrice", asset: "cbBTC", px }); oil.dispatch({ type: "renewGrant" });
    return { firedExpired, chip, logged, churn, acted, days: oil.grantOf(oil.S, own).remainingDays }; });
  check("grant: an expired permission stops the ladder dead, is announced exactly once, and renewing restores the full 30-day term and protection", life.firedExpired === 0 && /Expired/.test(life.chip) && life.logged === true && life.churn === 0 && life.acted === true && Math.abs(life.days - 30) < 1e-9, JSON.stringify(life));
  const ff = await p3.evaluate(() => { const oil = window.__oil; for (let i = 0; i < 24 * 30; i++) oil.S = oil.reduce(oil.S, { type: "tick", dt: oil.MAX_TICK_S }); oil.renderAll(); const g = oil.grantOf(oil.S, oil.S.wallet.addr); return { expired: g.expired, remainingS: g.remainingS, chip: document.querySelector("#grantChip").textContent }; });
  check("grant: 30 demo days of ticks run the permission down to exactly its expiry — the countdown is the real clock, not decoration", ff.expired && ff.remainingS === 0 && /Expired/.test(ff.chip), JSON.stringify(ff));
  await p3.setViewportSize({ width: 390, height: 800 }); await p3.waitForTimeout(150);
  const sw3 = await p3.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check("390px: the dashboard with the keeper-permission card has no horizontal overflow", sw3[0] <= sw3[1], sw3.join("/"));
  check("tester's kit: the new levers are all present (pauses, corroboration, gauge re-vote, raw batch, sandwich, grant revoke/renew/expire, the disagreement band)", ["pause:collateral","pause:borrow","pause:off","corr:off","corr:on","revote:on","revote:off","rawbatch","sandwich:on","sandwich:off","grant:revoke","grant:renew","grant:expire","mult:23.1"].every(k => html.includes(`data-tk="${k}"`)));
  check("sim: zero console errors across every new simulation", p3.__errors.length === 0, p3.__errors.join(" | "));
  await p3.close();
}

check("end: zero console errors on the main page across the whole suite", page.__errors.length === 0, page.__errors.join(" | "));
await b.close(); srv.close();
const out = done();
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
process.exit(out.fail ? 1 : 0);
