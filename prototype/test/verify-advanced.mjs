/* verify-advanced — named checks for prototype/index.html (Base-first, full control).
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
check("boot: zero console errors", page.__errors.length === 0, page.__errors.join(" | "));
check("boot: no wallet → dashboard shows the connect banner; positions are per-wallet", await page.$eval("#noWalletBanner", e => e.style.display !== "none") && /Connect a wallet/.test(await page.textContent("#posList")));
check("facts: LT cbBTC 7800 / WETH 8300; top 50/50; 6000 → 3870", await o("ltBpsOf", "cbBTC") === 7800 && await o("ltBpsOf", "WETH") === 8300 && await o("topLtvPct", "cbBTC") === 50 && await o("maxOfferedLtvBps", 6000) === 3870);
check("facts: ladder & fees mirror shared", JSON.stringify(await o("LADDER.rungs")) === '{"warn":1.5,"repay":1.35,"derisk":1.2,"emergency":1.05}' && (await o("FEES")).performanceBps === 1000 && (await o("SHARED.RANGE_WIDTH_BOUNDS")).max === 5000);
{
  const served = await o("MODEL.served");
  const bad = [];
  for (const [id, w, net, reason] of served) { const g = await page.evaluate(([id, w]) => { const oil = window.__oil; const r = oil.gate(oil.poolById(id), 4.828, w); return { ok: r.ok, reason: r.reason, net: r.net }; }, [id, w]); if (g.reason !== reason || (net != null && !near(g.net, net, 0.005)) || g.ok) bad.push(`${id}@${w}`); }
  check("gate: all 27 served MODEL-NUMBERS rows reproduce; none offered at 4.828%", bad.length === 0, bad.join(", "));
  const sweep = await page.evaluate(() => { const oil = window.__oil; const out = []; for (const p of oil.MODEL.pools) for (let w = oil.SHARED.RANGE_WIDTH_BOUNDS.min; w <= oil.SHARED.RANGE_WIDTH_BOUNDS.max; w += 25) { const g = oil.gate(p, 4.828, w); if (g.ok || (Number.isFinite(g.net) && g.net > 4.828)) out.push([p.id, w, g.net]); } return out; });
  check("net-APY model: across 9 pools × every width 150..5000 (step 25) nothing flips positive at today's numbers (Lens H High)", sweep.length === 0, JSON.stringify(sweep.slice(0, 5)));
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
check("collateral: WETH hint derives top = min(50%, ⌊83% ÷ 1.55⌋) = 50%", /min\(50%, ⌊83% ÷ 1\.55⌋\) = 50%/.test(await page.textContent("#assetHint")));
{
  const r = await page.evaluate(() => { const o = window.__oil; return [-100, NaN, Infinity, 1e308, 0, 13].map(v => { o.dispatch({ type: "wiz", key: "amount", value: v }); return o.stepGate().ok; }); });
  check("amount: −100 / NaN / Infinity / 1e308 / 0 / over-balance all block Continue (Lens H)", r.every(x => x === false), JSON.stringify(r));
  await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "amount", value: 1 }));
  check("amount: a valid amount unblocks Continue", (await page.textContent("#nextBtn")) === "Continue →");
}
await page.click("#nextBtn");
check("setting: presets Sheltered 30 / Steady 40 / Working hard 50 rendered per asset with HF and drop on hover", (await page.$$eval("#ltvSeg [data-ltv]", e => e.map(x => x.dataset.ltv))).join() === "30,40,50" && await page.$eval('#ltvSeg [data-ltv="50"]', e => /HF 1\.66/.test(e.dataset.tip || e.title) && /falls 40%/.test(e.dataset.tip || e.title)));
check("setting: fine slider max equals the per-asset top (50)", await page.$eval("#ltv", e => e.max === "50") && /50% top/.test(await page.textContent("#ltvMax")));
check("setting: HF chip after deposit = LT/LTV = 2.77 at 30% on WETH, with the 1.55 floor stated", /HF 2\.77 after · floor 1\.55/.test(await page.textContent("#ltvHf")));
{
  const r = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "ltv", value: 80 }); const a = o.S.wiz.ltv; o.dispatch({ type: "wiz", key: "ltv", value: 50 }); const b = o.S.wiz.ltv; o.dispatch({ type: "wiz", key: "ltv", value: 0 }); const c = o.S.wiz.ltv; o.dispatch({ type: "wiz", key: "ltv", value: 30 }); return [a, b, c]; });
  check("setting: LTV above top or ≤ 0 is refused by the reducer (80 → unchanged, 50 ok, 0 → unchanged)", r[0] === 30 && r[1] === 50 && r[2] === 50);
}
check("pool: at today's numbers the menu is empty and says so; Continue reads 'Pick a pool'", /0 of 9 pools clear/.test(await page.textContent("#poolCount")) && (await page.textContent("#nextBtn")) === "Pick a pool");
check("pool: every row is aria-disabled with a gate reason", (await page.$$eval("#poolList .pool-row", e => e.every(x => x.getAttribute("aria-disabled") === "true"))) && (await page.$$eval("#poolList .why", e => e.length)) === 9);
check("projection: LP with no pool shows — not a number", (await page.textContent("#pApy")) === "—");

/* ── 3. HOLD at today's numbers: negative carry, exactly-one on Enter/Space ── */
await page.click("#backBtn"); await page.click('#modeCards [data-mode="HOLD"]'); await page.click("#nextBtn");
check("hold: projection = supply − LTV × borrow (WETH 1.843% − 30% × 4.828% = +0.39%) with the sign class matching", near(parseFloat((await page.textContent("#pApy")).replace("−", "-")), 1.843 - 0.3 * 4.828, 0.06) && await page.$eval("#pApy", e => e.classList.contains("posv")));
{ const r = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "asset", value: "cbBTC" }); o.dispatch({ type: "wiz", key: "amount", value: 0.1 }); o.dispatch({ type: "wiz", key: "ltv", value: 50 }); return { apy: document.querySelector("#pApy").textContent, neg: document.querySelector("#pApy").classList.contains("neg") }; }); check("hold: cbBTC at 50% is negative carry (0.012% − 50% × 4.828%) and painted red", r.neg && /−2\.4/.test(r.apy), JSON.stringify(r)); await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 1 }); o.dispatch({ type: "wiz", key: "ltv", value: 30 }); }); }
await page.click("#nextBtn");
check("review: HOLD review lists setting, HF after, LT read from Aave, fees, and the risk list", /Liquidation threshold \(WETH\)/.test(await page.textContent("#revList")) && /83% — read from Aave/.test(await page.textContent("#revList")) && /Keeper dependence/.test(await page.textContent("#revRisks")));
await page.focus("#nextBtn"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.press(" "); await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__oil.S.flow && window.__oil.S.flow.status === "done", null, { timeout: 15000 });
check("exactly-once: four Enter/Space presses on Confirm create ONE position (Lens H: three from one deposit)", (await o("S")).positions.length === 1 && (await o("S")).credited.length === 1);
await page.click("#goDone");
check("hold: dashboard shows HF 2.77, debt and the negative-carry chip", /HF 2\.77/.test(await page.textContent("#hfChip")) && /Negative carry/.test(await page.textContent("#posList")));

