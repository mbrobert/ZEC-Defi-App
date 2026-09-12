# Build plan — the defined path (decided 2026-09-12)

> **Status note, 2026-09-12 evening (Cowork).** This plan was written before the
> `~/Documents/Oilskin` clone was visible to me. That clone is 50 commits past
> `569b705` (HEAD `d2f7760`, "Slice K"): Claude Code has already completed the
> Sepolia rehearsal package (A1), `MorphoBlueVenue` (A2), notifications (A6), the
> wallet restyle (A7), audit waves 2 and later (A8; `AUDIT-2026-09-07/11/12.md`),
> `VERIFIED-SOLANA-FACTS.md` (B1), `SOLANA-ARCHITECTURE.md` (B2), and Solana
> slices S2–S3 on localnet (part of B3), with keeper work in progress. The
> **decisions D1–D7 stand and are new to that clone**; §4 below was reconciled
> against the tree by Claude Code on 2026-09-12 (20:30 UTC, HEAD `7418bbf`) and now
> records each step's true state.

This is the plan of record. Every earlier "option" document
(`DIRECTION-2026-09-11.md`, `CROSSCHAIN-LOOP-2026-09-12.md`) is now history that
explains *why*; this file says *what* gets built, in what order, by whom. Read this
before `README.md`. Abbreviations: HF = health factor; LTV = loan-to-value;
LT = liquidation threshold; LP = liquidity provision; CCTP = Circle's Cross-Chain
Transfer Protocol; PDA = program-derived address; DYOR = do your own research.

## 1 · Decisions (founder, 2026-09-12)

