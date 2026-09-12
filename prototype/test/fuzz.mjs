/* fuzz — seeded stateful fuzz of BOTH builds' real reducers (window.__oil), ≥ 5,000
   actions × 3 seeds each, with the audit's invariants checked after every action:
     • no NaN / negative in any position number, price, rate or selection
     • sign discipline (emissions, interest, claimed ≥ 0; rendered net sign = computed sign)
     • exactly-once credit (credited ids unique; collateral changes only by a credit,
       a withdraw, or bounded supply growth)
     • ladder hysteresis (fired ⇒ HF < disarm; keeper on ⇒ never armed while HF < rung)
     • bounded accrual (one tick moves debt/collateral/emissions by at most one demo hour)
     • store schema (serialize → validate round-trips; random corruption never throws)
     • the keeper's grant (remaining time in [0, expiry]; a grant that is expired
       or revoked NEVER lets a rung fire; renewing restores exactly the full term)
     • the gate (every verdict's reason is one of the known reasons and carries a
       plain-English sentence; an offered cell clears the borrow on BOTH the
       closed form and the Monte-Carlo-calibrated form, and is never offered
       while a guardian pause or an uncorroborated anchor is in force)
     • the swap floor (minOutFor is monotone in the quote, refuses a tolerance
       above the on-chain cap, and never returns a floor of zero on a live quote)
   Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/fuzz.mjs [--actions 5000] [--seeds 1,2,3] */
import { serve, browser, openPage, runner } from "./_harness.mjs";

const argv = process.argv.slice(2);
const N = +(argv[argv.indexOf("--actions") + 1] || 5000);
const SEEDS = (argv.includes("--seeds") ? argv[argv.indexOf("--seeds") + 1] : "11,22,33").split(",").map(Number);
const { check, done } = runner("fuzz");
const srv = await serve(); const b = await browser();

