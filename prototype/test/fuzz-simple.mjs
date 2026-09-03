/* Portable Playwright loader: uses the workspace's playwright if installed,
   else a global one; CHROMIUM_PATH overrides the browser binary. Run from
   anywhere: node prototype/test/<file>.mjs */
import { fileURLToPath } from "url";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright"));
}
const LAUNCH = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const PAGE_URL = (f) => "file://" + fileURLToPath(new URL("../" + f, import.meta.url));
/* Oilskin simple.html v2 — combination + stateful fuzz.
   Part A: pure-logic grid over (pool × setting × what-if) + gate/address tables.
   Part B: stateful session fuzz through the real __oil seam (deposits, top-ups,
           partial withdraws, claims, compounds, refunds, failed txs, crashes,
           rebalances, persistence round-trips, find/forget).
   Part C: UI click-storm with zero page errors. */

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on("console", m => { if (m.type() === "error" && !/127\.0\.0\.1:8787|ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text()); });
page.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
await page.goto(PAGE_URL("simple.html"));
await page.waitForTimeout(500);

/* ── Part A ─────────────────────────────────────────────────────────── */
const A = await page.evaluate(() => {
  const o = window.__oil;
  let checks = 0, fails = [];
  const ok = (c, msg) => { checks++; if (!c) fails.push(msg); };
  const SETS = ["sheltered","steady","working"];
  const LTV = { sheltered:0.30, steady:0.40, working:0.50 };
  for (const aero of [1,2,4]) for (const brw of [null,8,4]) {
    o.setWhatIf(aero, brw);
    const B = o.borrow();
    ok(Math.abs(B - (brw ?? 13.47)) < 1e-9, `borrow() ${B} vs ${brw}`);
    for (const p of o.POOLS) for (const k of SETS) {
      const un = o.userNet(p, k), q = o.qualifies(p, k);
      ok(Number.isFinite(un), `userNet finite ${p.id}/${k}`);
      if (p.kind !== "LP") {
        ok(q === true, `lend always qualifies`);
        ok(Math.abs(un - o.supply()) < 1e-9, `lend userNet == supply`);
      } else {
        const m = o.modelRow(p, k);
        const eg = o.emisGross(p, k);
        ok(Math.abs(eg - m.emis * aero) < 1e-9, `emisGross linear in aero ${p.id}/${k}`);
        const net = o.lpNet(p, k);
        ok(Math.abs(net - (eg * o.NET_FEE + m.drag)) < 1e-9, `lpNet formula ${p.id}/${k}`);
        ok(q === (net > B), `qualifies ⇔ lpNet>borrow ${p.id}/${k} (${net.toFixed(2)} vs ${B})`);
        ok(Math.abs(un - (o.supply() + LTV[k] * (net - B))) < 1e-9, `userNet formula ${p.id}/${k}`);
        const wExp = p.corr ? {sheltered:12.5, steady:4, working:0.75}[k] : {sheltered:25, steady:8, working:1.5}[k];
        ok(m.w === wExp, `width ${p.id}/${k}: ${m.w} vs ${wExp}`);
        ok(m.delay === {sheltered:48, steady:12, working:2}[k], `delay ${p.id}/${k}`);
        ok(m.drag < 0 && m.tir > 0 && m.tir <= 1, `model row sane ${p.id}/${k}`);
      }
    }
    for (const k of SETS) {
      const best = o.bestPool(k);
      ok(o.qualifies(best, k), `bestPool qualifies ${k}`);
      for (const p of o.POOLS) if (o.qualifies(p, k)) ok(o.userNet(best, k) >= o.userNet(p, k) - 1e-9, `bestPool max ${k} ${p.id}`);
    }
    // monotonicity in aero for a fixed pool/setting done across the loop below
  }
  // monotone: more AERO → weakly higher userNet for LP
  for (const p of o.POOLS.filter(x=>x.kind==="LP")) for (const k of SETS) {
    const at = a => { o.setWhatIf(a, null); return o.userNet(p, k); };
    const u1 = at(1), u2 = at(2), u4 = at(4);
    ok(u2 >= u1 && u4 >= u2, `userNet monotone in aero ${p.id}/${k}`);
  }
  o.setWhatIf(1, null);
  // DROP / liqPrice
  ok(o.DROP(0.30) === 57 && o.DROP(0.40) === 43 && o.DROP(0.50) === 29, "DROP table");
  ok(Math.abs(o.liqPrice(487.2, 0.30) - 487.2*0.3/0.7) < 1e-9, "liqPrice");
  // gateDecision truth table
  const G = (a, ok_, typed, ex, poolOk) => o.gateDecision(a, ok_, typed, ex, poolOk);
  ok(G(0.1, true, true, 0, true).ok === false, "gate: below min");
  ok(G(0.25, true, true, 0, true).ok === true, "gate: at min");
  ok(G(10, false, true, 0, true).ok === false && /t1/.test(G(10,false,true,0,true).label), "gate: bad addr label");
  ok(G(10, false, false, 0, true).ok === false, "gate: empty addr");
  ok(G(10, true, true, 5, true).label.includes("Add to my position"), "gate: top-up label");
  ok(G(10, true, true, 0, false).ok === false && /isn't offered/.test(G(10,true,true,0,false).label), "gate: pool not offered");
  ok(G(1e9, true, true, 0, true).ok === true, "gate: no cap");
  for (const bad of [NaN, -5, 0, 0.2499]) ok(G(bad, true, true, 0, true).ok === false, "gate rejects " + bad);
  // address forms
  const forms = [
    ["t1Py8kAoQrfmRRWTbtHkDkGb6JuaXPmpGxy", true], ["t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd", true],
    ["  t1Py8kAoQrfmRRWTbtHkDkGb6JuaXPmpGxy  ", true], ["t1short", false], ["", false],
    ["u1demo0testonly0notreal0zaddr0qp7r9s2t4v6x8y0a2c4e6g8j0l2n4q6s8u0w2", false],
    ["zs1demo0testonly0notreal0sapling0zaddr0qp7r9s2t4v6x8y0a2c4e6g8j0l2n4q6s8u0w2x4z6a8c0e2", false],
    ["t2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false], ["0x"+"a".repeat(40), false],
  ];
  for (const [addr, exp] of forms) ok(o.checkAddr(addr).ok === exp, "checkAddr " + JSON.stringify(addr.slice(0,12)));
  return { checks, fails };
});
console.log(`Part A: ${A.checks} checks, ${A.fails.length} failures`);
A.fails.slice(0, 8).forEach(f => console.log("  A-FAIL:", f));

/* ── Part B ─────────────────────────────────────────────────────────── */
const B = await page.evaluate(async (SESSIONS) => {
  const o = window.__oil;
  let rng = 20260901;
  const rand = () => (rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296;
  const pick = a => a[Math.floor(rand() * a.length)];
  let checks = 0, actions = 0; const fails = [];
  const ok = (c, msg) => { checks++; if (!c && fails.length < 30) fails.push(msg); };
  const finitePos = v => Number.isFinite(v) && v >= -1e-9;

  const inv = (tag) => {
    const p = o.pos;
    ok(["LEND","LP"].includes(p.kind), tag+" kind");
    for (const f of ["zec","debtUsd","lpUsd","idleUsd","claimUsd","grossUsd"]) ok(finitePos(p[f]), `${tag} ${f}=${p[f]}`);
    if (!p.active) ok(p.zec === 0 && p.debtUsd === 0 && p.lpUsd === 0, tag+" inactive zeroed");
    if (p.active && p.kind === "LEND") ok(p.debtUsd === 0 && p.lpUsd === 0, tag+" lend has no debt/lp");
    if (p.active) ok(["in","out"].includes(p.range), tag+" range");
    ok(p.ladder >= 0 && p.ladder <= 3, tag+" ladder");
    ok(Number.isFinite(o.netValue()), tag+" netValue");
    if (p.debtUsd > 0) ok(Math.abs(o.hf() - p.zec * o.S.zec * o.LIQ_T / p.debtUsd) < 1e-9, tag+" hf formula");
    ok(o.activity.length <= 60, tag+" activity cap");
    for (const a of o.activity.slice(0, 3)) ok(typeof a.t === "string" && typeof a.ts === "number", tag+" act shape");
    try { const raw = localStorage.getItem(o.KEY); if (raw) { const d = JSON.parse(raw); ok(d.v === 1, tag+" store version"); } } catch (e) { ok(false, tag+" store parse: "+e.message); }
    try { o.renderPos(); } catch (e) { ok(false, tag+" renderPos threw: "+e.message); }
  };

  const openDeposit = (amt) => {
    // replicate openPosition through the real seam (bypasses modal timing)
    const k = o.pos.active ? o.pos.setting : o.settingOf(o.selLtv).k;
    const st = Object.values(o.SETTINGS).find(s => s.k === k);
    const p = o.poolById(o.pos.active ? o.pos.pool : o.selPool);
    if (!o.pos.active && !o.qualifies(p, k)) return false;
    const px = o.S.zec;
    if (o.pos.active) { o.pos.zec += amt; if (o.pos.kind === "LP") { const b = amt * px * o.pos.ltv; o.pos.debtUsd += b; o.pos.lpUsd += b; } }
    else Object.assign(o.pos, { active: true, kind: p.kind, zec: amt, home: "t1Py8kAoQrfmRRWTbtHkDkGb6JuaXPmpGxy", openedAt: Date.now(), ltv: st.ltv, setting: st.k, pool: p.id,
      debtUsd: p.kind === "LP" ? amt * px * st.ltv : 0, lpUsd: p.kind === "LP" ? amt * px * st.ltv : 0, idleUsd: 0, claimUsd: 0, grossUsd: 0, range: "in", outSince: 0, rebalances: 0, ladder: 0, warned: false, lastTick: Date.now() });
    o.save(); return true;
  };

  for (let s = 0; s < SESSIONS; s++) {
    // reset
    o.clearSaved(); Object.assign(o.pos, { active: false, kind: "LEND", zec: 0, home: "", debtUsd: 0, lpUsd: 0, idleUsd: 0, claimUsd: 0, grossUsd: 0, ladder: 0, warned: false, range: "in" });
    o.activity.length = 0; o.setWhatIf(pick([1, 1, 2, 4]), pick([null, null, 8, 4]));
    o.S.zec = o.S.base; o.selLtv = pick([0.3, 0.4, 0.5]); o.selPool = o.bestPool(o.settingOf(o.selLtv).k).id;
    o.syncRiskLock(); o.gate();
    const steps = 18 + Math.floor(rand() * 18);
    for (let i = 0; i < steps; i++) {
      const act = pick(["deposit","deposit","topup","withdraw","withdrawFull","claim","compound","sim","price","tick","persist","find","setting","pool","whatif"]);
      actions++;
      try {
        if (act === "deposit" && !o.pos.active) openDeposit(pick([0.25, 1, 10, 50, 250, 5000]));
        else if (act === "topup" && o.pos.active) openDeposit(pick([0.25, 3, 40]));
        else if (act === "withdraw" && o.pos.active) o.withdraw(pick([10, 20, 30, 50, 70, 90]));
        else if (act === "withdrawFull" && o.pos.active) o.withdraw(100);
        else if (act === "claim") o.claim();
        else if (act === "compound") o.compound(false);
        else if (act === "sim") o.simulate(pick(["bridgeFail","partialFill","outOfRange","crash","crash2","recover","txFail","compound"]));
        else if (act === "price") { o.S.zec = Math.max(20, o.S.zec * pick([0.7, 0.9, 1.0, 1.1, 1.4])); o.ladder(); }
        else if (act === "tick") o.tickAccrue(Date.now() + pick([1, 6, 24]) * 3600 * 1000);
        else if (act === "persist") { o.save(); const before = JSON.stringify(o.pos); o.load(); ok(JSON.stringify(o.pos) === before, "persist round-trip"); }
        else if (act === "find") { const r = o.find(pick(["t1Py8kAoQrfmRRWTbtHkDkGb6JuaXPmpGxy", "t1TEsT2aZxCvBnM4qWeRtY7uIoP9sDfG1hK", "bogus"])); ok(typeof r.ok === "boolean" && typeof r.msg === "string", "find shape"); }
        else if (act === "setting" && !o.pos.active) { o.selLtv = pick([0.3, 0.4, 0.5]); o.syncRiskLock(); }
        else if (act === "pool" && !o.pos.active) { const k = o.settingOf(o.selLtv).k; const q = o.POOLS.filter(p => o.qualifies(p, k)); o.selPool = pick(q).id; o.renderPools(); }
        else if (act === "whatif") o.setWhatIf(pick([1, 2, 4]), pick([null, 8, 4]));
      } catch (e) { ok(false, `action ${act} threw: ${e.message}`); }
      inv(`s${s}i${i}:${act}`);
    }
    // end-of-session: full exit must always work
    if (o.pos.active) { const r = o.withdraw(100); ok(!o.pos.active || r.retry, `s${s} exit liveness`); }
  }
  o.setWhatIf(1, null); o.clearSaved();
  return { checks, actions, fails };
}, 40);
console.log(`Part B: ${B.actions} actions, ${B.checks} checks, ${B.fails.length} failures`);
B.fails.forEach(f => console.log("  B-FAIL:", f));

/* ── Part C ─────────────────────────────────────────────────────────── */
await page.reload(); await page.waitForTimeout(500);
let clicks = 0;
for (let i = 0; i < 220; i++) {
  const sel = ["#riskSeg .segb", "#poolSeg .poolb:not([disabled])", ".tab[data-view]", "#tkBtn", "#tkOverlay [data-wi-aero]", "#tkOverlay [data-wi-borrow]", "#tkOverlay .x", "#demoBtn", "#forgetBtn", "#logoBtn", "#wdBtn", "[data-close]"][i % 12];
  const els = await page.$$(sel);
  if (!els.length) continue;
  const el = els[Math.floor(Math.random() * els.length)];
  try { if (await el.isVisible()) { await el.click({ timeout: 800 }); clicks++; } } catch {}
  if (i % 40 === 0) await page.waitForTimeout(80);
}
await page.waitForTimeout(400);
console.log(`Part C: ${clicks} random clicks`);

const totalFails = A.fails.length + B.fails.length + errs.length;
console.log(`\nTOTAL: ${A.checks + B.checks} checks · ${B.actions} fuzz actions · ${clicks} UI clicks · ${totalFails === 0 ? "ALL CLEAN" : totalFails + " FAILURES"}`);
errs.slice(0, 8).forEach(e => console.log("  PAGE-ERR:", e.slice(0, 200)));
await browser.close();
process.exit(totalFails ? 1 : 0);