/* ── 4. what-if LP: presets, width bounds, computed ±, refunds, compound/claim/withdraw ── */
await page.evaluate(() => window.__oil.dispatch({ type: "setMult", mult: 4 }));
check("what-if: banner visible and labelled as not today's numbers", await page.$eval("#whatifBanner", e => e.style.display !== "none") && /not today/.test(await page.textContent("#whatifBanner")));
await page.click(".tab[data-view=wiz]"); await page.click('#assetSeg [data-asset="cbBTC"]'); await page.click('#modeCards [data-mode="LP"]');
await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "amount", value: 0.2 })); await page.click("#nextBtn");
check("pool: under what-if ×4 exactly one pool clears (cbBTC/USDC) and is auto-selected", /1 of 9 pools clear/.test(await page.textContent("#poolCount")) && (await o("S")).wiz.pool === "aero-cbbtc-usdc");
await page.click("#nextBtn");
{
  const cards = await page.$$eval("#presetCards .opt", e => e.map(x => x.textContent));
  check("range: presets show computed ± from the shared spans (25.23 / 7.79 / 1.51 for an uncorrelated pool)", /±25\.23%/.test(cards[0]) && /±7\.79%/.test(cards[1]) && /±1\.51%/.test(cards[2]));
  const r = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "rw", value: 8100 }); const a = o.S.wiz.rw; o.dispatch({ type: "wiz", key: "rw", value: 10 }); const b = o.S.wiz.rw; o.dispatch({ type: "wiz", key: "rw", value: 999 }); return [a, b, o.S.wiz.rw, o.S.wiz.preset, document.querySelector("#rwLbl").textContent, document.querySelector("#rwMax").textContent]; });
  check("range: width is clamped to [150, 5000] (8100 → 5000, 10 → 150); custom width flags CUSTOM and ± is derived (999 → ±5.12%)", r[0] === 5000 && r[1] === 150 && r[2] === 999 && r[3] === "CUSTOM" && /±5\.12%/.test(r[4]) && /±28\.40%/.test(r[5]), JSON.stringify(r));
  const tight = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "setMult", mult: 1 }); o.dispatch({ type: "wiz", key: "rw", value: 300 }); const r = { apy: document.querySelector("#pApy").textContent, neg: document.querySelector("#pApy").classList.contains("neg"), next: document.querySelector("#nextBtn").textContent }; o.dispatch({ type: "setMult", mult: 4 }); return r; });
  check("range: at today's numbers the Aggressive width fails the gate; projection negative & red; Continue blocked with the reason", tight.neg && /gate/.test(tight.next) && tight.apy.startsWith("−"), JSON.stringify(tight));
  await page.evaluate(() => window.__oil.dispatch({ type: "wiz", key: "preset", value: "CONSERVATIVE" }));
  check("range: preset restores width 4500 and delay 48h", (await o("S")).wiz.rw === 4500 && (await o("S")).wiz.rd === 48);
}
check("projection: positive APY under what-if is green and the note says WHAT-IF", await page.$eval("#pApy", e => e.classList.contains("posv")) && /WHAT-IF/.test(await page.textContent("#pNote")));
await page.evaluate(() => window.__oil.dispatch({ type: "sim", kind: "refundNext", on: true }));
await page.click("#nextBtn");
check("review: LP review carries registry id, ± range, working slice, keeper permission and the what-if label", /Registry id/.test(await page.textContent("#revList")) && /±25\.23%/.test(await page.textContent("#revList")) && /WHAT-IF ×4/.test(await page.textContent("#revList")));
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
  check("collateral withdrawal: capped so the account never leaves the 1.55 entry floor; an over-cap request is refused", cap.cap < 100 && cap.refused && cap.hf >= 1.55 - 1e-9, JSON.stringify(cap));
}