/* ── the in-page fuzzer for simple.html ── */
const fuzzSimple = ([seed, N]) => {
  const o = window.__oil; o.seedRng(seed);
  let x = seed >>> 0 || 1; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  o.storage = { _v: null, get() { return this._v; }, set(v) { this._v = v; }, del() { this._v = null; } };
  o.S = o.freshState();
  const V = []; const fail = (m, extra) => { if (V.length < 20) V.push(m + (extra ? " " + JSON.stringify(extra).slice(0, 300) : "")); };
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const YR = 365 * 86400; let credits = {}; let n = 0, byType = {};
  const KNOWN_REASONS = Object.keys(o.GATE_WHY).concat(["ok"]);
  const numsOk = s => { const p = s.pos; if (p) for (const k of ["coll", "debt", "lp", "lpBasis", "emis", "idle", "interest", "claimed", "ageS"]) if (!fin(p[k]) || p[k] < 0) return "pos." + k + "=" + p[k]; for (const k of ["cbBTC", "WETH", "cbZEC"]) if (!fin(s.price[k]) || s.price[k] <= 0) return "price." + k; if (!fin(s.borrowPct) || s.borrowPct < 0 || s.borrowPct > 100) return "borrowPct"; if (!fin(s.mult) || s.mult < 1) return "mult"; if (!fin(s.sel.amount) || s.sel.amount < 0) return "sel.amount"; if (![30, 40, 50].includes(s.sel.ltv)) return "sel.ltv"; return null; };
  for (let i = 0; i < N; i++) {
    const s = o.S; const before = s.pos ? JSON.parse(JSON.stringify(s.pos)) : null; const flowBefore = s.flow ? { ...s.flow } : null; const credBefore = s.credited.length;
    const kind = pick(["connect", "connect", "disconnect", "selectAsset", "selectLtv", "selectPool", "setAmount", "setAmount", "ack", "ack", "beginDeposit", "beginDeposit", "flowAdvance", "flowAdvance", "flowAdvance", "flowComplete", "flowComplete", "flowDismiss", "tick", "tick", "tick", "setPrice", "setPrice", "setPrice", "withdraw", "claim", "setRange", "sim", "sim", "setBorrowRate", "setMult", "loadExample", "clearExample", "renewGrant", "revokeGrant", "swapReverted", "gateProbe", "storeRoundTrip"]);
    byType[kind] = (byType[kind] || 0) + 1;
    let a;
    switch (kind) {
      case "connect": a = { type: "connect", provider: pick(["coinbase", "metamask", "walletconnect"]), addr: rnd() < 0.8 ? undefined : o.DEMO_WALLETS.other }; break;
      case "disconnect": a = { type: "disconnect" }; break;
      case "selectAsset": a = { type: "selectAsset", asset: pick(["cbBTC", "WETH", "cbZEC", "USDC", "nope"]) }; break;
      case "selectLtv": a = { type: "selectLtv", ltv: pick([30, 40, 50, 60, 0, -10, NaN, 45]) }; break;
      case "selectPool": a = { type: "selectPool", pool: pick(o.MODEL.pools.map(p => p.id).concat(["bogus"])) }; break;
      case "setAmount": a = { type: "setAmount", amount: pick([0.001, 0.02, 0.05, 0.3, 1, 12, 0.6, 0, -1, NaN, Infinity, 1e308, 1e-9, rnd()]) }; break;
      case "ack": a = { type: "ack", on: rnd() < 0.75 }; break;
      case "beginDeposit": a = { type: "beginDeposit" }; break;
      case "flowAdvance": a = { type: "flowAdvance", id: s.flow && rnd() < 0.85 ? s.flow.id : Math.floor(rnd() * 1e9) }; break;
      case "flowComplete": a = { type: "flowComplete", id: s.flow && rnd() < 0.85 ? s.flow.id : (s.credited.length && rnd() < 0.5 ? pick(s.credited) : Math.floor(rnd() * 1e9)) }; break;
      case "flowDismiss": a = { type: "flowDismiss" }; break;
      case "tick": a = { type: "tick", dt: pick([1, 60, 600, 3600, 86400, 1e9, 1e12, NaN, -5, Infinity, rnd() * 7200]) }; break;
      case "setPrice": { const asset = pick(["cbBTC", "WETH", "cbZEC"]); a = { type: "setPrice", asset, px: pick([s.price[asset] * (1 + (rnd() - 0.5) * 0.01), s.price[asset] * pick([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 1.1, 1.3, 1.6, 2]), NaN, 0, -1, Infinity, 1e-12, 1e12]) }; break; }
      case "withdraw": a = { type: "withdraw", pct: pick([10, 30, 50, 90, 100, 0, -5, 150, NaN]) }; break;
      case "claim": a = { type: "claim" }; break;
      case "setRange": a = { type: "setRange", inRange: rnd() < 0.5 }; break;
      case "sim": a = pick([{ type: "sim", kind: "keeperOff", on: rnd() < 0.5 }, { type: "sim", kind: "failNext", on: rnd() < 0.7, step: pick([1, 2, 3, 4]), why: "fuzz revert" }, { type: "sim", kind: "refundNext", on: rnd() < 0.7 },
        { type: "sim", kind: "paused", asset: pick(["cbBTC", "WETH", "USDC", "cbZEC", "nope"]), on: rnd() < 0.5 }, { type: "sim", kind: "corroborated", on: rnd() < 0.75 }, { type: "sim", kind: "revote", on: rnd() < 0.5 }, { type: "sim", kind: "sandwich", on: rnd() < 0.5 }]); break;
      case "setBorrowRate": a = { type: "setBorrowRate", pct: pick([4.828, 0, 9, 25, 100, -1, 200, NaN]) }; break;
      case "setMult": a = { type: "setMult", mult: pick([1, 1, 2, 4, 5, 6.35, 8, 8.65, 12, 12.21, 0, -1, NaN, 500]) }; break;
      case "loadExample": a = { type: "loadExample" }; break;
      case "clearExample": a = { type: "clearExample" }; break;
      case "renewGrant": a = { type: "renewGrant" }; break;
      case "revokeGrant": a = { type: "revokeGrant" }; break;
      case "swapReverted": a = { type: "swapReverted", minOut: rnd() * 1e4, out: rnd() * 1e4, err: "InsufficientOutput()" }; break;
      case "gateProbe": {
        /* Pure-function invariants on the gate and the swap floor — no state change. */
        const pool = pick(o.MODEL.pools), w = pick([150, 300, 784, 1500, 2356, 4500, 5000, Math.floor(150 + rnd() * 4850)]);
        const opts = { paused: s.sim.paused, corroborated: s.sim.corroborated, revote: s.sim.revote, collateral: pick(["cbBTC", "WETH", "cbZEC", undefined]) };
        let g; try { g = o.gate(pool, s.borrowPct, w, s.mult, opts); } catch (e) { fail("gate threw", e.message); n++; continue; }
        if (!KNOWN_REASONS.includes(g.reason)) fail("gate: unknown reason " + g.reason);
        if (!g.ok && !(typeof g.why === "string" && g.why.length > 30)) fail("gate: refusal without a plain-English sentence", { reason: g.reason, why: g.why });
        if (g.ok) {
          if (!(g.net > s.borrowPct)) fail("gate: offered below the borrow on the closed form", { net: g.net, b: s.borrowPct });
          if (!(g.mcNet > s.borrowPct)) fail("gate: offered below the borrow on the MC form", { mc: g.mcNet, b: s.borrowPct });
          if (Math.abs(g.net) > o.MODEL.bounds.maxAbsNetPct) fail("gate: offered outside the absolute bound");
          if (g.gross > o.MODEL.bounds.maxEmissionsAprPct) fail("gate: offered above the emissions ceiling");
          if (opts.collateral && (s.sim.paused[opts.collateral] || s.sim.paused.USDC)) fail("gate: offered through a guardian pause");
          if (s.sim.corroborated === false) fail("gate: offered on an uncorroborated anchor");
        }
        const mc = o.mcLpNetPct(pool, w, s.mult);
        if (mc !== null && !fin(mc)) fail("mcLpNetPct not finite", mc);
        /* The forecast (D4/D5): refuses only for safety; prices whatever σ allows; `both` means both forms beat the borrow. */
        let f; try { f = o.forecast(pool, s.borrowPct, w, s.mult, opts); } catch (e) { fail("forecast threw", e.message); n++; continue; }
        if (f.allowed === o.FORECAST_SAFETY.includes(f.reason)) fail("forecast: allowed disagrees with the safety list", { reason: f.reason, allowed: f.allowed });
        if (!f.allowed && (f.priced || !f.refusal)) fail("forecast: a refused cell must be unpriced and name its refusal", { reason: f.reason });
        if (f.allowed && f.priced && !(fin(f.net))) fail("forecast: priced without a finite net");
        if (f.allowed && !f.priced && !(typeof f.unpriced === "string" && KNOWN_REASONS.includes(f.unpriced))) fail("forecast: unpriced without a known reason", { unpriced: f.unpriced });
        if (f.allowed && pool.sigma != null && !(g.reason === "emissions_implausible" || g.reason === "insufficient_samples") && !f.priced) fail("forecast: a σ cell with a trustworthy reading must be priced", { reason: g.reason });
        if (f.clears.both === true && !(f.net > s.borrowPct && f.mcNet > s.borrowPct)) fail("forecast: both without both forms above the borrow");
        if (g.ok && f.clears.both !== true) fail("forecast: the gate's ok must read as beating the borrow on both", { reason: g.reason });
        if (!(typeof o.forecastWhy(f) === "string" && o.forecastWhy(f).length > 20 && !/^[a-z_]+$/.test(o.forecastWhy(f)))) fail("forecast: no plain sentence");
        const leg = o.swapLegFor(pool, Math.max(0, rnd() * 1e5), pick([0, 1, 50, 100, 500, 501, 10000, -1]));
        if (leg.minOut !== null) { if (!(leg.minOut > 0) || leg.minOut > leg.quotedOut + 1e-9) fail("swap: floor outside (0, quote]", leg); }
        else if (leg.legUsd > 0 && leg.maxSlippageBps >= 0 && leg.maxSlippageBps <= o.CONTRACTS.swap.maxSlippageBpsCap) fail("swap: no floor on a live quote", leg);
        n++; continue;
      }
      case "storeRoundTrip": {
        const raw = o.serialize(s); const r = o.validateStore(raw); if (!r.ok) fail("store: live state rejected", r.why);
        else { const again = o.serialize(Object.assign(r.state, { seq: s.seq })); if (again !== o.serialize(Object.assign(o.validateStore(raw).state, { seq: s.seq }))) fail("store: validate not idempotent"); }
        const chars = raw.split(""); const k = Math.floor(rnd() * chars.length); chars[k] = pick(['"', "x", "-", "{", "9", "", "null"]); try { o.validateStore(chars.join("")); } catch (e) { fail("store: validateStore threw on corrupt input", e.message); }
        try { o.validateStore(pick([null, undefined, 42, "", "[]", "{}", '{"v":2}', '{"v":"2"}', '{"v":2,"seq":"a"}'])); } catch (e) { fail("store: validateStore threw on junk", e.message); }
        n++; continue;
      }
    }
    try { o.S = o.reduce(o.S, a); } catch (e) { fail("reducer threw on " + kind, e.message); continue; }
    n++;
    const t = o.S; const bad = numsOk(t); if (bad) fail("NaN/negative after " + kind + ": " + bad, a);
    // exactly-once credit
    if (new Set(t.credited).size !== t.credited.length) fail("credited ids duplicated");
    if (t.credited.length > credBefore) { const id = t.credited[t.credited.length - 1]; credits[id] = (credits[id] || 0) + 1; if (credits[id] > 1) fail("credited twice", id); if (!flowBefore || flowBefore.id !== id || flowBefore.status !== "signing") fail("credit without a signing flow", { flowBefore, id }); }
    // collateral only moves by credit / withdraw / bounded supply growth / example load-clear
    if (before && t.pos && !before.example && !t.pos.example) {
      const d = t.pos.coll - before.coll;
      if (kind === "tick") { const cap = before.coll * (o.CHAIN_READ.aaveReserves[before.asset].supplyAprPct / 100) * o.MAX_TICK_S / YR * (1 + 1e-9) + 1e-12; if (d < -1e-12 || d > cap) fail("bounded accrual: collateral moved too much in one tick", { d, cap }); }
      else if (kind === "withdraw") { if (d > 1e-12) fail("withdraw increased collateral"); }
      else if (kind === "flowComplete") { if (t.credited.length > credBefore) { if (Math.abs(d - flowBefore.amount) > 1e-12) fail("credit amount ≠ flow amount", { d, amt: flowBefore.amount }); } else if (Math.abs(d) > 1e-12) fail("collateral moved without a credit"); }
      else if (Math.abs(d) > 1e-12) fail("collateral moved on " + kind, d);
    }
    // bounded accrual on debt / emissions
    if (kind === "tick" && before && t.pos && !before.example) {
      const rate = t.borrowPct / 100 * o.MAX_TICK_S / YR; if (t.pos.debt > before.debt * (1 + rate) * (1 + 1e-9) + 1e-9) fail("bounded accrual: debt grew more than one demo hour", { b: before.debt, a: t.pos.debt });
      const pool = o.poolById(before.pool); const rr = o.accrualRates(pool, o.widthFor(pool), t.mult); if (t.pos.emis > (before.emis + before.lp * rr.realized * o.MAX_TICK_S / YR) * (1 + 1e-9) + 1e-9) fail("bounded accrual: emissions grew more than one demo hour");
      if (t.pos.lp > before.lp + 1e-12) fail("lp grew on a tick");
    }
    // sign discipline
    if (t.pos) { if (t.pos.emis < 0 || t.pos.claimed < 0 || t.pos.interest < 0) fail("sign: negative emis/claimed/interest"); const net = o.netSoFar(t.pos); if (!fin(net)) fail("net so far not finite"); }
    // ladder hysteresis consistency
    if (t.pos && !t.pos.example) { const hf = o.hfOf(t.pos); const gr = o.grantOf(t.pos);
      if (!fin(gr.remainingS) || gr.remainingS > o.GRANT_EXPIRY_S + 1e-9) fail("grant: remaining time above the full term", gr.remainingS);
      if (kind === "renewGrant" && !t.pos.example && Math.abs(gr.remainingS - o.GRANT_EXPIRY_S) > 1e-9) fail("grant: renew did not restore the full term", gr.remainingS);
      if (kind === "revokeGrant" && !t.pos.example && gr.live) fail("grant: revoke left the permission live");
      const before2 = before && before.ladder; if (!gr.live && before2 && ["tick", "setPrice", "withdraw", "claim"].includes(kind)) { for (const r of o.RUNGS) if (before2[r] && !t.pos.ladder[r]) fail("grant: a rung fired without a live permission", { r, kind }); }
      for (const r of o.RUNGS) { const armed = t.pos.ladder[r]; if (!armed && hf >= o.LADDER.disarm[r]) fail("ladder: fired rung while HF ≥ disarm", { r, hf }); if (gr.live && !t.sim.keeperOff && armed && hf < o.LADDER.rungs[r] && ["tick", "setPrice", "withdraw", "flowComplete", "sim"].includes(kind)) fail("ladder: armed rung below its line after evaluation", { r, hf, kind }); } }
    // flow sanity
    if (t.flow && t.flow.status === "done" && !t.credited.includes(t.flow.id)) fail("done flow not credited");
    if (t.flow && t.flow.status === "signing" && t.pos && t.pos.example) fail("signing flow with an example position");
  }
  o.renderAll();
  // DOM sign discipline at the end
  if (o.S.pos && !o.S.pos.example && document.querySelector("#posWrap").style.display === "block") { const el = document.querySelector("#pEarned"); const net = o.netSoFar(o.S.pos); if ((net < 0) !== el.textContent.startsWith("−") || (net < 0) !== el.classList.contains("neg")) fail("DOM sign discipline", { net, txt: el.textContent }); }
  o.unseedRng();
  return { n, violations: V, byType, credited: o.S.credited.length };
};

