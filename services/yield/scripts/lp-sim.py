#!/usr/bin/env python3
"""Monte Carlo of a Snuggle-style concentrated LP with re-centering rebalances,
staked in an Aerodrome gauge (yield = AERO emissions only; trading fees go to
veAERO voters), re-run for the Base-first product against the LIVE Aave USDC
borrow rate and per-collateral Aave supply APRs.

Produces, per pool × setting × collateral × LTV: emissions, drag, lpNet,
userNet — from ONE set of recorded inputs, every one carried into the
output with its provenance:

  --sample   samples/gauge-emissions-<date>.json  raw gauge/pool words per pool
  --vol      samples/volatility.json              per-pool annualized σ (+ provenance)
  --inputs   samples/model-inputs.json            shared presets, fees, LTV constants
  --borrow   Aave USDC variable borrow APR (%), read live — NOT a default
  --supply   per-collateral Aave supply APR (%),  e.g. cbBTC=0.012,WETH=1.843
  --lt       per-collateral liquidation threshold (bps), e.g. cbBTC=7800,WETH=8300

The CLOSED FORM the service serves (src/model.ts) is computed per cell and
is what the web pins to; the Monte Carlo validates it (delta reported per
cell, run fails if any Conservative/Moderate cell drifts > 2.5 pt or any
Aggressive cell > 8 pt, or if any cell's gate VERDICT differs).
"""
import argparse, json, math, sys, datetime
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--sample", required=True)
ap.add_argument("--vol", required=True)
ap.add_argument("--inputs", required=True)
ap.add_argument("--borrow", type=float, required=True, help="Aave USDC variable borrow APR, percent, read live")
ap.add_argument("--borrow-source", required=True, help="where/when the borrow rate was read")
ap.add_argument("--supply", required=True, help="collateral=supplyAprPct,... (Aave, read live)")
ap.add_argument("--lt", required=True, help="collateral=liquidationThresholdBps,... (Aave, read live)")
ap.add_argument("--paths", type=int, default=3000)
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--out", required=True)
ap.add_argument("--md", default=None)
args = ap.parse_args()

SAMPLE = json.load(open(args.sample))
VOLF = json.load(open(args.vol))
INP = json.load(open(args.inputs))
VOL = {k: v["sigma"] for k, v in VOLF["pools"].items()}
SUPPLY = {k: float(v) for k, v in (kv.split("=") for kv in args.supply.split(","))}
LT = {k: int(v) for k, v in (kv.split("=") for kv in args.lt.split(","))}
COLLATERAL = list(SUPPLY)
assert set(COLLATERAL) == set(LT), "supply and lt must name the same collateral set"
BORROW = args.borrow
H = 8760
rng = np.random.default_rng(args.seed)
YEAR = 31_536_000

keep_engine = (1 - INP["fees"]["engineFeeBps"] / 10_000) * (1 - INP["fees"]["performanceBps"] / 10_000)
keep_direct = 1 - INP["fees"]["performanceBps"] / 10_000
SLIPPAGE = 0.0005  # extra cost on the swapped half at a rebalance


def keep_for(protocol):
    return keep_direct if protocol == "DIRECT" else keep_engine


def half_width(bps):  # audit FACT 3 — exact, never bps/200
    return math.exp(bps * math.log(1.0001) / 2) - 1


def f_width(w):  # value per unit liquidity per sqrt(P) for a centered ±w range
    return 2 - math.sqrt(1 - w) - 1 / math.sqrt(1 + w)


