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

> **Reconciliation, 2026-09-13 (HEAD `300550c`).** §4's rows were already being
> kept current inline by each slice's own commit (A5.1 `afd057b`, A5.2 `b369e81`,
> B3.1 `1bdbe63` are all reflected below) — this pass re-verified every row
> against `git log`, not just re-read them. Nothing in §4 was found stale.
> **Re-verified again 2026-09-13 at `18c8684`** (the H1 reconciliation): A4 moved
> from *in progress* to **done** — the founder answered its two open §2b
> questions as D9 and D10 and both are fixed on both chains; A8 records the three
> internal passes of that day and names **A3 as the only step still owed a pass**;
> A5 and Stream C are unchanged, still waiting on the founder's two-key process
> and the address lookup table. **§6's grep list now returns zero on LIVE files**
> — the last one was a comment in `services/yield/scripts/lp-sim.py` (`87a6f72`),
> and `docs/BUILD-SPEC-2026-09.md` gained the History banner it had never had
> (`257ecd2`). Every other match is this file's own grep-target line, a doc marked
> History, a dated generated report, or an unrelated sense of the words.
> `docs/ROADMAP.md` now exists alongside this file: it is *when* and *what gets
> cut*, this file stays *what* and *in what order*; read both. The §6 grep sweep
> was re-run fresh (Slice N, `fa578e2`, ran it once; four commits have landed
> since) — still zero live hits: every "Base-first" / "1.55 as the floor" /
> "tier as a mode" / "registry flip away" / "within_model_uncertainty as a
> refusal" / "Advanced-only for cross-chain" match left is in a doc marked
> History, in this file's own grep-target line, in a dated report, or is the
> *unrelated* sense of the word (RPC tiers, fee tiers, `/v1/gate`'s own
> machinery, which `docs/TESTING.md` already records as kept on purpose). One
> live doc used "Base-first" as a section label with no such disclaimer
> (`ARCHITECTURE.md` "Owner notifications (v1)") — reworded to "Base module" in
> this pass. **A8 is now formally re-opened**: A3, A4 and A5 (A5.1 + A5.2) all
> exist, so the internal audit wave promised for them is owed before A9's RFP
> package is cut — `docs/ROADMAP.md` §H3 schedules it for the freeze, not now.

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
| D8 | **Launch parameters** (2026-09-13): deposit cap **$25,000** per user, allowlist **25** addresses, day-one funds at risk **$250,000** — the total being the binding ceiling, deliberately under the $625,000 the cap and the allowlist would otherwise permit. | Sizes both audit quotes and any bug bounty; stated in `RFP-EVM-2026-09-13.md` and `RFP-SOLANA-2026-09-13.md` §5. On Solana the $250,000 implies at most $100,000 borrowed at Kamino's 40 % cap, about 28 % of that market's available USDC. |
| D7 | **Users choose their own risk on a continuous health-factor slider** (revised 2026-09-12, replaces fixed tiers). Drag the HF and the borrow amount works backwards; type a borrow amount and the HF bar reflects it. "Sheltered" (1.55) and "Expert" (1.30) survive only as quick-click marks on the slider. Kamino's own 40 % LTV cap binds on Solana regardless. | One on-chain floor = the slider's minimum (registry parameter; **1.25, pinned 2026-09-12**; the 50 % product cap removed the same day — the venue's own max LTV is the only other ceiling); ladder rungs derived from the entry HF the user chose (§2b); forecast updates live with the slider. |

| D9 | **The entry-HF record follows the owner** (2026-09-14): any owner action through the router that moves debt or collateral re-records it, in both directions; the keeper's protective actions never do. | `StrategyRouter._rerecordEntryHf`, `OilskinAccount.keeperActor()`, the Solana twins; `AUDIT-2026-09-13.md` Part 3 LADDER-1 |
| D10 | **The acting rungs stop deriving above an entry HF of 2.00** (2026-09-14). `warn` keeps deriving — it only notifies. | `MAX_LADDER_ENTRY_HF` in shared and the Solana program; LADDER-2 |
| D11 | **The cross-chain loop is IN BETA** (2026-09-14), closing `ROADMAP.md` §3's scope valve early. | Fallback decided with it: if devnet ↔ Sepolia has not passed by 2026-11-13, it ships **disabled behind a flag**, not later |
| D12 | **Perps is IN BETA, and `MorphoBlueVenue` comes out of beta scope to pay for the audit surface** (2026-09-14). | Rule 2's trade. Morpho stays in the repo; it leaves the frozen scope. **Both audit firms must be sent a scope diff this week, while they are still scoping** |
| D13 | **Hyperliquid is the perps venue** (2026-09-14). | The only non-custodial venue with a ZEC perp; every alternative is an exchange the user would hand their coins to. Chain-verified in `VERIFIED-PERPS-FACTS-2026-09-14.md` |

**Interpretation I am applying** (say so if wrong): "in both" for D6 means both
Simple and Advanced modes. For cross-chain positions the slider's binding cap is
Kamino's own 40 % LTV, which on ZEC (LT 65 %) means entry HF ≥ 1.625 — above
the Sheltered mark — so the five-step ladder always starts with more buffer
than any Base position, plus the Solana-side reserve.

## 2 · What stays a hard refusal (safety, not profitability)

1. Entry HF below the registry floor (1.25, pinned 2026-09-12) — on-chain, `EntryHfTooLow`.
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
| Slider range | from the registry floor (**1.25**, pinned 2026-09-12) up to "borrow nothing"; presets are marks, not modes. The only other ceiling is the venue's own max LTV — the 50 % product cap was removed the same day |
| Bidirectional | HF ↔ borrow amount via the identity above; either field drives the other; live |
| Binding caps shown | venue max LTV (Aave LT-derived, Kamino 40 %), pool liquidity, deposit caps — whichever binds is named on screen |
| On-chain floor | `CollateralRegistry.entryHfFloor` — one number, `EntryHfTooLow` below it; the venue enforces it, the slider just cannot go under it |
| Ladder for a chosen entry HF `e` | rungs scale with the chosen buffer: `rung = 1 + (e − 1) × k` with k = 0.91 / 0.64 / 0.36 / 0.09 (this reproduces the 1.50 / 1.35 / 1.20 / 1.05 table the product ran before the pin at e = 1.55; at the 1.25 floor the rungs are 1.23 / 1.16 / 1.09 / 1.05); **emergency never below 1.05**; hysteresis = 0.05 × (e − 1) ÷ 0.55, minimum 0.02. **D10, 2026-09-13: above `MAX_LADDER_ENTRY_HF` = 2.00 the ACTING rungs (repay / derisk / emergency) stop deriving and take the 2.00 ladder's — 1.64 / 1.36 / 1.09 — while `warn` keeps deriving, because it only notifies.** Below the cap nothing changed |
| Worked | e = 1.30 → warn 1.27, repay 1.19, derisk 1.11, emergency 1.05 · e = 1.25 → 1.23 / 1.16 / 1.09 / 1.05 · e = 2.60 → warn 2.46, then the cap's 1.64 / 1.36 / 1.09 |
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
| A4 | **Risk slider** (§2b): one registry floor; `ladderFor(entryHf)`; HF ↔ borrow both ways; presets as marks; entry HF stored on the position and read by the keeper; acknowledgment below 1.55 | **done 2026-09-13** (`f3ab935`) — the two consequences this row left open for the founder were answered as D9 and D10 and are fixed on both chains with regression tests; `AUDIT-2026-09-13.md` Part 3 is A8's owed pass over this step. The build history: A4.1 (the commit that carries this row): shared `ladderFor(entryHf)` / `hysteresisFor` / `ltvForEntryHfBps` / `drawdownToLiquidationPct` / `hfFromWad`, with `HF_LADDER = ladderFor(ENTRY_HF_FLOOR)` unchanged number for number and `maxOfferedLtvBps` / `ltvPresets` taking the floor as a parameter; `StrategyRouter.entryHfWad[account]` written at every open as the venue measured it and emitted (`EntryHfRecorded`; `audit-regressions/EntryHfRecorded.t.sol` proves 1.30 and 1.25 recorded at a 1.25 floor and 63 % refused); the Base keeper reads it each tick (`agent/src/services/entryHf.ts`), runs the account's ladder, writes the rung's disarm on the dispatch record, and falls back to the floor's ladder by name (`entryHf: null`). A4.2 (the commit that carries this row): the slider in the wizard — HF ↔ borrow both ways to the cent, Sheltered 1.55 / Expert 1.30 as marks, the binding cap named (shared `offeredLtvBounds`), the acknowledgment below 1.55, `entryHf` in place of `ltvPreset`, the registry floor read from the deployment, the dashboard's band / keeper panel / banner on the account's recorded entry HF. **Flag for the founder:** with `MAX_OFFERED_LTV_CAP_BPS` at 50 % the cap binds on both Base assets (lowest HF 1.56 on cbBTC, 1.66 on WETH) whatever the floor, so a 1.25 floor changes nothing on Base until the cap is raised or removed — the floor and the cap are one decision. A4.4 (the commit that carries this row): the yield service reads the registry's floor (`RegistrySource`, `COLLATERAL_REGISTRY_ADDRESS`, optional until a deployment exists) and `/v1/forecast` judges and defaults against it, saying the source (`entryHfFloorSource`) and the read time; a stale or failed read falls back to the shared constant, said. A4.3 (the commit that carries this row): both prototypes — the slider, the marks, the typed HF and borrow, the sub-mark acknowledgment, the derived ladder in the pinned block (byte-equal, diffed against shared), the position's / account's recorded entry HF driving the keeper sim, the band and the docs. **Pinned 2026-09-12 (founder): the floor is 1.25 and the 50 % product cap is gone** — `ENTRY_HF_FLOOR = 1.25`, `MAX_OFFERED_LTV_CAP_BPS` deleted everywhere (shared, `CollateralRegistry`, the Solana program, both prototypes), the deploy defaults at 1.25e18, every suite re-derived. Still to do: the Solana keeper reads the global table until the program carries the entry HF (B stream). **Two consequences of §2b surfaced by the prototypes — BOTH ANSWERED 2026-09-13 (D9, D10) and fixed.** (1) The record moved only at an open, so a withdrawal down to the exit floor left a much higher entry's ladder in force and the keeper unwound a position the owner had deliberately moved — two identical positions at HF 1.26 were treated oppositely because of how each was opened. **D9: any OWNER action that moves debt or collateral re-records the entry**, in both directions; the keeper's own protective actions do not (it would be marking its own homework), and neither does an unwind that moves nothing. (2) The rungs scaled with the entry without limit, so at an entry of 78 the keeper repaid at 50.28 and de-risked at 28.72. **D10: above `MAX_LADDER_ENTRY_HF` = 2.00 the acting rungs take the 2.00 ladder's**; `warn`, which only notifies, keeps deriving. The floor number waits on the founder (1.25 proposed; it must be ≥ 1.10, `MIN_LADDER_ENTRY_HF`, or four rungs do not fit) | A4.1 proven: `EntryHfRecorded.t.sol` (4), `healthMonitor.test.ts` "opened at HF 1.30 … 1.26 warns" (3), shared `health.test.ts` (7). A4.2 proven: `wizard.test.ts` (6 on the bounds, the identity, the acknowledgment), `math.test.ts` (`planLoan` over an HF), Playwright SIMPLE scenario moving the slider both ways (14 / 0 / 6). A4.4 proven: `entry-floor.test.ts` (2), `forecast.test.ts` route with a registry at 1.25 (1). A4.3 proven: prototype suites 130 · 116 · 62 · 6 |
| A5 | **Cross-chain receiving side**: `StrategyRouter.openLpOnly`; CCTP mintRecipient = the user's `OilskinAccount`; cross-chain position class with the Solana-side reserve; rung actions close the LP and burn to the user's Solana PDA | **in progress** — the design landed 2026-09-13 (`SOLANA-ARCHITECTURE.md` §14; the exact call shapes, PDAs and the V2 message format in `VERIFIED-SOLANA-FACTS.md` Addendum 3, the addresses in Addendum 1); **A5.1 done 2026-09-13**: the router's `openLpOnly` / `setSolanaRecipient` / `closeLpAndBurn`, `ICctpV2.sol` from the verified implementations, the CCTP V2 doubles reproducing the message bytes, 11 unit tests + 1 fork test (the real messenger burns native USDC at block 51,222,568), the deploy guard on Circle's addresses, ABI 440; **A5.2 done 2026-09-13** up to the attestation: the pair rule and reader, the Base burn as a keeper action (`dispatchBurn` / `confirmBurn`, one `closeLpAndBurn` per pool under its own grant), the Solana dispatcher's bridge route with the in-flight wait, the bridge stage on the record; **Stream C done 2026-09-13** in code (the attestation poll, the delivery, the stage machine and the runbook — `CROSSCHAIN-RUNBOOK-2026-09-13.md`); **left to the founder**: the two-key process that holds a Base key beside the Solana one, and the address lookup table both cross-chain transactions need; **left to B5**: the web's arrival screen and the second grant's prompt (`CONTRACT-ABI.md` "the cross-chain protection grant") | Anvil fork + CCTP mock end-to-end |
| A6 | Owner notification channel | **done** — `1fed88d` (in-app owner history; the notifier's channels and the honest `reachesAPerson` rule) | reaches a person in a test |
| A7 | Wallet-connect restyle | **done** — `13f3af5` | Playwright 12 + 1 |
| A8 | Audit wave 2 (internal) on A2–A5 | **done for A1, A2, A4, A5, A6, A7 — A3 is the one left.** Wave 2 `a8485d6` + fix round `9007de4` (`AUDIT-2026-09-07.md`); wave 3 `1fe4a41` / `82e1443` (`AUDIT-2026-09-11.md`); NI-HIGH-1 `2fbf1aa` (`AUDIT-2026-09-12.md`). **2026-09-13, three passes in `AUDIT-2026-09-13.md`:** Part 1 (`e1d57a4`) B3–B4, A5.1, A5.2, B3.1 and Stream C — two Medium defects fixed, six observations; Part 2 (`0a587f1`) the keeper's feed staleness policy — FEED-MED-1, a bound derived under a live feed's own heartbeat; Part 3 (`f3ab935`) this step, A4 — LADDER-1 and LADDER-2, both Medium, both fixed, and observation O-2 closed with them. Part 4 (this row's commit) A3, the forecast service — FORECAST-1, Low: a stale Kamino sample was refused *and* priced, so a cross-chain cell showed a rate, a liquidation threshold and a pool depth derived from a read already declared too old; fixed, with three things checked and found sound beside it. **A8 is closed: every step A1–A9 has had a pass** | `docs/AUDIT-<date>.md` |
| A9 | EVM audit RFP package | **done 2026-09-13** — `RFP-EVM-2026-09-13.md`: the scope measured from the tree (6,213 lines of Solidity, 30 files), the trust model in a page, the invariants asserted and the six to attack, the six questions asked identically of every firm, and the suite counts. Measured at `e1d57a4`; the audit target is the freeze tag `beta-audit-1`. **The founder fills §5 (deposit cap, allowlist, funds at risk) and sends it** | scope + fixed commit hash |

**Stream B — Solana module (`solana/` workspace)**

| Step | What | State (2026-09-12) | Done when |
|---|---|---|---|
| B1 | `docs/VERIFIED-SOLANA-FACTS.md` — every number re-read at a fresh slot | **done** — `65a6a16` (slots 446,294,693 → 446,298,641; +6 shared tests); the CCTP rows folded in as Addendum 1 (this reconciliation) | dated, sourced |
| B2 | `docs/SOLANA-ARCHITECTURE.md` | **done and read by the founder** — `4bb1121`; his seven §12 decisions recorded `24f642c` | founder has read it |
| B3 | Anchor program: init, deposit ZEC → Kamino, borrow USDC, repay, withdraw, delegated rungs, reserve, `depositForBurn` | **in progress** — scaffold `915350e`; owner path S2 `b576779` (localnet 15/15); `keeper_protect` S3 `ee291b9` (21/21). **Built:** `init_account`, `deposit`, `borrow` (entry floor), `repay`, `withdraw` (exit floor + dust), `transfer_out`, `close_position`, `grant` / `revoke` / `revoke_all`, `keeper_protect`. **Built 2026-09-13 (B3.1, `SOLANA-ARCHITECTURE.md` §14):** the entry-HF record and the per-position ladder on chain (D7 parity), the reserve rule, `set_base_account`, `deposit_for_burn` (the CCTP CPI against the cloned Circle programs; localnet 34 / 34). Left for the deploy runbook: the address lookup table the burn transaction needs. **Cannot be built:** `release_obligation` (the S3 finding, below) | local-validator tests with cloned Kamino + CCTP programs |
| B4 | Solana keeper as a chain adapter in `agent/` (observe-only until a key exists) | **done** — S4 `7418bbf`: **2026-09-13 B3.1: reads the position's recorded entry HF and derives its ladder (`resolveLadder`, the Base twin) — the A4 gap this row named is closed;** `agent/src/solana/` (reader, valuation, policy, dispatcher, monitor, config, daemon); the store generic over an id codec; IDL seam 77/77; agent 263; localnet 26/26 with `keeper.spec.ts` 5. It reads the global ladder today; A4 makes it read the position's chosen entry HF | ladder replay tests |
| B5 | Web: Solana wallet adapter, deposit/borrow flows, Kamino rate impact in the forecast | **built, not yet driven by a live wallet** — part 1 `67307df`: the yield service's Kamino reader and `/v1/solana/borrow` (the rate after the borrow shown, safety-only refusals — architecture §7 as built); part 2 (2026-09-13): wallet adapter, the five-screen wizard on Kamino's numbers with the cap named, the position page with the exit hatch, instructions pinned to the IDL (§8 as built). **Nothing remaining as of 2026-09-20.** The wallet-driven run on localnet is `web/test/localnet/open.test.ts` (`npm run test:localnet -w @zyo/web`, a row of `npm run status -- --all`): the wizard's `runSolanaOpen` and the exit hatch's `runSolanaClose` signed by a throwaway keypair against the real program on the harness's validator — init, deposit, borrow, grant, read back with the dashboard's reader, then top-up, close, both tokens home. Its first runs found and fixed three defects the demo could never show: a borrow at exactly Kamino's cap is refused by klend (`BorrowTooLarge`; the slider's lowest offered HF is now a quarter of a percent above the cap, 1.629, where the localnet specs have always borrowed), the web's Grant size was 165 against the program's 173 (every live grant would have failed to decode; both account sizes are now derived from the IDL in the seam test), and the close's last transfer planned a pre-close amount of zero and was refused (the two transfers home now move the live balance). **The cross-chain forecast built 2026-09-20**: a sixth screen, "Borrowed USDC", between the health factor and the review — keep it on Solana (the default) or cross to Base into an Aerodrome pool, the cells priced by `/v1/forecast?crossChain=1` on Kamino's borrow side (a generated demo snapshot offline), the reserve that stays behind named on the screen, the Base wizard's acknowledgment with the loop's own sentence, the crossing's four signatures listed on the sign screen and **not signed by this build** (`NEXT_PUBLIC_CROSS_CHAIN_LOOP` gates the choice; ROADMAP §3's fallback). **Advanced mode's sell budget of zero built 2026-09-20** (the review step's choice, the position card, the keeper's refusal by name) | Playwright scenarios (2 in demo mode pass; the signed path is next) |
| B6 | Internal audit pass on B3–B4 | **done 2026-09-13** — `AUDIT-2026-09-13.md` covers B3–B4 and everything built that day (A5.1, B3.1, A5.2, Stream C): two medium defects found and fixed with regression tests (the bridge stall window could never expire; a burn could authorise a CCTP fee of nearly the whole amount), six observations recorded | findings ledger |
| B7 | Solana audit RFP package (OtterSec / Neodyme / Zellic / Sec3) | **done 2026-09-13** — `RFP-SOLANA-2026-09-13.md`: 2,592 lines of Rust, the exit-is-through-the-program trust model, the keeper's single instruction and its bounds, the six things to attack, the same six questions, and what we have NOT proven (nothing has crossed a chain for real). Measured at `e1d57a4` | scope + fixed commit hash |

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

**Stream C — cross-chain glue** — **built in code 2026-09-13, never run against a real transfer.** The
attestation client, the delivery instruction, the resumable stage machine and the five-step runbook with each
failure handled are in (`CROSSCHAIN-RUNBOOK-2026-09-13.md`; keeper 310, localnet 36). **Not done:** end-to-end
on Solana devnet ↔ Base Sepolia — which is also what would measure Circle's "~8 seconds"; reserve sizing from
the Monte Carlo (modelled 2026-09-19, the multiple still the founder's); and the two-key process itself, which is
the founder's call (a Base key beside the Solana key). **Done 2026-09-25:** choosing Fast versus Standard — the
keeper reads Circle's schedule and allowance at every send (`chooseCctpFinality` in shared, `CircleFeeClient` and
the `KeeperBaseBurner` adapter in `agent/src/solana/`; `VERIFIED-SOLANA-FACTS.md` Addendum 5), and the adapter
that the two-key process will hand to `runSolanaKeeper` exists, so what the founder's process has to build is
the wallet and nothing else. Inputs recorded: fees 1 bp / 1.3 bp, the shared Fast allowance, the domain ids
(Addendum 1, re-read Addendum 5), every receive account (Addendum 4).

**Stream D — perps, delta-neutral "earn funding on your ZEC" (HyperEVM)** — **new 2026-09-14, D12/D13.**
Nothing is built. The facts are read and the architecture is decided; the order below is the one the Solana
module proved works — facts, then design, then the program, then the keeper, then the web, then an audit pass.

| Step | What | State | Done when |
|---|---|---|---|
| D0 | Verified facts: the venue, the market, the funding history, CoreWriter, the read precompiles | **done 2026-09-14** — `VERIFIED-PERPS-FACTS-2026-09-14.md`: no ZEC perp on Base; Hyperliquid ZEC index **214**, $476 M open interest, funding **+10.7 % to +22.4 %** annualised to shorts over 31 days measured hourly; CoreWriter `0x3333…3333` with `sendRawAction(bytes)` `0x17938e13` in its deployed dispatch table; mark/oracle precompiles `0x…0806` / `0x…0807` matching the API to the last digit | every number dated and sourced |
| D0b | The three facts still taken from a document | **one of three settled 2026-09-25** — the margin table behind `marginTableId: 52` is now read from `meta.marginTables` ("tiered 10x (2)": 10× to $20 M notional, 5× above; facts §6). Still owed: the limit-order action bytes (id 1) proven on testnet, and the `position` struct (quoted by two developer guides, not by Hyperliquid's own file). The design's §2 widens the gate to seven items — a contract's HyperCore credit, USDC's HyperEVM addresses, the default leverage of a contract account, Circle's HyperEVM contracts, what a backstop leaves | proven against testnet, not read from a page |
| D1 | **Design before code** (rule 10): the HyperEVM account, how the short is opened and closed, what the keeper may do under a grant, and **how the ladder learns a liquidation distance that is not a borrow** | **drafted 2026-09-25, waiting on the founder's read** — `docs/PERPS-DESIGN-2026-09-25.md`. The answer to the unprecedented piece: the short's up-move to liquidation `d` (from the venue's own `liq_price` formula) maps to an **equivalent health factor** `1 / (1 − d)`, so the SAME shared `ladderFor` runs on it — a borrow dies on a fall of `1 − 1/HF`, a short on a rise of `d`, and the rungs are the same distances; cross margin with one position per account (CoreWriter has no leverage or isolated-margin action); the reserve in the HyperCore spot balance; USDC by CCTP to **domain 19** (Fast inbound from Base, Standard only on the way back); seven decisions in its §10, the floor (proposed L = 2, a 42.9 % up-move) first | a design doc the founder has read |
| D2 | `OilskinPerpAccount` on HyperEVM — clone factory, owner = the user's wallet, the position owned by the account itself, grants in the shape `OilskinAccount` already uses | not started | Foundry unit + a HyperEVM fork suite |
| D3 | The venue adapter: open/close the short through CoreWriter, read size and margin through the precompiles | not started | fork tests against live HyperCore state |
| D4 | The keeper's perps path: funding accrual, the short's own liquidation distance, the rungs that act on it | not started | ladder replay tests, the Base/Solana pattern |
| D5 | USDC in and out over **CCTP** from the user's Base account — the rail Stream C already built | not started | end to end on testnet |
| D6 | Web: the fourth wizard, the **measured funding history with its variance** (never a rate, never "yield"), the acknowledgment, the position page | not started | Playwright; banned-words test green |
| D7 | Internal audit pass over D2–D6 | not started | `docs/AUDIT-<date>.md` |

**The one thing in this stream with no precedent.** Every rung the keeper knows is about a *borrow against
collateral*. A short against a spot holding fails the other way: if ZEC rises far enough the short is
liquidated and the user is left long spot with a realised loss — the opposite of what they were sold. ZEC
moved **+9.9 % in the 23 hours between the two price reads in the facts file**, on a venue whose maximum
leverage is 10×. D1 has to answer this before D2 is written.

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