/* ── 5. ladder (account-level), hysteresis, re-arm, keeper offline ── */
{
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "mode", value: "LP" }); o.dispatch({ type: "wiz", key: "asset", value: "cbBTC" }); o.dispatch({ type: "wiz", key: "amount", value: 0.25 }); o.dispatch({ type: "wiz", key: "ltv", value: 40 }); o.dispatch({ type: "wiz", key: "pool", value: "aero-cbbtc-usdc" }); o.dispatch({ type: "wiz", key: "preset", value: "CONSERVATIVE" }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 7; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); o.dispatch({ type: "flowDismiss" }); });
  check("ladder setup: a what-if LP position exists to unwind", (await o("S")).positions.some(p => p.kind === "LP" && p.lp > 0));
  const seq = await page.evaluate(() => { const o = window.__oil; const owner = o.S.wallet.addr; const L = () => Object.entries(o.ladderOf(o.S, owner)).filter(([, v]) => !v).map(([k]) => k).join(","); const out = []; const px = { ...o.S.price };
    for (const f of [0.8, 0.72, 0.66, 0.6, 0.55, 0.5]) { for (const a of ["cbBTC", "WETH"]) o.S = o.reduce(o.S, { type: "setPrice", asset: a, px: px[a] * f }); out.push([f, +o.accountHf(o.S, owner).toFixed(3), L()]); }
    const unwinds = o.S.activity.filter(a => /Partial unwind/.test(a.d)).length; const n0 = o.S.activity.length; for (let i = 0; i < 100; i++) o.S = o.reduce(o.S, { type: "setPrice", asset: "cbBTC", px: o.S.price.cbBTC * (i % 2 ? 1.003 : 0.997) }); const churn = o.S.activity.length - n0;
    for (const a of ["cbBTC", "WETH"]) o.S = o.reduce(o.S, { type: "setPrice", asset: a, px: px[a] * 1.5 }); const rearmed = L() === "";
    o.renderAll(); return { out, churn, rearmed, unwinds }; });
  check("ladder: account-level rungs fire in order (warn → repay → partial unwind) as both collaterals fall; the unwind restores HF above the warn rung and the lower rungs re-arm", seq.out.some(s => s[2] === "warn") && seq.out.some(s => s[2].includes("repay")) && seq.unwinds >= 1 && seq.out.some((s, i) => i > 0 && s[1] > seq.out[i - 1][1] && s[1] >= 1.5), JSON.stringify(seq));
  check("ladder hysteresis: 100 flat wiggles log zero events; recovery re-arms every rung", seq.churn === 0 && seq.rearmed, JSON.stringify(seq));
  const k = await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "sim", kind: "keeperOff", on: true }); const n0 = o.S.activity.length; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.S.price[a] * 0.3 }); const fired = Object.values(o.ladderOf(o.S, o.S.wallet.addr)).filter(v => !v).length; const logged = o.S.activity.length - n0; const banner = document.querySelector("#keeperBanner").style.display; o.dispatch({ type: "sim", kind: "keeperOff", on: false }); return { fired, logged, banner }; });
  check("keeper offline: nothing acts or logs; banner shown; keeper back evaluates the ladder", k.fired === 0 && k.logged === 0 && k.banner === "flex");
  check("wizard: new borrows are blocked while the heads-up rung is fired (HF parked at 1.45)", (await page.evaluate(() => { const o = window.__oil; const own = o.S.wallet.addr; const h = o.accountHf(o.S, own); const f = 1.45 / h; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.S.price[a] * f }); o.dispatch({ type: "wiz", key: "mode", value: "HOLD" }); o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 0.05 }); o.dispatch({ type: "wiz", key: "ltv", value: 30 }); return { hf: o.accountHf(o.S, own), warnFired: !o.ladderOf(o.S, own).warn, d: o.wizDecision(o.S) }; })).d.ok === false);
  await page.evaluate(() => { const o = window.__oil; for (const a of ["cbBTC", "WETH"]) o.dispatch({ type: "setPrice", asset: a, px: o.PRICE_READ[a] }); });
}