def max_offered_ltv_bps(lt_bps):  # mirrors @zyo/shared maxOfferedLtvBps (integer math)
    floor_h = round(INP["ltv"]["entryHfFloor"] * 100)
    return min(INP["ltv"]["maxOfferedLtvCapBps"], (lt_bps * 100) // floor_h)


def ltv_presets(lt_bps):
    top = max_offered_ltv_bps(lt_bps)
    fixed = INP["ltv"]["fixedBps"]
    return [("p30", fixed["p30"], fixed["p30"] <= top), ("p40", fixed["p40"], fixed["p40"] <= top), ("top", top, top > 0)]


def apr_at_width(s, w):
    """Gross in-range emissions APR (%) from raw chain words — same formula as sources/gauges.ts."""
    rr = int(s["rewardRateWeiPerSec"])
    if rr == 0:
        return 0.0
    staked = int(s["stakedLiquidity"]) if s.get("stakedLiquidity") not in (None, "") else 0
    if staked == 0:
        return None
    usd_per_year = rr / 1e18 * YEAR * SAMPLE["aeroUsd"]
    sqrt_p = int(s["sqrtPriceX96"]) / 2**96
    v_staked = staked * sqrt_p * f_width(w) / 10 ** s["dec1"] * s["token1Usd"]
    return usd_per_year / v_staked * 100


# ── closed form (src/model.ts) ─────────────────────────────────────────────
def closed_form(net_pct, sigma, w):
    x = sigma * sigma / (4 * f_width(w))
    drag = -100 * (1 - math.exp(-x))
    realized = net_pct if x == 0 else net_pct * (1 - math.exp(-x)) / x
    return {"dragRate": x, "dragPct": drag, "emissionsRealizedPct": realized, "lpNetPct": realized + drag}


def break_even_sigma(net_pct, borrow, w):
    if not net_pct > borrow:
        return None
    lo, hi = 0.0, 5.0
    if closed_form(net_pct, hi, w)["lpNetPct"] > borrow:
        return hi
    for _ in range(80):
        mid = (lo + hi) / 2
        if closed_form(net_pct, mid, w)["lpNetPct"] > borrow:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def break_even_multiple(net_pct, borrow, sigma, w):
    if not net_pct > 0:
        return None
    x = sigma * sigma / (4 * f_width(w))
    if x == 0:
        return borrow / net_pct
    return ((borrow / 100) / (1 - math.exp(-x)) + 1) * x / (net_pct / 100)


# ── Monte Carlo ────────────────────────────────────────────────────────────
def simulate(sigma, w, delay_h, apr_in_range_pct, fee_bps):
    dt = 1 / H
    z = rng.standard_normal((args.paths, H))
    logp = np.cumsum(-0.5 * sigma**2 * dt + sigma * math.sqrt(dt) * z, axis=1)
    P = np.exp(logp)
    V0 = 1.0
    pa = np.full(args.paths, 1 - w); pb = np.full(args.paths, 1 + w)
    sp = np.sqrt(np.ones(args.paths))
    L = np.full(args.paths, V0 / (sp * f_width(w)))
    x = L * (1 / sp - 1 / np.sqrt(pb)); y = L * (sp - np.sqrt(pa))
    hold_x = x.copy(); hold_y = y.copy()
    out_hours = np.zeros(args.paths); in_range_h = np.zeros(args.paths)
    rebalances = np.zeros(args.paths); emissions = np.zeros(args.paths)
    mint_value = np.full(args.paths, V0)
    cost = (fee_bps / 10_000 + SLIPPAGE) * 0.5
    for t in range(H):
        p = P[:, t]
        inr = (p >= pa) & (p <= pb)
        in_range_h += inr
        emissions += np.where(inr, apr_in_range_pct / 100 * mint_value / H, 0.0)
        out_hours = np.where(inr, 0.0, out_hours + 1)
        need = out_hours >= delay_h
        if need.any():
            idx = np.nonzero(need)[0]
            pp = p[idx]; spp = np.sqrt(pp)
            xa = np.where(pp <= pa[idx], L[idx] * (1 / np.sqrt(pa[idx]) - 1 / np.sqrt(pb[idx])), 0.0)
            ya = np.where(pp >= pb[idx], L[idx] * (np.sqrt(pb[idx]) - np.sqrt(pa[idx])), 0.0)
            V = (xa * pp + ya) * (1 - cost)
            pa[idx] = pp * (1 - w); pb[idx] = pp * (1 + w)
            L[idx] = V / (spp * f_width(w)); mint_value[idx] = V
            out_hours[idx] = 0; rebalances[idx] += 1
    p = P[:, -1]
    sp = np.sqrt(np.clip(p, pa, pb))
    lp_val = (L * (1 / sp - 1 / np.sqrt(pb))) * p + L * (sp - np.sqrt(pa))
    hodl_val = hold_x * p + hold_y
    drag = lp_val / hodl_val - 1
    return {
        "timeInRange": float(in_range_h.mean() / H),
        "rebalancesPerYear": float(rebalances.mean()),
        "dragPct": {"mean": float(drag.mean() * 100), "p10": float(np.percentile(drag, 10) * 100), "p90": float(np.percentile(drag, 90) * 100)},
        "emissionsGrossPct": float(emissions.mean() * 100),
    }


# ── run ────────────────────────────────────────────────────────────────────
settings = INP["settings"]
out = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "inputs": {
        "gaugeSample": {"file": args.sample, "sampledAt": SAMPLE["sampledAt"], "block": SAMPLE.get("block"), "aeroUsd": SAMPLE["aeroUsd"]},
        "volatility": {"file": args.vol, "asOf": VOLF["asOf"], "sigma": VOL, "provenance": {k: v["provenance"] for k, v in VOLF["pools"].items()}, "notCalibrated": VOLF.get("notCalibrated", {})},
        "borrowAprPct": BORROW, "borrowSource": args.borrow_source,
        "collateral": {c: {"supplyAprPct": SUPPLY[c], "liquidationThresholdBps": LT[c], "ltvPresets": [{"id": i, "ltvBps": b, "offerable": o} for i, b, o in ltv_presets(LT[c])]} for c in COLLATERAL},
        "fees": INP["fees"], "keep": {"engine": keep_engine, "direct": keep_direct},
        "settings": settings, "paths": args.paths, "stepHours": 1, "horizonDays": 365, "seed": args.seed, "drift": 0,
        "rebalance": "re-center at current price with the same width after the position has been out of range for the full rebalance delay; cost = (pool fee + 5 bps slippage) on the swapped half",
        "emissions": "in-range emissions APR at the position's exact width from the raw gauge words; paid only while in range on the position's current value; AERO sold on claim",
        "widthConvention": "rangeWidthBps is the TOTAL tick span; half-width w = 1.0001^(bps/2) - 1 (audit FACT 3)",
        "closedForm": "x = sigma^2/(4 f(w)); drag = -100(1-e^-x); realized = r(1-e^-x)/x; lpNet = (1-e^-x)(r/x - 1); gate: lpNet > borrow",
    },
    "results": {},
    "validation": [],
    "verdict": {"clears": [], "fails": [], "notEvaluated": []},
}