| # | Decision | Consequence in code |
|---|---|---|
| D1 | **Both chains, both in full.** Base module and Solana module; no "lite" notify-only variant. | `solana/` workspace with an Anchor program that owns the Kamino obligation via a PDA; keeper acts on both chains. |
| D2 | **Launch together.** Estimate (assumptions in §5): **Feb–Mar 2027**. | Two audits run in parallel; nothing goes live until both are closed. |
| D3 | **No cbZEC/USDC Morpho market on Base.** Wait for Aave or another market to list cbZEC. | cbZEC stays registered-disabled on Base; ZEC holders enter via Solana. `MorphoBlueVenue` still ships for cbBTC/WETH. |
| D4 | **The yield gate is no longer a barrier.** Replace the profitability refusal with a DYOR warning, a required acknowledgment, and a **true-yield forecast tool** on the site. | `services/yield` keeps every model; `ok` stops blocking; `/v1/forecast` serves both models, IL drag, break-evens, liquidation price, and rate impact. |
| D5 | **Simple mode allows all deposits** into any curated pool, pointing the user at the forecast. | Empty-menu refusal removed; "verdict" copy removed; acknowledgment on every new position. |
| D6 | **Cross-chain loop in v1, in both modes** (ZEC on Kamino → USDC via CCTP V2 → LP on Base). | Base router gains an LP-only entry for arriving USDC; Solana program gains a CCTP burn; keeper gets a cross-chain position class with a Solana-side USDC reserve. |
| D7 | **Users choose their own risk on a continuous health-factor slider** (revised 2026-09-12, replaces fixed tiers). Drag the HF and the borrow amount works backwards; type a borrow amount and the HF bar reflects it. "Sheltered" (1.55) and "Expert" (1.30) survive only as quick-click marks on the slider. Kamino's own 40 % LTV cap binds on Solana regardless. | One on-chain floor = the slider's minimum (registry parameter; **proposed 1.25**, founder's number); ladder rungs derived from the entry HF the user chose (§2b); forecast updates live with the slider. |

**Interpretation I am applying** (say so if wrong): "in both" for D6 means both
Simple and Advanced modes. For cross-chain positions the slider's binding cap is
Kamino's own 40 % LTV, which on ZEC (LT 65 %) means entry HF ≥ 1.625 — above
the Sheltered mark — so the five-step ladder always starts with more buffer
than any Base position, plus the Solana-side reserve.

## 2 · What stays a hard refusal (safety, not profitability)

1. Entry HF below the registry floor (proposed 1.25) — on-chain, `EntryHfTooLow`.
2. A borrow the venue's pool cannot fund (available liquidity < amount).
3. Oracle stale or venue paused (Aave / Kamino flags read live).
4. Asset disabled in the registry (cbZEC on Base until D3 changes).
5. Cross-chain class without its Solana-side USDC reserve funded.

Everything else — negative forecast, model uncertainty, thin emissions, a thin
health-factor buffer above the floor — is shown, acknowledged, and allowed.

## 2b · The risk slider — how it works

The math is one identity, so both directions are exact:

    HF = collateral value × LT ÷ debt        ⇒   debt = collateral × LT ÷ HF
    LTV at entry = LT ÷ HF                     ⇒   drawdown to liquidation = 1 − 1 ÷ HF

So on cbBTC (LT 78 %): HF 1.55 → LTV 50.3 %, liquidates on −35.5 %; HF 1.30 →
LTV 60 %, −23 %; HF 1.25 → LTV 62.4 %, −20 %. On Kamino ZEC (LT 65 %): HF 1.625
is the most Kamino allows (its 40 % cap), so the slider's Solana range is
[floor, …] on HF but the borrow is capped by the venue — the UI shows both
limits and which one is binding.

| Element | Rule |
|---|---|
| Slider range | from the registry floor (proposed **1.25**) up to "borrow nothing"; presets are marks, not modes |
| Bidirectional | HF ↔ borrow amount via the identity above; either field drives the other; live |
| Binding caps shown | venue max LTV (Aave LT-derived, Kamino 40 %), pool liquidity, deposit caps — whichever binds is named on screen |
| On-chain floor | `CollateralRegistry.entryHfFloor` — one number, `EntryHfTooLow` below it; the venue enforces it, the slider just cannot go under it |
| Ladder for a chosen entry HF `e` | rungs scale with the chosen buffer: `rung = 1 + (e − 1) × k` with k = 0.91 / 0.64 / 0.36 / 0.09 (this reproduces today's 1.50 / 1.35 / 1.20 / 1.05 at e = 1.55); **emergency never below 1.05**; hysteresis = 0.05 × (e − 1) ÷ 0.55, minimum 0.02 |
| Worked | e = 1.30 → warn 1.27, repay 1.19, derisk 1.11, emergency 1.05 · e = 1.25 → 1.23 / 1.16 / 1.09 / 1.05 |
| Forecast panel | recomputes on every slider move: liquidation price, drawdown, borrow APR after this borrow, both LP-net numbers, user net |
| Acknowledgment | required below the Sheltered mark (1.55); the copy names the drawdown-to-liquidation figure the user chose |

**Flag, once.** At 1.25 the emergency rung is 0.20 above liquidation and the
whole ladder lives inside a 0.20 band; with Chainlink's 24 h heartbeat / 0.5 %
deviation on Base and Kamino's 180 s staleness on Solana, that is the tightest I
would put in front of a Simple-mode user. Below ~1.20 the rungs collapse onto
each other and the keeper is effectively one action. The floor is your number.

## 3 · The forecast tool (replaces the gate in the UI)

One page, one calculator, same math the gate used, now advisory. Inputs: chain,
collateral, deposit size, the HF slider (or a borrow amount), pool, width. Outputs, each with its date and
source: net-of-fees emissions APR; IL drag at recorded σ; **both** LP-net numbers
(closed form and Monte-Carlo-calibrated) with the gap between them shown, not
hidden; borrow rate *after* this borrow (the Kamino curve makes this material);
user net on the whole position; break-even emissions multiple and break-even σ;
liquidation price and drawdown-to-liquidation at the chosen HF; the two disclosures
(bridge + privacy on Solana; Circle on cross-chain). Copy rules unchanged: no
"guaranteed", no "safe", every figure "as of" a block or slot.

## 4 · Workstreams and order — reconciled against the tree, 2026-09-12 20:30 UTC (HEAD `7418bbf`)

Three streams run in parallel; Claude Code owns A and B, the founder holds every key, Cowork owns facts
drafts, audit shortlists, copy and review. Each step ends with suite counts, a commit, a push. **State**
is read from `git log`, not from intent: *done* names the commit; *in progress* says what exists and
what does not; *not started* means no code and no doc beyond this plan.

**Stream A — Base module (existing repo)**

| Step | What | State (2026-09-12) | Done when |
|---|---|---|---|
| A0 | Prove the tree; commit `CLAUDE.md` + `.claude/settings.json` | **done** — `6f4c868`; every count re-measured through slice K `d2f7760` (`docs/TESTING.md`) | suite counts match `docs/TESTING.md` |
| A1 | Base Sepolia deploy prep (mock LP venue + swap adapter, Sepolia profile) → founder deploys | **prepared, not deployed** — `e2350e3` (chain-read dependencies, substitute script, runbook), `17fc8f7`, slice J `b3b482f` (`DEPLOYMENTS.md` template, observe-only keeper and web env, a Sepolia Playwright suite skipped by name until addresses exist). The founder has not run the deploy | post-deploy `cast` checklist passes |
| A2 | `MorphoBlueVenue` for cbBTC/USDC and WETH/USDC (ids verified); cbZEC stays disabled | **done** — `06be2f7`, wave-2 fixes `9007de4`; no cbZEC market is created (D3) | regression tests in `audit-regressions/` |
| A3 | **Gate → forecast**: `/v1/forecast`; remove `ok`-blocking in `web/` and `prototype/`; acknowledgment; liquidity hard-refusal; copy rewrite | **done** — part 1 `b849b17` (the forecast service: `services/yield/src/forecast.ts`, `/v1/forecast`, the Aave curve + totals read, `demo-forecast.json`); part 2 (the commit that carries this row): the web wizard reads the forecast and blocks on nothing it says, every pool a card with both models and the gap, the acknowledgment on Review for LP/hold/spot, the liquidity refusal from the chain read; both prototypes carry `forecast()` beside the unchanged `gate()`, the acknowledgment in both review flows, every "gated / refused / verdict / empty menu" string rewritten; README, RISKS §14, YIELD-SERVICE rewritten. Left on purpose: the generated model report `MODEL-NUMBERS-2026-09-12.md` still says "No pool × setting clears the gate" — it is the gate's own record and three suites parse that line; it is re-worded at the next model regeneration (`lp-sim.py`), not by hand | 0 stale references; copy test green |
| A4 | **Risk slider** (§2b): one registry floor; `ladderFor(entryHf)`; HF ↔ borrow both ways; presets as marks; entry HF stored on the position and read by the keeper; acknowledgment below 1.55 | **in progress** — A4.1 (the commit that carries this row): shared `ladderFor(entryHf)` / `hysteresisFor` / `ltvForEntryHfBps` / `drawdownToLiquidationPct` / `hfFromWad`, with `HF_LADDER = ladderFor(ENTRY_HF_FLOOR)` unchanged number for number and `maxOfferedLtvBps` / `ltvPresets` taking the floor as a parameter; `StrategyRouter.entryHfWad[account]` written at every open as the venue measured it and emitted (`EntryHfRecorded`; `audit-regressions/EntryHfRecorded.t.sol` proves 1.30 and 1.25 recorded at a 1.25 floor and 63 % refused); the Base keeper reads it each tick (`agent/src/services/entryHf.ts`), runs the account's ladder, writes the rung's disarm on the dispatch record, and falls back to the floor's ladder by name (`entryHf: null`). A4.2 (the commit that carries this row): the slider in the wizard — HF ↔ borrow both ways to the cent, Sheltered 1.55 / Expert 1.30 as marks, the binding cap named (shared `offeredLtvBounds`), the acknowledgment below 1.55, `entryHf` in place of `ltvPreset`, the registry floor read from the deployment, the dashboard's band / keeper panel / banner on the account's recorded entry HF. **Flag for the founder:** with `MAX_OFFERED_LTV_CAP_BPS` at 50 % the cap binds on both Base assets (lowest HF 1.56 on cbBTC, 1.66 on WETH) whatever the floor, so a 1.25 floor changes nothing on Base until the cap is raised or removed — the floor and the cap are one decision. A4.4 (the commit that carries this row): the yield service reads the registry's floor (`RegistrySource`, `COLLATERAL_REGISTRY_ADDRESS`, optional until a deployment exists) and `/v1/forecast` judges and defaults against it, saying the source (`entryHfFloorSource`) and the read time; a stale or failed read falls back to the shared constant, said. A4.3 (the commit that carries this row): both prototypes — the slider, the marks, the typed HF and borrow, the sub-mark acknowledgment, the derived ladder in the pinned block (byte-equal, diffed against shared), the position's / account's recorded entry HF driving the keeper sim, the band and the docs. Still to do: the Solana keeper reads the global table until the program carries the entry HF (B stream). **Two consequences of §2b surfaced by the prototypes, for the founder with the floor number:** (1) the record moves only at an open, so a withdrawal that takes an account from a 2.77 entry down to the exit floor leaves it under the derived warn rung (2.61) — the keeper acts and new borrows are blocked until HF recovers; should the record move on any owner action that changes the HF? (2) at a high entry the rungs sit close under it (2.6 → warn at 2.46, a 5 % fall); that is the rule as written. The floor number waits on the founder (1.25 proposed; it must be ≥ 1.10, `MIN_LADDER_ENTRY_HF`, or four rungs do not fit) | A4.1 proven: `EntryHfRecorded.t.sol` (4), `healthMonitor.test.ts` "opened at HF 1.30 … 1.26 warns" (3), shared `health.test.ts` (7). A4.2 proven: `wizard.test.ts` (6 on the bounds, the identity, the acknowledgment), `math.test.ts` (`planLoan` over an HF), Playwright SIMPLE scenario moving the slider both ways (14 / 0 / 6). A4.4 proven: `entry-floor.test.ts` (2), `forecast.test.ts` route with a registry at 1.25 (1). A4.3 proven: prototype suites 130 · 116 · 62 · 6 |
| A5 | **Cross-chain receiving side**: `StrategyRouter.openLpOnly`; CCTP mintRecipient = the user's `OilskinAccount`; cross-chain position class with the Solana-side reserve; rung actions close the LP and burn to the user's Solana PDA | **not started** — the CCTP V2 addresses on both chains are probed and recorded (`VERIFIED-SOLANA-FACTS.md` Addendum 1); nothing else exists | Anvil fork + CCTP mock end-to-end |
| A6 | Owner notification channel | **done** — `1fed88d` (in-app owner history; the notifier's channels and the honest `reachesAPerson` rule) | reaches a person in a test |
| A7 | Wallet-connect restyle | **done** — `13f3af5` | Playwright 12 + 1 |
| A8 | Audit wave 2 (internal) on A2–A5 | **done for A1, A2, A6, A7** — wave 2 `a8485d6` + fix round `9007de4` (`AUDIT-2026-09-07.md`); wave 3 `1fe4a41` / `82e1443` (`AUDIT-2026-09-11.md`); the nightly-invariant finding NI-HIGH-1 `2fbf1aa` (`AUDIT-2026-09-12.md`). **Re-opens for A3–A5** once they exist | `docs/AUDIT-<date>.md` |
| A9 | EVM audit RFP package | **not started** — shortlist and package outline in `AUDIT-SHORTLIST-2026-09.md`; the fixed hash waits for A5 | scope + fixed commit hash |

**Stream B — Solana module (`solana/` workspace)**

| Step | What | State (2026-09-12) | Done when |
|---|---|---|---|
| B1 | `docs/VERIFIED-SOLANA-FACTS.md` — every number re-read at a fresh slot | **done** — `65a6a16` (slots 446,294,693 → 446,298,641; +6 shared tests); the CCTP rows folded in as Addendum 1 (this reconciliation) | dated, sourced |
| B2 | `docs/SOLANA-ARCHITECTURE.md` | **done and read by the founder** — `4bb1121`; his seven §12 decisions recorded `24f642c` | founder has read it |
| B3 | Anchor program: init, deposit ZEC → Kamino, borrow USDC, repay, withdraw, delegated rungs, reserve, `depositForBurn` | **in progress** — scaffold `915350e`; owner path S2 `b576779` (localnet 15/15); `keeper_protect` S3 `ee291b9` (21/21). **Built:** `init_account`, `deposit`, `borrow` (entry floor), `repay`, `withdraw` (exit floor + dust), `transfer_out`, `close_position`, `grant` / `revoke` / `revoke_all`, `keeper_protect`. **Not built:** the Solana-side USDC reserve accounting and `depositForBurn` (the CCTP CPI) — `SOLANA-ARCHITECTURE.md` §13 still lists moving USDC between chains as out of scope, so D6 needs a design addendum there before that code. **Cannot be built:** `release_obligation` (the S3 finding, below) | local-validator tests with cloned Kamino + CCTP programs |
| B4 | Solana keeper as a chain adapter in `agent/` (observe-only until a key exists) | **done** — S4 `7418bbf`: `agent/src/solana/` (reader, valuation, policy, dispatcher, monitor, config, daemon); the store generic over an id codec; IDL seam 77/77; agent 263; localnet 26/26 with `keeper.spec.ts` 5. It reads the global ladder today; A4 makes it read the position's chosen entry HF | ladder replay tests |
| B5 | Web: Solana wallet adapter, deposit/borrow flows, Kamino rate impact in the forecast | **not started** — nor the yield service's Kamino reader and pool-size gate that shows the rate (architecture §7) | Playwright scenarios |
| B6 | Internal audit pass on B3–B4 | **not started** | findings ledger |
| B7 | Solana audit RFP package (OtterSec / Neodyme / Zellic / Sec3) | **not started** — shortlist in `AUDIT-SHORTLIST-2026-09.md` | scope + fixed commit hash |

**The S3 finding, and what it means for §2b's Solana lane.** klend's obligation-ownership transfer needs
Kamino's global admin to approve it and refuses the initiate step under CPI or beside any other instruction
(verified on localnet 2026-09-12; `SOLANA-ARCHITECTURE.md` §3, §12 (3)). A Kamino obligation owned by the
Oilskin Account PDA can therefore never be handed to the user's wallet: `release_obligation` does not exist,
and the exit is always through the program — `close_position` (repay and withdraw in one instruction), then
`transfer_out`. For the design in §2b this means: (1) the program's upgrade authority (Squads, decision 2) is
in the trust path for *exit*, not only for protection, and the pre-sign copy must say so; (2) a position's
whole life — entry at the chosen HF, every rung, the close — is program-mediated, which is exactly what lets
the chosen entry HF be stored on the position and enforced there, on chain, rather than in a keeper table;
(3) Kamino's 40 % cap binds every Solana position at HF ≥ 1.625 whatever the registry floor, so the slider's
Solana range is [floor, ∞) on HF while the borrow field is capped by the venue, and the screen names which
limit binds; (4) if the program were frozen or its upgrade authority lost, the user's Kamino position would be
frozen with it — that goes in `RISKS.md` and the copy, and it is why the exit hatch keeps a regression test on
every slice.

**Stream C — cross-chain glue (after A5 and B3's burn exist)** — **not started.** CCTP V2 Fast Transfer both
directions; reserve sizing from the Monte Carlo; end-to-end on Solana devnet ↔ Base Sepolia (CCTP supports
both; Kamino is mocked there); the five-step rung runbook with each failure handled. Inputs already recorded:
fees 1 bp / 1.3 bp, the shared Fast allowance, the domain ids (Addendum 1).

**Cowork**: the B1 draft — done, superseded by the chain read `65a6a16` with its CCTP rows folded in; the two
audit shortlists — done (`AUDIT-SHORTLIST-2026-09.md`); the forecast page copy, the two disclosures and the
"get a lawyer's read" checklist — not in the tree yet.

## 5 · Timeline (estimate, not a promise)

Assumptions: one Claude Code stream per module at a solid engineer's pace, the
founder available for keys/tests/decisions within a day, no rework surprises,
audit firms' availability as they typically run (EVM 2–6 weeks to start, Solana
3–8 weeks), the cross-chain keeper in both audits (+3–5 weeks).

| Milestone | Estimate |
|---|---|
| A0–A5 and B1–B3 built and internally audited | late Nov – mid Dec 2026 |
| Both RFPs sent | early Dec 2026 |
| Both audits complete + fix rounds | late Jan – early Mar 2027 |
| **Launch, together, capped + allowlisted** | **Feb – Mar 2027** |

## 6 · Superseded — grep targets for Claude Code

"Base-first" · "no pool clears the gate" · "the model's verdict" · "nothing is
offered" · "the LP menu is empty" · "entry-HF floor 1.55" as the floor · "tier" / "expert tier" as a mode ·
"cbZEC … a registry flip away" · `within_model_uncertainty` used as a refusal ·
"Advanced-only" for the cross-chain loop.