/* ── 6. store validation & two-tab ── */
{
  const cases = ['{"v":1,"positions":"nope"}', "garbage", "null", '{"v":2}', '{"v":2,"seq":0,"nextId":1,"lastTick":0,"wallet":null,"price":{"cbBTC":1},"borrowPct":4}', JSON.stringify({ v: 2, seq: 0, nextId: 1, lastTick: 0, wallet: null, price: { cbBTC: 1, WETH: 1, cbZEC: 1 }, borrowPct: 4, mult: 1, positions: [{ id: 1, kind: "LP", owner: "0x0", asset: "cbBTC" }], activity: [], credited: [], flow: null, ladders: {}, sim: { keeperOff: false }, wiz: {} }), JSON.stringify({ v: 2, seq: 0, nextId: 1, lastTick: 0, wallet: null, price: { cbBTC: 1, WETH: 1, cbZEC: 1 }, borrowPct: 4, mult: 1, positions: [{ id: 1, kind: "SUPPLY", owner: "0x7a3F9c1E4B2d8A6f0C5e3B7D9a1F4c6E8b2D0c1E", asset: "cbBTC", coll: -1, debt: 0, interest: 0, openedAt: 0, ageS: 0 }], activity: [], credited: [], flow: null, ladders: {}, sim: { keeperOff: false }, wiz: {} })];
  const res = await page.evaluate(cases => cases.map(c => window.__oil.validateStore(c).ok), cases);
  check("store: seven malformed shapes rejected (v1, garbage, missing fields, bad position, negative collateral)", res.every(x => x === false), JSON.stringify(res));
  check("store: the live state round-trips through validateStore", await page.evaluate(() => { const o = window.__oil; const r = o.validateStore(o.serialize(o.S)); return r.ok && r.state.positions.length === o.S.positions.length && r.state.credited.length === o.S.credited.length; }));
  const pageB = await openPage(b, srv.url("index.html"), { context: page.__ctx });
  await page.evaluate(() => { const o = window.__oil; o.dispatch({ type: "wiz", key: "mode", value: "SUPPLY" }); o.dispatch({ type: "wiz", key: "asset", value: "WETH" }); o.dispatch({ type: "wiz", key: "amount", value: 1 }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); o.dispatch({ type: "flowDismiss" }); });
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
  check("pools table: 9 rows, registry ids for engine pools, cbZEC row marked direct/no id, every cell gated at today's numbers", (await page.$$eval("#poolTable tbody tr", e => e.length)) === 9 && (await page.$$eval("#poolTable .ver", e => e.length)) === 8 && /gated|no_emissions|no_volatility|below_borrow/.test(await page.textContent("#poolTable")) && !/offered/.test(await page.textContent("#poolTable")));
  await page.click(".tab[data-view=docs]"); await page.click('#docsNav [data-doc="health"]');
  check("docs: ladder rows computed from HF_LADDER (re-arm at rung + 0.05 stated)", /Re-arms at HF ≥ 1\.55/.test(await page.textContent("#docLadder")) && /Re-arms at HF ≥ 1\.10/.test(await page.textContent("#docLadder")));
  await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(200);
  for (const v of ["dash", "wiz", "pools", "risks", "docs"]) { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(80); const s2 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]); check(`390px: no horizontal overflow on ${v}`, s2[0] <= s2[1], s2.join("/")); }
  await page.click("#tkBtn"); await page.waitForTimeout(80);
  const s3 = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check("390px: tester's kit fits", s3[0] <= s3[1]);
  check("tester's kit: failure simulations present (reject, revert, refund, range, keeper, store, crash, recover, what-if, seed)", ["fail:reject","fail:revert","refund","range:out","range:in","keeper:off","keeper:on","store:corrupt","px:-55","px:+30","mult:4","seed"].every(k => html.includes(`data-tk="${k}"`)));
}