hdr = f"{'pool':18}{'setting':10}{'bps':>5}{'±w%':>7}{'delay':>6}{'apr%':>8}{'net%':>8}{'realz%':>8}{'drag%':>8}{'lpNet%':>8} | MC lpNet% TIR  Δ   | gate"
print(hdr)
fail = False
for pid, s in SAMPLE["pools"].items():
    meta = INP["pools"].get(pid)
    if not meta:
        out["verdict"]["notEvaluated"].append({"pool": pid, "reason": "not in the curated Aerodrome list"})
        continue
    protocol = s.get("protocol", meta["protocol"]); pair_class = s.get("pairClass", meta["pairClass"])
    keep = keep_for(protocol)
    epoch_active = bool(s.get("epochActive")) and int(s["rewardRateWeiPerSec"]) > 0
    sigma = VOL.get(pid)
    for st in settings:
        bps = st["rangeWidthBps"][pair_class]; w = half_width(bps); delay = st["rebalanceDelayHours"]
        cell = {"rangeWidthBps": bps, "halfWidth": w, "rebalanceDelayHours": delay, "preset": st["preset"], "protocol": protocol, "pairClass": pair_class, "keep": keep}
        apr = apr_at_width(s, w) if epoch_active else 0.0
        if apr is None:
            cell.update({"reason": "no_staked_liquidity"}); out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["notEvaluated"].append({"pool": pid, "setting": st["id"], "reason": "no_staked_liquidity"}); continue
        net = apr * keep
        cell.update({"emissionsGrossPct": apr, "emissionsNetPct": net})
        if not epoch_active:
            cell.update({"reason": "no_emissions", "lpNetPct": None, "qualifies": False})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["fails"].append({"pool": pid, "setting": st["id"], "reason": "no_emissions"})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{0:8.2f}{0:8.2f}{'':8}{'':8}{'':8} | {'':17} | no_emissions (gauge rewardRate 0 / epoch lapsed)")
            continue
        if not net > BORROW:
            cell.update({"reason": "emissions_below_borrow", "lpNetPct": None, "qualifies": False})
            if sigma is not None:
                cf = closed_form(net, sigma, w)
                cell.update({"sigma": sigma, **cf, "breakEvenSigma": None, "breakEvenEmissionsMultiple": break_even_multiple(net, BORROW, sigma, w),
                             "userNet": {c: {i: {"ltvBps": b, "offerable": o, "userNetPct": SUPPLY[c] + b / 10_000 * (cf["lpNetPct"] - BORROW)} for i, b, o in ltv_presets(LT[c])} for c in COLLATERAL}})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["fails"].append({"pool": pid, "setting": st["id"], "reason": "emissions_below_borrow", "emissionsNetPct": net})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{'':8}{'':8}{'':8} | {'':17} | emissions_below_borrow ({net:.2f} ≤ {BORROW})")
            continue
        if sigma is None:
            cell.update({"reason": "no_volatility_input", "lpNetPct": None, "qualifies": False,
                         "breakEvenSigma": break_even_sigma(net, BORROW, w)})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["notEvaluated"].append({"pool": pid, "setting": st["id"], "reason": "no_volatility_input", "emissionsNetPct": net, "breakEvenSigma": cell["breakEvenSigma"]})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{'':8}{'':8}{'':8} | {'':17} | no_volatility_input (clears only if σ < {cell['breakEvenSigma']:.2f})")
            continue
        cf = closed_form(net, sigma, w)
        mc = simulate(sigma, w, delay, apr, s["feeBpsLive"])
        mc_net = mc["emissionsGrossPct"] * keep + mc["dragPct"]["mean"]
        qualifies = cf["lpNetPct"] > BORROW
        cell.update({"sigma": sigma, **cf, "qualifies": qualifies, "reason": None if qualifies else "net_below_borrow",
                     "breakEvenSigma": break_even_sigma(net, BORROW, w), "breakEvenEmissionsMultiple": break_even_multiple(net, BORROW, sigma, w),
                     "monteCarlo": {**mc, "emissionsNetPct": mc["emissionsGrossPct"] * keep, "lpNetPct": mc_net, "qualifies": mc_net > BORROW},
                     "userNet": {c: {i: {"ltvBps": b, "offerable": o, "userNetPct": SUPPLY[c] + b / 10_000 * (cf["lpNetPct"] - BORROW)} for i, b, o in ltv_presets(LT[c])} for c in COLLATERAL}})
        delta = cf["lpNetPct"] - mc_net
        tol = 8.0 if st["preset"] == "AGGRESSIVE" else 2.5
        ok = abs(delta) <= tol and (qualifies == (mc_net > BORROW))
        out["validation"].append({"pool": pid, "setting": st["id"], "closedFormLpNetPct": cf["lpNetPct"], "monteCarloLpNetPct": mc_net, "deltaPct": delta, "tolerancePct": tol, "verdictAgrees": qualifies == (mc_net > BORROW), "ok": ok})
        if not ok:
            fail = True
        out["results"].setdefault(pid, {})[st["id"]] = cell
        (out["verdict"]["clears"] if qualifies else out["verdict"]["fails"]).append({"pool": pid, "setting": st["id"], "lpNetPct": cf["lpNetPct"], "reason": None if qualifies else "net_below_borrow"})
        print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{cf['emissionsRealizedPct']:8.2f}{cf['dragPct']:8.2f}{cf['lpNetPct']:8.2f} | {mc_net:9.2f} {mc['timeInRange']:4.2f} {delta:+5.1f} | {'CLEARS' if qualifies else 'net_below_borrow'}{'' if ok else '  !! VALIDATION'}")