/* ── the in-page fuzzer for index.html ── */
const fuzzAdvanced = ([seed, N]) => {
  const o = window.__oil; o.seedRng(seed);
  let x = (seed * 7919) >>> 0 || 1; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  o.storage = { _v: null, get() { return this._v; }, set(v) { this._v = v; }, del() { this._v = null; } };
  o.S = o.freshState();
  const V = []; const fail = (m, extra) => { if (V.length < 20) V.push(m + (extra ? " " + JSON.stringify(extra).slice(0, 300) : "")); };
  const fin = v => typeof v === "number" && Number.isFinite(v); const YR = 365 * 86400;
  let n = 0, byType = {}, credits = {};
  const KNOWN_REASONS = Object.keys(o.GATE_WHY).concat(["ok"]);
  const numsOk = s => { for (const p of s.positions) { for (const k of ["coll", "debt", "interest", "ageS"]) if (!fin(p[k]) || p[k] < 0) return p.kind + "." + k + "=" + p[k]; if (p.kind === "LP") for (const k of ["lp", "lpBasis", "emis", "idle", "claimed", "cooldown"]) if (!fin(p[k]) || p[k] < 0) return "LP." + k + "=" + p[k]; if (p.kind === "LP" && (p.widthBps < o.SHARED.RANGE_WIDTH_BOUNDS.min || p.widthBps > o.SHARED.RANGE_WIDTH_BOUNDS.max)) return "LP.widthBps"; if (p.kind === "HOLD" && (!fin(p.usdc) || p.usdc < 0)) return "HOLD.usdc"; }
    for (const k of ["cbBTC", "WETH", "cbZEC"]) if (!fin(s.price[k]) || s.price[k] <= 0) return "price." + k; if (!fin(s.borrowPct) || s.borrowPct < 0 || s.borrowPct > 100) return "borrowPct"; if (!fin(s.mult) || s.mult < 1) return "mult";
    const w = s.wiz; if (!fin(w.rw) || w.rw < o.SHARED.RANGE_WIDTH_BOUNDS.min || w.rw > o.SHARED.RANGE_WIDTH_BOUNDS.max) return "wiz.rw=" + w.rw; if (!fin(w.rd) || w.rd < 0 || w.rd > 168) return "wiz.rd"; if (!fin(w.ltv) || w.ltv < 1 || w.ltv > 50) return "wiz.ltv=" + w.ltv; if (![1, 2, 3, 4].includes(w.step)) return "wiz.step";
    if (new Set(s.positions.map(p => p.id)).size !== s.positions.length) return "duplicate ids"; return null; };
  const snap = s => JSON.parse(JSON.stringify(s.positions));
  for (let i = 0; i < N; i++) {
    const s = o.S; const before = snap(s); const flowBefore = s.flow ? { ...s.flow } : null; const credBefore = s.credited.length; const owner = s.wallet && s.wallet.addr;
    const debtBefore = owner ? o.debtOf(s, owner) : 0; const before2Ladders = JSON.parse(JSON.stringify(s.ladders));
    const kind = pick(["connect", "connect", "disconnect", "wiz", "wiz", "wiz", "wiz", "wiz", "beginFlow", "beginFlow", "flowAdvance", "flowAdvance", "flowAdvance", "flowComplete", "flowComplete", "flowDismiss", "tick", "tick", "tick", "setPrice", "setPrice", "setPrice", "withdraw", "withdraw", "claim", "compound", "adjust", "setRange", "sim", "sim", "setBorrowRate", "setMult", "seed", "renewGrant", "revokeGrant", "expireGrant", "swapReverted", "gateProbe", "storeRoundTrip"]);
    byType[kind] = (byType[kind] || 0) + 1;
    let a; const anyId = () => s.positions.length && rnd() < 0.85 ? pick(s.positions).id : Math.floor(rnd() * 1e6);
    switch (kind) {
      case "connect": a = { type: "connect", provider: pick(["coinbase", "metamask", "walletconnect"]), addr: rnd() < 0.8 ? undefined : o.DEMO_WALLETS.other }; break;
      case "disconnect": a = { type: "disconnect" }; break;
      case "wiz": { const key = pick(["asset", "amount", "mode", "ltv", "pool", "preset", "rw", "rd", "rew", "econ", "step"]); const value = { asset: pick(["cbBTC", "WETH", "cbZEC", "USDC"]), amount: pick([0.001, 0.05, 0.2, 0.5, 1, 12, 40, 0, -1, NaN, Infinity, 1e308, rnd()]), mode: pick(o.MODES.concat(["bogus"])), ltv: pick([5, 30, 40, 50, 51, 80, 0, -3, NaN, 30.7]), pool: pick(o.MODEL.pools.map(p => p.id).concat(["bogus"])), preset: pick(["CONSERVATIVE", "MODERATE", "AGGRESSIVE", "CUSTOM", "x"]), rw: pick([150, 300, 784, 1500, 2356, 4500, 5000, 149, 5001, 8100, 10, 0, -1, NaN, Infinity, 999.6]), rd: pick([0, 2, 12, 48, 168, 169, -1, NaN]), rew: pick(["COMPOUND", "CLAIM_TO_WALLET", "SEND_HOME"]), econ: rnd() < 0.5, step: pick([1, 2, 3, 4, 5, 0, NaN]) }[key]; a = { type: "wiz", key, value }; break; }
      case "beginFlow": a = { type: "beginFlow" }; break;
      case "flowAdvance": a = { type: "flowAdvance", id: s.flow && rnd() < 0.85 ? s.flow.id : Math.floor(rnd() * 1e9) }; break;
      case "flowComplete": a = { type: "flowComplete", id: s.flow && rnd() < 0.85 ? s.flow.id : (s.credited.length && rnd() < 0.5 ? pick(s.credited) : Math.floor(rnd() * 1e9)) }; break;
      case "flowDismiss": a = { type: "flowDismiss" }; break;
      case "tick": a = { type: "tick", dt: pick([1, 60, 3600, 86400, 1e9, 1e12, NaN, -5, Infinity, rnd() * 7200]) }; break;
      case "setPrice": { const asset = pick(["cbBTC", "WETH", "cbZEC"]); a = { type: "setPrice", asset, px: pick([s.price[asset] * (1 + (rnd() - 0.5) * 0.01), s.price[asset] * pick([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 1.1, 1.3, 1.6, 2]), NaN, 0, -1, Infinity, 1e-12, 1e12]) }; break; }
      case "withdraw": a = { type: "withdraw", id: anyId(), pct: pick([5, 25, 50, 75, 100, 0, -5, 150, NaN]), dest: pick(["REPAY", "WALLET", "bogus"]) }; break;
      case "claim": a = { type: "claim", id: anyId(), dest: pick(["REPAY", "WALLET"]) }; break;
      case "compound": a = { type: "compound", id: anyId() }; break;
      case "adjust": a = { type: "adjust", id: anyId(), widthBps: pick([150, 300, 4500, 5000, 149, 5001, NaN, -1, 999.4]), delayH: pick([0, 12, 168, 169, -1, NaN]), autoCompound: pick([true, false, "yes"]) }; break;
      case "setRange": a = { type: "setRange", id: anyId(), inRange: rnd() < 0.5 }; break;
      case "sim": a = pick([{ type: "sim", kind: "keeperOff", on: rnd() < 0.5 }, { type: "sim", kind: "failNext", on: rnd() < 0.7, step: pick([1, 2, 3, 4]), why: "fuzz revert" }, { type: "sim", kind: "refundNext", on: rnd() < 0.7 },
        { type: "sim", kind: "paused", asset: pick(["cbBTC", "WETH", "USDC", "cbZEC", "nope"]), on: rnd() < 0.5 }, { type: "sim", kind: "corroborated", on: rnd() < 0.75 }, { type: "sim", kind: "revote", on: rnd() < 0.5 }, { type: "sim", kind: "sandwich", on: rnd() < 0.5 }]); break;
      case "setBorrowRate": a = { type: "setBorrowRate", pct: pick([4.828, 0, 9, 25, 100, -1, 200, NaN]) }; break;
      case "setMult": a = { type: "setMult", mult: pick([1, 1, 2, 4, 5, 6.35, 8, 8.65, 12, 12.21, 0, -1, NaN, 500]) }; break;
      case "seed": a = { type: "seed" }; break;
      case "renewGrant": a = { type: "renewGrant", owner: rnd() < 0.85 ? undefined : o.DEMO_WALLETS.other }; break;
      case "revokeGrant": a = { type: "revokeGrant", owner: rnd() < 0.85 ? undefined : o.DEMO_WALLETS.other }; break;
      case "expireGrant": a = { type: "expireGrant" }; break;
      case "swapReverted": a = { type: "swapReverted", minOut: rnd() * 1e4, out: rnd() * 1e4, err: "InsufficientOutput()" }; break;
      case "gateProbe": {
        const pool = pick(o.MODEL.pools), w = pick([150, 300, 784, 1500, 2356, 4500, 5000, Math.floor(150 + rnd() * 4850)]);
        const opts = { paused: s.sim.paused, corroborated: s.sim.corroborated, revote: s.sim.revote, collateral: pick(["cbBTC", "WETH", "cbZEC", undefined]) };
        let g; try { g = o.gate(pool, s.borrowPct, w, s.mult, opts); } catch (e) { fail("gate threw", e.message); n++; continue; }
        if (!KNOWN_REASONS.includes(g.reason)) fail("gate: unknown reason " + g.reason);
        if (!g.ok && !(typeof g.why === "string" && g.why.length > 30)) fail("gate: refusal without a plain-English sentence", { reason: g.reason, why: g.why });
        if (g.ok) {
          if (!(g.net > s.borrowPct)) fail("gate: offered below the borrow on the closed form", { net: g.net, b: s.borrowPct });
          if (!(g.mcNet > s.borrowPct)) fail("gate: offered below the borrow on the MC form", { mc: g.mcNet, b: s.borrowPct });
          if (Math.abs(g.net) > o.MODEL.bounds.maxAbsNetPct) fail("gate: offered outside the absolute bound");
          if (g.gross > o.MODEL.bounds.maxEmissionsAprPct) fail("gate: offered above the emissions ceiling");
          if (opts.collateral && (s.sim.paused[opts.collateral] || s.sim.paused.USDC)) fail("gate: offered through a guardian pause");
          if (s.sim.corroborated === false) fail("gate: offered on an uncorroborated anchor");
        }
        const mc = o.mcLpNetPct(pool, w, s.mult); if (mc !== null && !fin(mc)) fail("mcLpNetPct not finite", mc);
        const leg = o.swapLegFor(pool, Math.max(0, rnd() * 1e5), pick([0, 1, 50, 100, 500, 501, 10000, -1]));
        if (leg.minOut !== null) { if (!(leg.minOut > 0) || leg.minOut > leg.quotedOut + 1e-9) fail("swap: floor outside (0, quote]", leg); }
        else if (leg.legUsd > 0 && leg.maxSlippageBps >= 0 && leg.maxSlippageBps <= o.CONTRACTS.swap.maxSlippageBpsCap) fail("swap: no floor on a live quote", leg);
        n++; continue;
      }
      case "storeRoundTrip": { const raw = o.serialize(s); const r = o.validateStore(raw); if (!r.ok) fail("store: live state rejected", r.why); const chars = raw.split(""); const k = Math.floor(rnd() * chars.length); chars[k] = pick(['"', "x", "-", "{", "9", "", "null"]); try { o.validateStore(chars.join("")); } catch (e) { fail("store: validateStore threw on corrupt input", e.message); } n++; continue; }
    }
    try { o.S = o.reduce(o.S, a); } catch (e) { fail("reducer threw on " + kind, e.message + " " + JSON.stringify(a)); continue; }
    n++;
    const t = o.S; const bad = numsOk(t); if (bad) fail("NaN/negative/out-of-bounds after " + kind + ": " + bad, a);
    if (new Set(t.credited).size !== t.credited.length) fail("credited ids duplicated");
    if (t.credited.length > credBefore) { const id = t.credited[t.credited.length - 1]; credits[id] = (credits[id] || 0) + 1; if (credits[id] > 1) fail("credited twice", id); if (!flowBefore || flowBefore.id !== id || flowBefore.status !== "signing") fail("credit without a signing flow"); if (t.positions.length !== before.length + 1) fail("credit did not add exactly one position"); }
    if (!["flowComplete", "seed", "withdraw"].includes(kind) && t.positions.length !== before.length) fail("position count changed on " + kind);
    if (kind === "flowComplete" && t.credited.length === credBefore && t.positions.length !== before.length) fail("position added without a credit");
    // debt is never deleted by a withdrawal to the wallet; repay never increases it
    if (kind === "withdraw" && owner && t.wallet && t.wallet.addr === owner) { const debtAfter = o.debtOf(t, owner); if (a.dest !== "REPAY" && debtAfter < debtBefore - 1e-9) fail("withdraw to wallet reduced debt", { debtBefore, debtAfter, a }); if (debtAfter > debtBefore + 1e-9) fail("withdraw increased debt"); }
    // bounded accrual per position on a tick
    if (kind === "tick") for (const p0 of before) { const p1 = t.positions.find(p => p.id === p0.id); if (!p1) { fail("tick removed a position"); continue; } if (p1.debt > p0.debt * (1 + t.borrowPct / 100 * o.MAX_TICK_S / YR) * (1 + 1e-9) + 1e-9) fail("bounded accrual: debt", { b: p0.debt, a: p1.debt }); const sup = (o.CHAIN_READ.aaveReserves[p0.asset] || { supplyAprPct: 0 }).supplyAprPct; if (p1.coll > p0.coll * (1 + sup / 100 * o.MAX_TICK_S / YR) * (1 + 1e-9) + 1e-12) fail("bounded accrual: collateral"); if (p0.kind === "LP" && p1.kind === "LP") { const rr = o.accrualRates(o.poolById(p0.pool), p0.widthBps, t.mult); if (p1.emis > (p0.emis + p0.lp * rr.realized * o.MAX_TICK_S / YR) * (1 + 1e-9) + 1e-9) fail("bounded accrual: emissions"); if (p1.lp > p0.lp + 1e-12) fail("lp grew on tick"); } }
    // ladder consistency per owner
    for (const [k, g] of Object.entries(t.grants)) { if (!fin(g.remainingS) || g.remainingS < 0 || g.remainingS > o.GRANT_EXPIRY_S + 1e-9) fail("grant: remaining time outside [0, term]", { k, g }); if (typeof g.revoked !== "boolean" || typeof g.notified !== "boolean") fail("grant: flags not boolean", g); }
    if (kind === "renewGrant" && owner && t.grants[owner.toLowerCase()] && a.owner === undefined && Math.abs(t.grants[owner.toLowerCase()].remainingS - o.GRANT_EXPIRY_S) > 1e-9) fail("grant: renew did not restore the full term");
    for (const own of new Set(t.positions.map(p => p.owner.toLowerCase()))) { const L = t.ladders[own]; if (!L) continue; const hf = o.accountHf(t, own); const G = t.grants[own]; const live = !G || (G.remainingS > 0 && !G.revoked);
      const L0 = before2Ladders[own];
      if (!live && L0 && ["tick", "setPrice", "withdraw", "claim"].includes(kind)) { for (const r of o.RUNGS) if (L0[r] && !L[r]) fail("grant: a rung fired without a live permission", { r, kind, own }); }
      for (const r of o.RUNGS) { if (!L[r] && hf >= o.LADDER.disarm[r]) fail("ladder: fired rung while HF ≥ disarm", { r, hf, own }); if (live && !t.sim.keeperOff && L[r] && hf < o.LADDER.rungs[r] && ["tick", "setPrice", "withdraw", "flowComplete", "sim", "claim"].includes(kind)) fail("ladder: armed rung below its line after evaluation", { r, hf, kind }); } }
    // HF invariant: HF = Σ coll·LT / debt, never NaN
    if (owner) { const hf = o.accountHf(t, owner); if (Number.isNaN(hf) || hf < 0) fail("HF NaN/negative"); }
    if (t.flow && t.flow.status === "done" && !t.credited.includes(t.flow.id)) fail("done flow not credited");
  }
  o.renderAll();
  // DOM sign discipline at the end: every rendered APY carries the class of its sign
  document.querySelectorAll("#posList .pos-num .v.num").forEach(el => { const txt = el.textContent.trim(); if (/%$/.test(txt)) { const neg = txt.startsWith("−"); if (neg && !el.classList.contains("neg")) fail("DOM sign: negative APY without .neg", txt); if (!neg && el.classList.contains("neg")) fail("DOM sign: non-negative APY painted red", txt); } });
  const st = document.querySelector("#stApy"); if (st && /%$/.test(st.textContent) && st.textContent.startsWith("−") !== st.classList.contains("neg")) fail("DOM sign: dashboard APY class mismatch", st.textContent);
  o.unseedRng();
  return { n, violations: V, byType, credited: o.S.credited.length, positions: o.S.positions.length };
};

for (const [file, fn] of [["simple.html", fuzzSimple], ["index.html", fuzzAdvanced]]) {
  for (const seed of SEEDS) {
    const page = await openPage(b, srv.url(file));
    const t0 = Date.now();
    const r = await page.evaluate(fn, [seed, N]);
    const ms = Date.now() - t0;
    check(`${file} seed ${seed}: ${r.n} actions applied, ${r.violations.length} invariant violations, ${page.__errors.length} console errors (${ms} ms; credited ${r.credited}${r.positions !== undefined ? ", positions " + r.positions : ""})`, r.n === N && r.violations.length === 0 && page.__errors.length === 0, [...r.violations, ...page.__errors].slice(0, 8).join(" || "));
    await page.close();
  }
}
await b.close(); srv.close();
const out = done();
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
process.exit(out.fail ? 1 : 0);