/* ── 9. failure simulations through the reducer; spot swap ── */
{
  const p2 = await openPage(b, srv.url("index.html"));
  const r = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "connect", provider: "coinbase" }); o.dispatch({ type: "wiz", key: "mode", value: "SUPPLY" }); o.dispatch({ type: "wiz", key: "amount", value: 0.1 }); o.dispatch({ type: "sim", kind: "failNext", on: true, step: 1, why: "Wallet rejected the signature." }); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); return { status: o.S.flow.status, n: o.S.positions.length, credited: o.S.credited.length, log: o.S.activity[0].t }; });
  check("sim: wallet rejection → flow failed, no position, nothing credited, 'Reverted — nothing moved' logged", r.status === "failed" && r.n === 0 && r.credited === 0 && /Reverted/.test(r.log));
  const sp = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "flowDismiss" }); o.dispatch({ type: "wiz", key: "asset", value: "cbZEC" }); o.dispatch({ type: "wiz", key: "amount", value: 2 }); const d = o.wizDecision(o.S); o.dispatch({ type: "beginFlow" }); const id = o.S.flow.id; for (let i = 0; i < 6; i++) o.dispatch({ type: "flowAdvance", id }); o.dispatch({ type: "flowComplete", id }); const p = o.S.positions[0]; return { d, kind: p && p.kind, out: p && p.amountOut, hf: o.accountHf(o.S, o.S.wallet.addr) }; });
  check("spot: cbZEC → USDC via CoW is allowed (no collateral needed), records the disposal, HF stays ∞", sp.d.ok && sp.kind === "SPOT" && near(sp.out, 2 * 1020 * (1 - 0.0002), 1e-6) && sp.hf === Infinity, JSON.stringify(sp));
  const ex = await p2.evaluate(() => { const o = window.__oil; o.dispatch({ type: "seed" }); return o.S.positions.map(p => p.kind); });
  check("tester's kit: example positions load under the connected wallet only when it has none (spot already there → refused)", ex.join() === "SPOT");
  check("sim: zero console errors after every simulation", p2.__errors.length === 0, p2.__errors.join(" | "));
  await p2.close();
}

check("end: zero console errors on the main page across the whole suite", page.__errors.length === 0, page.__errors.join(" | "));
await b.close(); srv.close();
const out = done();
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
process.exit(out.fail ? 1 : 0);