json.dump(out, open(args.out, "w"), indent=1)
print(f"→ {args.out}")

# ── markdown ───────────────────────────────────────────────────────────────
if args.md:
    L = []
    L.append("# MODEL-NUMBERS — Base-first yield gate, generated " + out["generatedAt"])
    L.append("")
    L.append("Generated by `services/yield/scripts/lp-sim.py` from one recorded input set. **The web pins to the closed-form columns** (what `/v1/gate` serves live); the Monte Carlo column validates them. Every number below is computed — nothing typed.")
    L.append("")
    L.append("## Inputs (with provenance)")
    L.append("")
    L.append(f"- **USDC variable borrow APR: {BORROW}%** — {args.borrow_source}")
    for c in COLLATERAL:
        pres = ", ".join(f"{i}={b/100:.0f}%{'' if o else ' (not offerable)'}" for i, b, o in ltv_presets(LT[c]))
        L.append(f"- **{c}**: Aave supply APR {SUPPLY[c]}%, liquidation threshold {LT[c]/100:.2f}% → LTV presets {pres} (top = min(50%, floor(LT/{INP['ltv']['entryHfFloor']})))")
    L.append(f"- Gauge words: `{args.sample}` sampled {SAMPLE['sampledAt']} (block {SAMPLE.get('block')}), AERO ${SAMPLE['aeroUsd']:.4f}")
    L.append(f"- Volatility: `{args.vol}` as of {VOLF['asOf']}: " + ", ".join(f"{k} σ={v}" for k, v in VOL.items()))
    L.append(f"- Fees: engine {INP['fees']['engineFeeBps']/100:.0f}% then Oilskin {INP['fees']['performanceBps']/100:.0f}% on emissions only → keep {keep_engine:.4f} (engine pools), {keep_direct:.2f} (DIRECT)")
    L.append("- Widths (TOTAL tick span → exact ±): " + "; ".join(f"{st['id']}/{st['preset']} {st['rangeWidthBps']['UNCORRELATED']}→±{half_width(st['rangeWidthBps']['UNCORRELATED'])*100:.2f}% (correlated {st['rangeWidthBps']['CORRELATED']}→±{half_width(st['rangeWidthBps']['CORRELATED'])*100:.2f}%), delay {st['rebalanceDelayHours']}h" for st in settings))
    L.append(f"- Monte Carlo: {args.paths} paths × 1 year, hourly, zero-drift GBM, seed {args.seed}")
    L.append("")
    L.append("Model: `x = σ²/(4·f(w))`, `f(w) = 2 − √(1−w) − 1/√(1+w)`, `drag = −100(1−e^−x)`, `realized = r(1−e^−x)/x`, **`lpNet = (1−e^−x)(r/x − 1)`**, gate ⇔ `lpNet > borrow`, `userNet = supply + LTV × (lpNet − borrow)`.")
    L.append("")
    L.append("## Verdict at " + f"{BORROW}% borrow")
    L.append("")
    if out["verdict"]["clears"]:
        L.append("**Clears the gate:** " + ", ".join(f"{c['pool']} / {c['setting']} (lpNet {c['lpNetPct']:+.2f}%)" for c in out["verdict"]["clears"]))
    else:
        L.append("**No pool × setting clears the gate.** The menu is empty; the product offers hold-USDC / spot instead.")
    L.append("")
    def fail_txt(c):
        extra = "" if c.get("lpNetPct") is None else ", lpNet %+.2f%%" % c["lpNetPct"]
        return "%s/%s (%s%s)" % (c["pool"], c["setting"], c["reason"], extra)
    L.append("Fails: " + "; ".join(fail_txt(c) for c in out["verdict"]["fails"]))
    L.append("")
    if out["verdict"]["notEvaluated"]:
        def ne_txt(c):
            be = c.get("breakEvenSigma")
            return "%s/%s%s" % (c["pool"], c.get("setting", "*"), (" — would clear only if σ < %.2f" % be) if be else "")
        L.append("Not evaluated (no σ calibrated; the gate refuses these with `no_volatility_input`): " + "; ".join(ne_txt(c) for c in out["verdict"]["notEvaluated"]))
        L.append("")
    L.append("## Per pool × setting (LP slice, before the borrow)")
    L.append("")
    L.append("| pool | setting | width | delay | gross emissions APR(w) | net (×keep) | realized | drag | **lpNet (served)** | MC lpNet | MC time-in-range | Δ closed−MC | gate |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for pid, per in out["results"].items():
        for sid, c in per.items():
            width = f"{c['rangeWidthBps']} (±{c['halfWidth']*100:.2f}%)"
            mc = c.get("monteCarlo")
            if c.get("lpNetPct") is None:
                L.append(f"| {pid} | {sid} | {width} | {c['rebalanceDelayHours']}h | {c.get('emissionsGrossPct', 0):.2f}% | {c.get('emissionsNetPct', 0):.2f}% | — | — | — | — | — | — | {c['reason']} |")
            elif mc is None:
                L.append(f"| {pid} | {sid} | {width} | {c['rebalanceDelayHours']}h | {c['emissionsGrossPct']:.2f}% | {c['emissionsNetPct']:.2f}% | {c['emissionsRealizedPct']:.2f}% | {c['dragPct']:.2f}% | **{c['lpNetPct']:+.2f}%** | — | — | — | {c['reason']} |")
            else:
                L.append(f"| {pid} | {sid} | {width} | {c['rebalanceDelayHours']}h | {c['emissionsGrossPct']:.2f}% | {c['emissionsNetPct']:.2f}% | {c['emissionsRealizedPct']:.2f}% | {c['dragPct']:.2f}% | **{c['lpNetPct']:+.2f}%** | {mc['lpNetPct']:+.2f}% | {mc['timeInRange']*100:.0f}% | {c['lpNetPct']-mc['lpNetPct']:+.1f} | {'**CLEARS**' if c['qualifies'] else 'net_below_borrow'} |")
    L.append("")
    L.append("## User net per pool × setting × collateral × LTV (whole collateral position)")
    L.append("")
    L.append("| pool | setting | collateral | LTV | lpNet | borrow | supply | **userNet** |")
    L.append("|---|---|---|---|---|---|---|---|")
    for pid, per in out["results"].items():
        for sid, c in per.items():
            if c.get("lpNetPct") is None or not c.get("userNet"):
                continue
            for col, presets in c["userNet"].items():
                for i, u in presets.items():
                    L.append(f"| {pid} | {sid} | {col} | {u['ltvBps']/100:.0f}% ({i}){'' if u['offerable'] else ' not offerable'} | {c['lpNetPct']:+.2f}% | {BORROW}% | {SUPPLY[col]}% | **{u['userNetPct']:+.2f}%** |")
    L.append("")
    L.append("## What would flip the gate")
    L.append("")
    for pid, per in out["results"].items():
        for sid, c in per.items():
            if c.get("lpNetPct") is None or c.get("qualifies") or c.get("breakEvenEmissionsMultiple") is None:
                continue
            be = c.get("breakEvenSigma"); bem = c.get("breakEvenEmissionsMultiple")
            L.append(f"- {pid}/{sid}: needs **{bem:.2f}×** today's net emissions at σ={c['sigma']}, or σ ≤ **{be:.2f}** at today's emissions" if be is not None else f"- {pid}/{sid}: needs **{bem:.2f}×** today's net emissions (no σ clears at today's emissions)")
    L.append("")
    L.append("## Validation (closed form vs Monte Carlo)")
    L.append("")
    L.append("| pool | setting | closed-form lpNet | MC lpNet | Δ | tolerance | verdict agrees | ok |")
    L.append("|---|---|---|---|---|---|---|---|")
    for v in out["validation"]:
        L.append(f"| {v['pool']} | {v['setting']} | {v['closedFormLpNetPct']:+.2f}% | {v['monteCarloLpNetPct']:+.2f}% | {v['deltaPct']:+.2f} | ±{v['tolerancePct']} | {'yes' if v['verdictAgrees'] else 'NO'} | {'ok' if v['ok'] else 'FAIL'} |")
    L.append("")
    L.append("Caveats (attack here first): emissions are a snapshot of staked in-range liquidity at the sample block; σ is trailing-realized, zero-drift; the closed form ignores time out of range (the MC column includes it — Aggressive rows carry the largest gap); the empirical backfill bands replace this model wherever real closed positions exist.")
    open(args.md, "w").write("\n".join(L) + "\n")
    print(f"→ {args.md}")

if fail:
    print("VALIDATION FAILED: closed form and Monte Carlo disagree beyond tolerance", file=sys.stderr)
    sys.exit(1)
