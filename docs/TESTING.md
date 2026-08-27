# Testing Oilskin — how to exercise everything

Two audiences: **you, clicking the demo** (the tester's kit below), and **the
automated suites** (contracts, agent, prototype fuzz).

## Demo addresses (fake, format-valid, not spendable)

These match the app's real validators so its behaviour is identical to production,
but they are **not real addresses and hold nothing** — never send funds to them.
The in-app **🧪 Test kit** (bottom-right of `prototype/simple.html`) drops each one
into the right field on tap.

| Type | Address | Expected behaviour |
|---|---|---|
| Transparent `t1` | `t1Py8kAoQrfmRRWTbtHkDkGb6JuaXPmpGxy` | Accepted — this is where everything returns |
| Transparent `t1` (alt) | `t1TEsT2aZxCvBnM4qWeRtY7uIoP9sDfG1hK` | Accepted |
| Unified `u1` | `u1demo0testonly0notreal0zaddr0qp7r9s2t4v6x8y0a2c4e6g8j0l2n4q6s8u0w2` | Guided to the transparent address, not dead-ended |
| Sapling `zs1` | `zs1demo0testonly0notreal0sapling0zaddr0qp7r9s2t4v6x8y0a2c4e6g8j0l2n4q6s8u0w2x4z6a8c0e2` | Guided to the transparent address |
| Malformed | `t1short` | Stays blocked with a "keep going" hint |

Amounts worth trying: `0.25` (min ✓), `12.5` (typical ✓), `50` (cap ✓), `0.1`
(below min → blocked), `80` (over cap → blocked). All are one tap in the Test kit.

## What to click (every path)

1. **Risk setting** — pick each of Sheltered / Steady / Working hard; the headline
   yield (13.2 / 17.4 / 21.5% with the default mix, at rates sampled 2026-08-16) and
   the "ZEC would have to fall X%" line (57 / 43 / 29%) move together.
2. **Pool mix** — toggle the seven curated pools; the yield recomputes live. Build a
   stables-only mix and read the negative-carry warning ("earns less than the borrow
   cost"); add AERO/WETH and read the impermanent-loss warning; try to remove the
   last pool (blocked).
3. **Deposit** — valid `t1` + an in-range amount → *Get my deposit address* → walk
   the QR/progress steps → land on the position.
4. **Add ZEC** — the risk selector **locks** to the position's setting and the button
   shows your remaining room to the 50-ZEC cap. Try to push a ~40-ZEC position past
   50 → it blocks with "room left".
5. **Withdraw** — drag the slider for a partial exit; a **full** withdraw returns you
   to the start and **unlocks** the selector.
6. **Activity** — every row links to the right explorer (Zcash / NEAR / Base).
7. **Docs** — custody table, risk table, "what can actually go wrong", fees.
8. **Advanced toggle** (top-right) — jumps to the power-user build and back.
9. **Mobile** — shrink to phone width; nav, cards, and the Test kit stay clean.

## Automated suites

```bash
# Contracts (Foundry). Libraries are not vendored — clone the pinned versions once:
cd contracts
git clone --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
forge test                      # 73 tests + 8 invariant suites (~82K+ transitions)
forge test --match-test Fork    # live-engine fork suite (needs a Base archive RPC)

# Agent (zero deps; Node ≥ 20)
cd agent && npm test            # 72 tests incl. adversarial / MEV-resistance suite
```

### Prototype fuzz (Playwright)

The demo carries a **demo-only test seam** (`window.__oil`, stripped in production
like the Test kit) exposing the *real* pure functions, so the fuzz exercises the
shipped logic rather than a re-implementation.

- **Part A — logic grid (2,109 combinations):** every combination of
  {6 addresses × 16 amounts × 6 existing-position sizes × 3 risk stops} for the gate,
  PLUS every non-empty pool subset (127) × 3 risk stops for the yield model —
  asserting the real invariants: account-cap-and-minimum gating (a top-up can never
  exceed 50), apy = supply + LTV × (mix × 0.765 − borrow), carry-sign correctness
  (a mix earning less than the borrow cost goes below the supply-only baseline),
  LTV monotonicity, the liquidation-drop formula (57 / 43 / 29%), and address
  classification. Default-mix headline locks 13.2 / 17.4 / 21.5%.
- **Part B — UI state-machine fuzz (16 seeded sessions, ~90 real actions):**
  randomized clicks through deposit / top-up / withdraw / tab / Test-kit flows on
  desktop and phone viewports, asserting **zero console errors** plus: deposits open a
  position, top-ups lock the selector and cannot exceed the cap, and a full withdraw
  returns to the start and unlocks the selector.

Both are deterministic (seeded) and reproducible. Latest run: **2,109 + 90
combinations, 0 failures.** The two scripts live alongside the verification suites
(`verify-simple.mjs` — 21 end-to-end checks; `verify-toggle.mjs` — the Simple⇄Advanced
round-trip).

## Security review

The pre-audit self-review, its attack-vector map, and the findings it fixed are in
`docs/SECURITY-REVIEW-2026-08.md`. A professional third-party audit is still required
before mainnet.
