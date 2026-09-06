# Changelog

Abbreviations: ABI = application binary interface; HF = health factor; LP =
liquidity provision; EIP = Ethereum Improvement Proposal.

## 2026-09-05 — Base-first v1 (commit `b4333d7` + this docs pass)

**Product.** The NEAR / Rhea / 1-Click design is gone. A wallet on Base
deposits cbBTC or WETH on Aave v3, borrows USDC, and holds it or deploys it
through the Snuggle engine into an Aerodrome pool that clears the yield gate;
spot via CoW. Positions live in a per-wallet `OilskinAccount`; the router is
stateless; the keeper acts only inside a revocable grant. cbZEC is spot-only
(registered as collateral, disabled with reason; no market, no emissions).

**Code (all suites green on this tree).** contracts 181 / 8 fork skipped ·
agent 139 · yield 105 · web 89 + Playwright 12 · shared 52 · prototypes 216
checks · ABI seams 266/266 and 36/36. Details and deviations from the spec:
`/tmp/build/done-*.md` at build time; the durable record is `AUDIT.md`,
`AUDIT-SCOPE.md`, `TESTING.md`.

**Verdict.** At the 2026-09-05 borrow read (4.828 %) no pool × setting clears
the gate (`MODEL-NUMBERS-2026-09-05.md`); the product recommends holding USDC.

**Docs.** Rewritten to the shipped code: `README.md`, `SETUP.md`,
`ARCHITECTURE.md`, `FLOWS.md`, `RISKS.md`, `AUDIT.md`, `AUDIT-SCOPE.md` (new),
`TESTING.md`, `PRIVACY.md`. Deleted (dead design, nothing linked to them):
`RHEA-SDK.md`, `INTEGRATIONS.md`, `RUN-DEMO.md` (folded into `SETUP.md`). Kept
as history with a one-line header: `AUDIT-LEDGER-2026-08.md` (the old
`AUDIT.md`), `SECURITY-REVIEW-2026-08.md`, `FEEDBACK-ANSWERS.md`,
`FEEDBACK-ANSWERS-2.md`, `V1-SIMPLE.md`, `UX-TEARDOWN.md`, `POOLS.md`. Restored
from the recovered copies, with headers: `AUDIT-FINDINGS-2026-09-03.md`,
`CBZEC-2026-09.md` (both cited by code and by `BASE-PIVOT-2026-09.md`;
`research/VENUES-2026-09.md` and `INFRA-2026-09.md`, also cited there, were not
recoverable). `VERIFIED-BASE-FACTS.md`: PoolDataProvider casing corrected to
EIP-55 (same hex) and an explicit "not verified" list appended.
`YIELD-SERVICE.md`: two stale references fixed.

**Must-fix found while documenting (not changed — outside the docs area):**

1. Web ↔ keeper grant seam: the web grants `StrategyRouter.unwind` only; the
   keeper's plan needs `SnuggleLpVenue.closeMany` too and is refused for LP
   positions (`RISKS.md` §10).
2. The web's B20 disclosure says Oilskin reads cbZEC policy state on chain
   before touching cbZEC; no shipped code does (`RISKS.md` §4).
3. The borrow-and-hold path bypasses the router's entry-HF floor
   (`FLOWS.md` §2).
4. `services/yield/src/abi.ts` comment names the deleted
   `agent/src/vendor/keccak.ts`; root `package.json` description still says
   Rhea / NEAR Intents.
