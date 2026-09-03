#!/usr/bin/env python3
"""Monte Carlo of a Snuggle-style concentrated LP with re-centering rebalances,
staked in an Aerodrome gauge (yield = AERO emissions only; trading fees go to
veAERO voters). Produces, per (pool, risk setting): time-in-range, rebalances
per year, IL+rebalance drag vs holding the 50/50 mix, realized emissions, and
the user-level net yield at each LTV. Assumptions are printed with the table.
"""
import json, math, sys
import numpy as np

SAMPLE = json.load(open(sys.argv[1]))  # gauge_sample.json from the workbench
PATHS = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
H = 8760  # hourly steps, one year
rng = np.random.default_rng(7)

# ── assumptions (labelled in the product) ──────────────────────────────────
VOL = {"aero-usdc-weth-5": 0.55, "aero-cbbtc-usdc": 0.40, "aero-weth-cbbtc": 0.33}  # realized, Gecko OHLCV 2026-03-01→08-31 daily (ETH 0.56, BTC 0.39, ETH/BTC 0.26–0.43 hourly/daily blend)
CORRELATED = {"aero-weth-cbbtc"}
SETTINGS = [  # (key, width for volatile pairs, width for correlated pairs, rebalance delay hours)
    ("sheltered", 0.25, 0.125, 48),
    ("steady", 0.08, 0.04, 12),
    ("working", 0.015, 0.0075, 2),
]
SLIPPAGE = 0.0005  # extra cost on the swapped half at a rebalance
NET_FEE = 0.765    # 15% engine then 10% Oilskin on emissions
SUPPLY = 4.0       # ZEC supply APR on Rhea (sampled)
BORROW = 13.47     # USDC borrow APR on Rhea (sampled)
LTVS = [0.30, 0.40, 0.50]

def f_width(w):  # value per unit liquidity per sqrt(P) for a centered ±w range
    return 2 - math.sqrt(1 - w) - 1 / math.sqrt(1 + w)

def simulate(pool, w, delay_h, apr_in_range_pct, fee_bps):
    sig = VOL[pool]
    dt = 1 / H
    # GBM, zero drift: log-returns
    z = rng.standard_normal((PATHS, H))
    logp = np.cumsum(-0.5 * sig**2 * dt + sig * math.sqrt(dt) * z, axis=1)
    P = np.exp(logp)  # price relative to start (token1 per token0)
    # position state per path
    V0 = 1.0
    pa = np.full(PATHS, 1 - w); pb = np.full(PATHS, 1 + w)
    sp = np.sqrt(np.ones(PATHS))
    L = np.full(PATHS, V0 / (sp * f_width(w)))
    # amounts at mint (centered): x0 token0, y0 token1
    x = L * (1 / sp - 1 / np.sqrt(pb)); y = L * (sp - np.sqrt(pa))
    hold_x = x.copy(); hold_y = y.copy()   # HODL comparison: same initial mix, never touched
    out_hours = np.zeros(PATHS)
    in_range_h = np.zeros(PATHS)
    rebalances = np.zeros(PATHS)
    emissions = np.zeros(PATHS)
    mint_value = np.full(PATHS, V0)
    cost = (fee_bps / 10_000 + SLIPPAGE) * 0.5  # swap half at the pool fee + slippage
    for t in range(H):
        p = P[:, t]
        inr = (p >= pa) & (p <= pb)
        in_range_h += inr
        emissions += np.where(inr, apr_in_range_pct / 100 * mint_value / H, 0.0)
        out_hours = np.where(inr, 0.0, out_hours + 1)
        need = out_hours >= delay_h
        if need.any():
            idx = np.nonzero(need)[0]
            pp = p[idx]
            # value of the (fully one-sided) position at current price
            spp = np.sqrt(pp)
            xa = np.where(pp <= pa[idx], L[idx] * (1 / np.sqrt(pa[idx]) - 1 / np.sqrt(pb[idx])), 0.0)
            ya = np.where(pp >= pb[idx], L[idx] * (np.sqrt(pb[idx]) - np.sqrt(pa[idx])), 0.0)
            V = xa * pp + ya
            V = V * (1 - cost)
            pa[idx] = pp * (1 - w); pb[idx] = pp * (1 + w)
            L[idx] = V / (spp * f_width(w))
            mint_value[idx] = V
            out_hours[idx] = 0
            rebalances[idx] += 1
    # terminal values
    p = P[:, -1]
    sp = np.sqrt(np.clip(p, pa, pb))
    xv = L * (1 / sp - 1 / np.sqrt(pb)); yv = L * (sp - np.sqrt(pa))
    lp_val = xv * p + yv
    hodl_val = hold_x * p + hold_y
    usdc_val = np.ones(PATHS)  # what the borrowed USDC would be worth if simply held
    drag = lp_val / hodl_val - 1          # IL + rebalance cost vs holding the mix
    vs_debt = lp_val / usdc_val - 1       # LP principal vs the USDC debt (includes ETH delta)
    return {
        "timeInRange": float(in_range_h.mean() / H),
        "rebalancesPerYear": float(rebalances.mean()),
        "dragPct": {"mean": float(drag.mean() * 100), "p10": float(np.percentile(drag, 10) * 100), "p90": float(np.percentile(drag, 90) * 100)},
        "principalVsDebtPct": {"mean": float(vs_debt.mean() * 100), "p10": float(np.percentile(vs_debt, 10) * 100), "p90": float(np.percentile(vs_debt, 90) * 100)},
        "emissionsGrossPct": float(emissions.mean() * 100),
    }

