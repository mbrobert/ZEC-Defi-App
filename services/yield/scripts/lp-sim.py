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
  --as-of    the instant the gate is evaluated at (ISO or unix seconds)
  --borrow   Aave USDC variable borrow APR (%), read live — NOT a default
  --supply   per-collateral Aave supply APR (%),  e.g. cbBTC=0.012,WETH=1.843
  --lt       per-collateral liquidation threshold (bps), e.g. cbBTC=7800,WETH=8300

TWO NUMBERS PER CELL, AND THE GATE NEEDS BOTH (audit wave 1, lens D HIGH-1).

  closed form (src/model.ts)   lpNet = (1 − e^−x)(r/x − 1)
  MC-calibrated form           mcLpNet = net · inRangeEmissionsFactor + mcDragPct

The closed form is correct algebra for a position that is ALWAYS in range; it
ignores time out of range and the swap cost of every re-centre, so it is
optimistic, and the error grows with the emissions level — which makes it
smallest in today's deeply-negative cells and LARGEST exactly at the boundary
where the gate flips. Measured at the boundary: 7.4 pt (300 bps, σ 0.40) to
32.1 pt (150 bps, σ 0.33), both wider than the borrow rate being tested. The
gate therefore requires BOTH forms to clear the borrow and refuses inside the
band where they disagree (`within_model_uncertainty`).

The MC-calibrated form is EXACT in the emissions dimension, not a fit: in the
simulation emissions accrue as Σ_t 1{in range}·r/H·mintValue_t and neither the
indicator nor the mint value depends on r, so MC lpNet is affine in the net
emissions rate. One calibration run per pool × setting therefore prices the
cell at EVERY emissions level, including the boundary no committed validation
row has ever sat on. `--calibration` writes those two coefficients per cell for
the serving path (services/yield/src/mc-calibration.ts).