out = {"assumptions": {"paths": PATHS, "stepHours": 1, "horizonDays": 365, "annualVol": VOL, "drift": 0,
                        "rebalance": "re-center at current price with the same width after the position has been out of range for the full rebalance delay; cost = (pool fee + 5 bps slippage) on the swapped half",
                        "emissions": "in-range emissions APR at the position's width from the on-chain sample; paid only while in range; AERO sold on claim (no compounding assumed)",
                        "fees": "15% engine performance fee then 10% Oilskin fee on emissions only (keep 76.5%)", "supplyAprPct": SUPPLY, "borrowAprPct": BORROW},
       "sampledAt": SAMPLE["sampledAt"], "results": {}}
print(f"{'pool':18}{'setting':10}{'width':>7}{'delay':>6}{'TIR':>6}{'rebal/yr':>9}{'drag%':>8}{'emis%':>8}{'net%':>8}  LP net%   user@30/40/50")
for pool in VOL:
    s = SAMPLE["pools"][pool]
    for key, wv, wc, delay in SETTINGS:
        w = wc if pool in CORRELATED else wv
        apr = s["aprByWidthPct"][str(w)]
        r = simulate(pool, w, delay, apr, s["feeBpsLive"])
        net_em = r["emissionsGrossPct"] * NET_FEE
        lp_net = net_em + r["dragPct"]["mean"]
        users = [SUPPLY + l * (lp_net - BORROW) for l in LTVS]
        r.update({"widthPct": w * 100, "rebalanceDelayH": delay, "aprInRangePct": apr, "emissionsNetPct": net_em, "lpNetPct": lp_net,
                  "userNetPct": dict(zip([str(int(l*100)) for l in LTVS], users))})
        out["results"].setdefault(pool, {})[key] = r
        print(f"{pool:18}{key:10}{w*100:7.2f}{delay:6d}{r['timeInRange']:6.2f}{r['rebalancesPerYear']:9.1f}{r['dragPct']['mean']:8.2f}{r['emissionsGrossPct']:8.2f}{net_em:8.2f}{lp_net:9.2f}   " + " / ".join(f"{u:5.1f}" for u in users))
json.dump(out, open(sys.argv[3] if len(sys.argv) > 3 else "/tmp/lp-sim.json", "w"), indent=1)