EPOCH. `epochActive` is DERIVED from `periodFinish > --as-of`, exactly as
`src/gate.ts` and `src/server.ts` derive it at serve time. It is never read
from the sample's recorded boolean: the committed sample records
`epochActive: true` with `periodFinish` 2026-09-03, and trusting it published
78 cells across 15 of 27 rows that the shipped gate answers `no_emissions`
(lens D MED-1). A run whose `--as-of` falls outside the epoch of a pool the
sample recorded as active is a hard failure, not a silent table of zeros.
"""
import argparse, datetime, json, math, sys, zlib

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--sample", required=True)
ap.add_argument("--vol", required=True)
ap.add_argument("--inputs", required=True)
ap.add_argument(
    "--as-of",
    required=True,
    help="the instant the gate is evaluated at (ISO-8601 or unix seconds) — epochActive is derived from it",
)
ap.add_argument("--borrow", type=float, required=True, help="Aave USDC variable borrow APR, percent, read live")
ap.add_argument("--borrow-source", required=True, help="where/when the borrow rate was read")
ap.add_argument("--supply", required=True, help="collateral=supplyAprPct,... (Aave, read live)")
ap.add_argument("--lt", required=True, help="collateral=liquidationThresholdBps,... (Aave, read live)")
ap.add_argument("--paths", type=int, default=6000)
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--out", required=True)
ap.add_argument("--md", default=None)
ap.add_argument("--calibration", default=None, help="write the per-cell MC calibration the serving path loads")
ap.add_argument(
    "--allow-lapsed-epoch",
    action="store_true",
    help="publish zeros instead of failing when --as-of is outside a recorded-active epoch",
)
args = ap.parse_args()


def parse_as_of(raw):
    """ISO-8601 (with or without Z) or unix seconds → unix seconds (int)."""
    try:
        return int(raw)
    except ValueError:
        pass
    txt = raw.strip().replace("Z", "+00:00")
    dt = datetime.datetime.fromisoformat(txt)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp())


SAMPLE = json.load(open(args.sample))
VOLF = json.load(open(args.vol))
INP = json.load(open(args.inputs))
VOL = {k: v["sigma"] for k, v in VOLF["pools"].items()}
SUPPLY = {k: float(v) for k, v in (kv.split("=") for kv in args.supply.split(","))}
LT = {k: int(v) for k, v in (kv.split("=") for kv in args.lt.split(","))}
COLLATERAL = list(SUPPLY)
assert set(COLLATERAL) == set(LT), "supply and lt must name the same collateral set"
BORROW = args.borrow
AS_OF = parse_as_of(args.as_of)
AS_OF_ISO = datetime.datetime.fromtimestamp(AS_OF, datetime.timezone.utc).isoformat()
SAMPLED_AT = parse_as_of(SAMPLE["sampledAt"])
if AS_OF < SAMPLED_AT:
    print(
        f"--as-of {AS_OF_ISO} precedes the gauge sample ({SAMPLE['sampledAt']}): "
        "the gate cannot be evaluated before its own inputs exist",
        file=sys.stderr,
    )
    sys.exit(2)
H = 8760
YEAR = 31_536_000

keep_engine = (1 - INP["fees"]["engineFeeBps"] / 10_000) * (1 - INP["fees"]["performanceBps"] / 10_000)
keep_direct = 1 - INP["fees"]["performanceBps"] / 10_000
SLIPPAGE = 0.0005  # extra cost on the swapped half at a rebalance

# ── validation tolerances ──────────────────────────────────────────────────
# The closed form's DECLARED accuracy may never reach the borrow rate its
# verdict is compared against. It used to: ±8.0 pt at AGGRESSIVE against a
# 4.828 % borrow (lens D HIGH-1), so the model's own admitted error was wider
# than the decision it was validating. The ceilings below are now capped by a
# fraction of the live borrow rate, so the bound tightens automatically when
# the rate falls and can never again exceed it.
TOLERANCE_CEILING_PCT = {"AGGRESSIVE": 4.75, "MODERATE": 2.5, "CONSERVATIVE": 2.5}
GAP_MAX_FRACTION_OF_BORROW = 0.98
# The affine calibration is exact, not fitted: a direct MC at the cell's real
# emissions level must equal net·ρ + drag to floating-point.
AFFINE_TOLERANCE_PCT = 0.01


def tolerance_for(preset):
    return min(TOLERANCE_CEILING_PCT[preset], BORROW * GAP_MAX_FRACTION_OF_BORROW)


def keep_for(protocol):
    return keep_direct if protocol == "DIRECT" else keep_engine


def half_width(bps):  # audit FACT 3 — exact, never bps/200
    return math.exp(bps * math.log(1.0001) / 2) - 1


def f_width(w):  # value per unit liquidity per sqrt(P) for a centered ±w range
    return 2 - math.sqrt(1 - w) - 1 / math.sqrt(1 + w)


def max_offered_ltv_bps(lt_bps):  # mirrors @zyo/shared maxOfferedLtvBps (integer math): floor(LT / floor), no product cap (removed 2026-09-12)
    floor_h = round(INP["ltv"]["entryHfFloor"] * 100)
    return (lt_bps * 100) // floor_h


def ltv_presets(lt_bps):
    top = max_offered_ltv_bps(lt_bps)
    fixed = INP["ltv"]["fixedBps"]
    return [("p30", fixed["p30"], fixed["p30"] <= top), ("p40", fixed["p40"], fixed["p40"] <= top), ("top", top, top > 0)]


def round2(x):
    """The service rounds every published APR to 2 dp (model.ts round2)."""
    return round(x * 100) / 100


def apr_at_width(s, w):
    """Gross in-range emissions APR (%) from raw chain words — same formula as
    sources/gauges.ts, INCLUDING its 2-dp rounding.

    `sources/gauges.ts` stores `round2(apr)` in `aprByWidthPct` and the gate
    multiplies THAT by the keep factor, so a sim computing at full precision
    lands up to 0.01 pt away from what the service actually serves (audit
    wave 1, lens D INFO-1 — net 5.84 vs 5.83, lpNet −21.85 vs −21.86). Round
    here and the two agree exactly, on every cell, forever."""
    rr = int(s["rewardRateWeiPerSec"])
    if rr == 0:
        return 0.0
    staked = int(s["stakedLiquidity"]) if s.get("stakedLiquidity") not in (None, "") else 0
    if staked == 0:
        return None
    usd_per_year = rr / 1e18 * YEAR * SAMPLE["aeroUsd"]
    sqrt_p = int(s["sqrtPriceX96"]) / 2**96
    v_staked = staked * sqrt_p * f_width(w) / 10 ** s["dec1"] * s["token1Usd"]
    return round2(usd_per_year / v_staked * 100)


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


def net_at_closed_form_boundary(sigma, w, target_pct):
    """The net emissions rate at which the CLOSED form lands exactly on `target_pct`."""
    x = sigma * sigma / (4 * f_width(w))
    e = 1 - math.exp(-x)
    return (target_pct / e + 100) * x


# ── Monte Carlo ────────────────────────────────────────────────────────────
def cell_seed(pool_id, setting_id):
    """Deterministic per-cell seed: a cell's numbers must not depend on which
    other cells ran before it (the shared generator made every published MC
    figure a function of the iteration order)."""
    return (args.seed * 1_000_003 + zlib.crc32(f"{pool_id}|{setting_id}".encode())) % (2**32)


def simulate(sigma, w, delay_h, apr_in_range_pct, fee_bps, seed):
    dt = 1 / H
    rng = np.random.default_rng(seed)
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
    # The value-weighted in-range fraction: Σ_t 1{in range}·mintValue_t / H.
    # Emissions at ANY rate r are exactly r × this, which is what makes the
    # two-coefficient calibration exact rather than fitted.
    in_range_value = np.zeros(args.paths)
    mint_value = np.full(args.paths, V0)
    cost = (fee_bps / 10_000 + SLIPPAGE) * 0.5
    for t in range(H):
        p = P[:, t]
        inr = (p >= pa) & (p <= pb)
        in_range_h += inr
        in_range_value += np.where(inr, mint_value / H, 0.0)
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
        "inRangeEmissionsFactor": float(in_range_value.mean()),
        "dragPct": {"mean": float(drag.mean() * 100), "p10": float(np.percentile(drag, 10) * 100), "p90": float(np.percentile(drag, 90) * 100)},
        "emissionsGrossPct": float(emissions.mean() * 100),
    }


def mc_lp_net(cal, net_pct):
    """The MC-calibrated LP outcome at ANY net emissions rate (affine, exact)."""
    return net_pct * cal["inRangeEmissionsFactor"] + cal["mcDragPct"]


# ── run ────────────────────────────────────────────────────────────────────
settings = INP["settings"]
out = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "inputs": {
        "asOf": AS_OF_ISO,
        "gaugeSample": {"file": args.sample, "sampledAt": SAMPLE["sampledAt"], "block": SAMPLE.get("block"), "aeroUsd": SAMPLE["aeroUsd"]},
        "volatility": {"file": args.vol, "asOf": VOLF["asOf"], "sigma": VOL, "provenance": {k: v["provenance"] for k, v in VOLF["pools"].items()}, "notCalibrated": VOLF.get("notCalibrated", {})},
        "borrowAprPct": BORROW, "borrowSource": args.borrow_source,
        "collateral": {c: {"supplyAprPct": SUPPLY[c], "liquidationThresholdBps": LT[c], "ltvPresets": [{"id": i, "ltvBps": b, "offerable": o} for i, b, o in ltv_presets(LT[c])]} for c in COLLATERAL},
        "fees": INP["fees"], "keep": {"engine": keep_engine, "direct": keep_direct},
        "settings": settings, "paths": args.paths, "stepHours": 1, "horizonDays": 365, "seed": args.seed, "drift": 0,
        "rebalance": "re-center at current price with the same width after the position has been out of range for the full rebalance delay; cost = (pool fee + 5 bps slippage) on the swapped half",
        "emissions": "in-range emissions APR at the position's exact width from the raw gauge words; paid only while in range on the position's current value; AERO sold on claim",
        "widthConvention": "rangeWidthBps is the TOTAL tick span; half-width w = 1.0001^(bps/2) - 1 (audit FACT 3)",
        "epochDerivation": "epochActive = rewardRate > 0 AND periodFinish > --as-of (identical to src/gate.ts); the sample's recorded boolean is never trusted",
        "closedForm": "x = sigma^2/(4 f(w)); drag = -100(1-e^-x); realized = r(1-e^-x)/x; lpNet = (1-e^-x)(r/x - 1)",
        "mcCalibratedForm": "mcLpNet = net * inRangeEmissionsFactor + mcDragPct (affine in net, exact); gate: lpNet > borrow AND mcLpNet > borrow",
        "tolerances": {"ceilingPct": TOLERANCE_CEILING_PCT, "maxFractionOfBorrow": GAP_MAX_FRACTION_OF_BORROW,
                       "effectivePct": {k: tolerance_for(k) for k in TOLERANCE_CEILING_PCT}, "affinePct": AFFINE_TOLERANCE_PCT},
    },
    "results": {},
    "validation": [],
    "boundaryGuard": [],
    "calibration": [],
    "verdict": {"clears": [], "fails": [], "notEvaluated": []},
}

for preset, tol in ((k, tolerance_for(k)) for k in TOLERANCE_CEILING_PCT):
    if not tol < BORROW:
        print(f"tolerance for {preset} is {tol} ≥ the {BORROW}% borrow rate it validates", file=sys.stderr)
        sys.exit(2)

hdr = (
    f"{'pool':18}{'setting':10}{'bps':>5}{'±w%':>7}{'delay':>6}{'apr%':>8}{'net%':>8}{'realz%':>8}"
    f"{'drag%':>8}{'lpNet%':>8}{'mcLpNet%':>10} TIR   Δ    | gate"
)
print(hdr)
fail = False
lapsed = []
for pid, s in SAMPLE["pools"].items():
    meta = INP["pools"].get(pid)
    if not meta:
        out["verdict"]["notEvaluated"].append({"pool": pid, "reason": "not in the curated Aerodrome list"})
        continue
    protocol = s.get("protocol", meta["protocol"]); pair_class = s.get("pairClass", meta["pairClass"])
    keep = keep_for(protocol)
    reward_rate = int(s["rewardRateWeiPerSec"])
    period_finish = int(s.get("periodFinish") or 0)
    # DERIVED, exactly as src/gate.ts derives it — never s["epochActive"].
    epoch_active = reward_rate > 0 and period_finish > AS_OF
    if bool(s.get("epochActive")) and not epoch_active and reward_rate > 0:
        lapsed.append({"pool": pid, "periodFinish": period_finish, "asOf": AS_OF})
    sigma = VOL.get(pid)
    fee_bps = s["feeBpsLive"]
    for st in settings:
        bps = st["rangeWidthBps"][pair_class]; w = half_width(bps); delay = st["rebalanceDelayHours"]
        cell = {"rangeWidthBps": bps, "halfWidth": w, "rebalanceDelayHours": delay, "preset": st["preset"],
                "protocol": protocol, "pairClass": pair_class, "keep": keep, "feeBpsLive": fee_bps,
                "epochActive": epoch_active, "periodFinish": period_finish}

        # ---- the MC calibration: one run per cell, emissions-independent, so
        #      it prices the cell at EVERY emissions level (including the
        #      boundary). Computed whenever a σ exists, regardless of whether
        #      the cell clears today — the serving path needs it either way.
        cal = None
        if sigma is not None:
            probe = simulate(sigma, w, delay, 1.0, fee_bps, cell_seed(pid, st["id"]))
            cal = {
                "poolId": pid, "setting": st["id"], "rangeWidthBps": bps, "rebalanceDelayHours": delay,
                "sigma": sigma, "feeBps": fee_bps,
                "inRangeEmissionsFactor": probe["inRangeEmissionsFactor"],
                "mcDragPct": probe["dragPct"]["mean"],
                "timeInRange": probe["timeInRange"], "rebalancesPerYear": probe["rebalancesPerYear"],
            }
            # The factor multiplies the NET rate, so it carries NO keep factor
            # of its own — folding one in here double-charges both fees and was
            # worth up to 13 pt at the Aggressive cbBTC cell. The probe runs at
            # apr = 1, so its own gross emissions ARE the factor: that identity
            # is the linearity the whole calibration rests on.
            assert abs(probe["emissionsGrossPct"] - probe["inRangeEmissionsFactor"] * 1.0) < 1e-9
            out["calibration"].append(cal)

        apr = apr_at_width(s, w) if epoch_active else 0.0
        if apr is None:
            cell.update({"reason": "no_staked_liquidity"}); out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["notEvaluated"].append({"pool": pid, "setting": st["id"], "reason": "no_staked_liquidity"}); continue
        net = apr * keep
        cell.update({"emissionsGrossPct": apr, "emissionsNetPct": net})
        if not epoch_active:
            # The marginal APR the same words would give if the gauge were voted again: never served
            # (the epoch is lapsed) but kept for the prototypes' "re-vote" lever, which shows the
            # plausibility ceiling refusing exactly this reading (slice K, 2026-09-12).
            revoted = apr_at_width(s, w) if reward_rate > 0 else None
            cell.update({"reason": "no_emissions", "emissionsGrossPct": 0.0, "emissionsNetPct": 0.0,
                         "emissionsIfRevotedGrossPct": revoted,
                         "lpNetPct": None, "mcLpNetPct": None, "qualifies": False})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["fails"].append({"pool": pid, "setting": st["id"], "reason": "no_emissions"})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{0:8.2f}{0:8.2f}{'':8}{'':8}{'':8}{'':10}      | no_emissions (rewardRate 0 / periodFinish ≤ as-of)")
            continue
        if not net > BORROW:
            # The GATE returns before computing any of the model fields on this
            # branch, so the sim must too — publishing an lpNet ladder for a
            # cell the gate will not price is what put 24 numbers on refused
            # demo cells that live mode leaves null (lens D MED-7).
            cell.update({"reason": "emissions_below_borrow", "lpNetPct": None, "mcLpNetPct": None, "qualifies": False,
                         "sigma": sigma, "wouldNeedEmissionsMultiple": break_even_multiple(net, BORROW, sigma, w) if sigma is not None else None})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["fails"].append({"pool": pid, "setting": st["id"], "reason": "emissions_below_borrow", "emissionsNetPct": net})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{'':8}{'':8}{'':8}{'':10}      | emissions_below_borrow ({net:.2f} ≤ {BORROW})")
            continue
        if sigma is None:
            cell.update({"reason": "no_volatility_input", "lpNetPct": None, "mcLpNetPct": None, "qualifies": False,
                         "wouldClearBelowSigma": break_even_sigma(net, BORROW, w)})
            out["results"].setdefault(pid, {})[st["id"]] = cell
            out["verdict"]["notEvaluated"].append({"pool": pid, "setting": st["id"], "reason": "no_volatility_input", "emissionsNetPct": net, "wouldClearBelowSigma": cell["wouldClearBelowSigma"]})
            print(f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{'':8}{'':8}{'':8}{'':10}      | no_volatility_input (clears only if σ < {cell['wouldClearBelowSigma']:.2f})")
            continue

        cf = closed_form(net, sigma, w)
        mc_net = mc_lp_net(cal, net)
        # The served verdict needs BOTH forms; the closed form alone would
        # offer a pool the Monte Carlo says loses money at the boundary.
        closed_clears = cf["lpNetPct"] > BORROW
        mc_clears = mc_net > BORROW
        qualifies = closed_clears and mc_clears
        reason = None if qualifies else ("within_model_uncertainty" if closed_clears else "net_below_borrow")
        cell.update({"sigma": sigma, **cf, "mcLpNetPct": mc_net, "qualifies": qualifies, "reason": reason,
                     "breakEvenSigma": break_even_sigma(net, BORROW, w), "breakEvenEmissionsMultiple": break_even_multiple(net, BORROW, sigma, w),
                     "monteCarlo": {"timeInRange": cal["timeInRange"], "rebalancesPerYear": cal["rebalancesPerYear"],
                                    "inRangeEmissionsFactor": cal["inRangeEmissionsFactor"], "dragPct": cal["mcDragPct"],
                                    "emissionsNetPct": net * cal["inRangeEmissionsFactor"], "lpNetPct": mc_net, "qualifies": mc_clears},
                     "userNet": {c: {i: {"ltvBps": b, "offerable": o, "userNetPct": SUPPLY[c] + b / 10_000 * (cf["lpNetPct"] - BORROW)} for i, b, o in ltv_presets(LT[c])} for c in COLLATERAL}})

        # ---- validation 1: the affine calibration is EXACT, not fitted.
        direct = simulate(sigma, w, delay, apr, fee_bps, cell_seed(pid, st["id"]))
        direct_net = direct["emissionsGrossPct"] * keep + direct["dragPct"]["mean"]
        affine_err = abs(direct_net - mc_net)
        # ---- validation 2: the closed form's disclosed error must stay under
        #      a bound that is itself under the borrow rate it decides against.
        delta = cf["lpNetPct"] - mc_net
        tol = tolerance_for(st["preset"])
        # ---- validation 3: the served gate is never MORE permissive than the MC.
        never_permissive = (not qualifies) or mc_clears
        ok = affine_err <= AFFINE_TOLERANCE_PCT and abs(delta) <= tol and never_permissive
        out["validation"].append({"pool": pid, "setting": st["id"], "closedFormLpNetPct": cf["lpNetPct"],
                                  "mcLpNetPct": mc_net, "directMcLpNetPct": direct_net, "affineErrorPct": affine_err,
                                  "deltaPct": delta, "tolerancePct": tol, "neverMorePermissiveThanMc": never_permissive, "ok": ok})

        # ---- the boundary guard, at the level where the gate actually flips.
        net_b = net_at_closed_form_boundary(sigma, w, BORROW)
        mc_b = mc_lp_net(cal, net_b)
        # By construction the closed form lands exactly on the borrow at net_b,
        # so the OLD gate (`lpNet > borrow` alone) sat on the knife edge there
        # and offered at any emissions a hair above it. The served gate offers
        # only if the MC-calibrated form clears too.
        offered_by_closed_alone = True
        offered_by_served_gate = mc_b > BORROW
        boundary_gap = BORROW - mc_b
        out["boundaryGuard"].append({
            "pool": pid, "setting": st["id"], "netEmissionsAtBoundaryPct": net_b,
            "grossEmissionsAtBoundaryPct": net_b / keep, "closedFormLpNetPct": BORROW, "mcLpNetPct": mc_b,
            "optimismPct": boundary_gap, "offeredByClosedFormAlone": offered_by_closed_alone,
            "offeredByServedGate": offered_by_served_gate,
            "guardBites": (not offered_by_served_gate) or boundary_gap <= 0,
        })
        if not ok:
            fail = True
        out["results"].setdefault(pid, {})[st["id"]] = cell
        (out["verdict"]["clears"] if qualifies else out["verdict"]["fails"]).append({"pool": pid, "setting": st["id"], "lpNetPct": cf["lpNetPct"], "mcLpNetPct": mc_net, "reason": reason})
        print(
            f"{pid:18}{st['id']:10}{bps:5d}{w*100:7.2f}{delay:6d}{apr:8.2f}{net:8.2f}{cf['emissionsRealizedPct']:8.2f}"
            f"{cf['dragPct']:8.2f}{cf['lpNetPct']:8.2f}{mc_net:10.2f} {cal['timeInRange']:4.2f} {delta:+5.1f} | "
            f"{'CLEARS' if qualifies else reason}{'' if ok else '  !! VALIDATION'}"
        )

if lapsed and not args.allow_lapsed_epoch:
    for l in lapsed:
        pf = datetime.datetime.fromtimestamp(l["periodFinish"], datetime.timezone.utc).isoformat()
        print(f"EPOCH LAPSED: {l['pool']} periodFinish {pf} ≤ --as-of {AS_OF_ISO} (sample records epochActive:true)", file=sys.stderr)
    print(
        "the shipped gate answers no_emissions for these pools at this instant; re-sample the gauges, "
        "or pass --allow-lapsed-epoch to publish the zeros deliberately",
        file=sys.stderr,
    )
    sys.exit(3)
out["inputs"]["epochLapsedAtAsOf"] = lapsed

json.dump(out, open(args.out, "w"), indent=1)
print(f"→ {args.out}")

if args.calibration:
    cal_doc = {
        "generatedAt": out["generatedAt"],
        "method": (
            "Per pool × setting Monte Carlo of the served position (scripts/lp-sim.py): zero-drift GBM at the "
            "pool's σ, hourly, one year, re-centred after the preset's rebalance delay with (pool fee + 5 bps "
            "slippage) charged on the swapped half. mcLpNet = emissionsNetPct × inRangeEmissionsFactor + "
            "mcDragPct — affine in the emissions rate because neither the in-range indicator nor the mint value "
            "depends on it, so these two coefficients price the cell at every emissions level."
        ),
        "asOf": AS_OF_ISO,
        "paths": args.paths,
        "seed": args.seed,
        "cells": out["calibration"],
    }
    json.dump(cal_doc, open(args.calibration, "w"), indent=1)
    print(f"→ {args.calibration}")

# ── markdown ───────────────────────────────────────────────────────────────
if args.md:
    L = []
    L.append("# MODEL-NUMBERS — Base-first yield gate, generated " + out["generatedAt"])
    L.append("")
    L.append("Generated by `services/yield/scripts/lp-sim.py` from one recorded input set. **The web pins to the closed-form columns** (`lpNet`, what `/v1/gate` publishes as the headline); the **MC-calibrated column is what the gate DECIDES on** alongside it. Every number below is computed — nothing typed.")
    L.append("")
    L.append("## Inputs (with provenance)")
    L.append("")
    L.append(f"- **Gate evaluated as of: {AS_OF_ISO}** — `epochActive` is derived from `periodFinish > as-of`, identically to `src/gate.ts`; the sample's recorded boolean is never trusted.")
    L.append(f"- **USDC variable borrow APR: {BORROW}%** — {args.borrow_source}")
    for c in COLLATERAL:
        pres = ", ".join(f"{i}={b/100:g}%{'' if o else ' (not offerable)'}" for i, b, o in ltv_presets(LT[c]))
        L.append(f"- **{c}**: Aave supply APR {SUPPLY[c]}%, liquidation threshold {LT[c]/100:.2f}% → LTV presets {pres} (top = floor(LT/{INP['ltv']['entryHfFloor']}), no product cap)")
    L.append(f"- Gauge words: `{args.sample}` sampled {SAMPLE['sampledAt']} (block {SAMPLE.get('block')}), AERO ${SAMPLE['aeroUsd']:.4f}")
    L.append(f"- Volatility: `{args.vol}` as of {VOLF['asOf']}: " + ", ".join(f"{k} σ={v}" for k, v in VOL.items()))
    L.append(f"- Fees: engine {INP['fees']['engineFeeBps']/100:.0f}% then Oilskin {INP['fees']['performanceBps']/100:.0f}% on emissions only → keep {keep_engine:.4f} (engine pools), {keep_direct:.2f} (DIRECT)")
    L.append("- Widths (TOTAL tick span → exact ±): " + "; ".join(f"{st['id']}/{st['preset']} {st['rangeWidthBps']['UNCORRELATED']}→±{half_width(st['rangeWidthBps']['UNCORRELATED'])*100:.2f}% (correlated {st['rangeWidthBps']['CORRELATED']}→±{half_width(st['rangeWidthBps']['CORRELATED'])*100:.2f}%), delay {st['rebalanceDelayHours']}h" for st in settings))
    L.append(f"- Monte Carlo: {args.paths} paths × 1 year, hourly, zero-drift GBM, per-cell seed derived from {args.seed}")
    L.append("")
    L.append("Closed form: `x = σ²/(4·f(w))`, `f(w) = 2 − √(1−w) − 1/√(1+w)`, `drag = −100(1−e^−x)`, `realized = r(1−e^−x)/x`, **`lpNet = (1−e^−x)(r/x − 1)`**.")
    L.append("")
    L.append("MC-calibrated form: **`mcLpNet = net × inRangeEmissionsFactor + mcDragPct`** — affine in the emissions rate, so two coefficients price the cell at every emissions level.")
    L.append("")
    L.append("**Gate ⇔ `lpNet > borrow` AND `mcLpNet > borrow`.** `userNet = supply + LTV × (lpNet − borrow)`.")
    L.append("")
    L.append("## Verdict at " + f"{BORROW}% borrow")
    L.append("")
    if out["verdict"]["clears"]:
        L.append("**Clears the gate:** " + ", ".join(f"{c['pool']} / {c['setting']} (lpNet {c['lpNetPct']:+.2f}%, mcLpNet {c['mcLpNetPct']:+.2f}%)" for c in out["verdict"]["clears"]))
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
            be = c.get("wouldClearBelowSigma")
            return "%s/%s%s" % (c["pool"], c.get("setting", "*"), (" — would clear only if σ < %.2f" % be) if be else "")
        L.append("Not evaluated (no σ calibrated; the gate refuses these with `no_volatility_input`): " + "; ".join(ne_txt(c) for c in out["verdict"]["notEvaluated"]))
        L.append("")
    L.append("## Per pool × setting (LP slice, before the borrow)")
    L.append("")
    L.append("| pool | setting | width | delay | gross emissions APR(w) | net (×keep) | realized | drag | **lpNet (published)** | **mcLpNet (decides)** | MC time-in-range | Δ closed−MC | gate |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for pid, per in out["results"].items():
        for sid, c in per.items():
            width = f"{c['rangeWidthBps']} (±{c['halfWidth']*100:.2f}%)"
            mc = c.get("monteCarlo")
            if c.get("lpNetPct") is None:
                L.append(f"| {pid} | {sid} | {width} | {c['rebalanceDelayHours']}h | {c.get('emissionsGrossPct', 0):.2f}% | {c.get('emissionsNetPct', 0):.2f}% | — | — | — | — | — | — | {c['reason']} |")
            else:
                L.append(f"| {pid} | {sid} | {width} | {c['rebalanceDelayHours']}h | {c['emissionsGrossPct']:.2f}% | {c['emissionsNetPct']:.2f}% | {c['emissionsRealizedPct']:.2f}% | {c['dragPct']:.2f}% | **{c['lpNetPct']:+.2f}%** | **{c['mcLpNetPct']:+.2f}%** | {mc['timeInRange']*100:.0f}% | {c['lpNetPct']-c['mcLpNetPct']:+.1f} | {'**CLEARS**' if c['qualifies'] else c['reason']} |")
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
                    L.append(f"| {pid} | {sid} | {col} | {u['ltvBps']/100:g}% ({i}){'' if u['offerable'] else ' not offerable'} | {c['lpNetPct']:+.2f}% | {BORROW}% | {SUPPLY[col]}% | **{u['userNetPct']:+.2f}%** |")
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
    L.append("These multiples are the CLOSED FORM's break-even. The table below is what the same cell is worth at exactly that emissions level once time out of range is priced.")
    L.append("")
    L.append("## Boundary guard (why the gate needs both forms)")
    L.append("")
    L.append("At the emissions level where the closed form lands exactly on the borrow rate — the level the old gate flipped at — this is what the Monte-Carlo-calibrated form says the same position is worth:")
    L.append("")
    L.append("| pool | setting | gross emissions at the boundary | closed-form lpNet | mcLpNet | closed form is optimistic by | offered by the closed form alone | offered by the served gate |")
    L.append("|---|---|---|---|---|---|---|---|")
    for b in out["boundaryGuard"]:
        L.append(f"| {b['pool']} | {b['setting']} | {b['grossEmissionsAtBoundaryPct']:.2f}% | {b['closedFormLpNetPct']:+.2f}% | {b['mcLpNetPct']:+.2f}% | **{b['optimismPct']:+.2f} pt** | yes | {'yes' if b['offeredByServedGate'] else '**no — refused within_model_uncertainty**'} |")
    L.append("")
    L.append("## Validation")
    L.append("")
    L.append("| pool | setting | closed lpNet | mcLpNet (affine) | direct MC | affine error | Δ closed−MC | tolerance | never more permissive than MC | ok |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for v in out["validation"]:
        L.append(f"| {v['pool']} | {v['setting']} | {v['closedFormLpNetPct']:+.2f}% | {v['mcLpNetPct']:+.2f}% | {v['directMcLpNetPct']:+.2f}% | {v['affineErrorPct']:.2e} | {v['deltaPct']:+.2f} | ±{v['tolerancePct']:.3f} | {'yes' if v['neverMorePermissiveThanMc'] else 'NO'} | {'ok' if v['ok'] else 'FAIL'} |")
    L.append("")
    L.append(f"Tolerances are capped at {GAP_MAX_FRACTION_OF_BORROW:.2f}× the live borrow rate ({BORROW}%), so the closed form's declared error can never again exceed the rate its verdict is compared against; the affine-calibration error is held to {AFFINE_TOLERANCE_PCT} pt because that relationship is exact, not fitted.")
    L.append("")
    L.append("Caveats (attack here first): emissions are a snapshot of staked in-range liquidity at the sample block; σ is trailing-realized, zero-drift; the closed form ignores time out of range — the mcLpNet column prices it, and the gate refuses anything the two forms disagree about; the empirical backfill bands replace this model wherever real closed positions exist.")
    open(args.md, "w").write("\n".join(L) + "\n")
    print(f"→ {args.md}")

if fail:
    print("VALIDATION FAILED: see the validation table", file=sys.stderr)
    sys.exit(1)
