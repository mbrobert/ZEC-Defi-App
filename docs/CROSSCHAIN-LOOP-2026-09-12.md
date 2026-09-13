# The cross-chain loop — ZEC on Solana, USDC to Base, LP on Base (design note, 2026-09-12)

**Founder's proposal:** a user bridges ZEC to Solana via NEAR Intents, borrows USDC
against it on Kamino, brings the USDC to Base, and Oilskin deploys it into an
Aerodrome position through the Snuggle engine automatically.

**Verdict in one line:** every hop exists and works today, so it is buildable; the
part that has to be engineered — not assumed — is the protection ladder, which
stops being one atomic transaction and becomes a five-step, two-chain, two-key
sequence that runs at the worst possible moment. Numbers from
`docs/research/SOLANA-ZEC-KAMINO-2026-09.md` and `docs/DIRECTION-2026-09-11.md`.
Abbreviations: CCTP = Circle's Cross-Chain Transfer Protocol; LTV = loan-to-value;
LT = liquidation threshold; HF = health factor; LP = liquidity provision.

## 1 · The hops, with the right rail for each

| Hop | Rail | Time | What arrives |
|---|---|---|---|
| Zcash → Solana | NEAR Intents / OmniBridge | minutes | OmniBridge-bridged ZEC (SPL, mint `A7bdi…QXaS`) |
| Solana: collateral + borrow | Kamino ZCASH market | 1 tx | USDC on Solana, LTV ≤ 40 %, LT 65 % |
| Solana → Base, **USDC** | **CCTP V2 Fast Transfer** — not the Base–Solana bridge | ~8 s (fee scales with size); minutes on the Standard path when the Fast allowance for the route is exhausted | **native** Base USDC — the token Aave and Aerodrome pools use |
| Solana → Base, other SPL tokens | Base–Solana bridge (Chainlink + Coinbase validators) | ~15 min + prove/finalize | a wrapped ERC-20 |
| Base: deploy | `StrategyRouter` → `SnuggleLpVenue` | 1 tx | Aerodrome Slipstream position, gauge-staked |

**Correction to the proposal:** the Base–Solana bridge is the wrong rail for the
USDC hop. It mints a *wrapped* "USDC from Solana" ERC-20 on Base through its
factory, which is not the native Circle USDC that every Base pool uses; the user
would then need a swap. CCTP V2 burns native USDC on Solana and mints native USDC on
Base, and Solana is on Circle's Fast Transfer list (~8 s). The Base–Solana bridge is
the rail for non-USDC assets, not for this loop.

## 2 · What the loop yields today (scenario, not a forecast)

- Kamino USDC borrow: **2.78 %** now, ≈ 4 % after +$100 K of new borrowing, ≈ 7 %
  after +$300 K, pool empty at +$413 K.
- Base LP leg: **refused — 0 of 27 cells clear the gate** at Base's 4.51 % borrow;
  the gate compares against the *Base* borrow rate today and would need a
  venue-aware borrow input to compare against Kamino's instead (a one-line
  change in `services/yield/src/gate.ts`, but the emissions still have to beat
  whichever rate is used — today they beat neither).
- So today the loop ends as "USDC held on Base". Supplying that USDC to Aave Base
  earns 3.51 % against a 2.78 % Kamino cost: **≈ +0.7 % carry before CCTP Fast
  fees and gas on two chains**, and only for the first ≈ $100 K of book before
  Kamino's rate crosses Aave's supply rate. That is the honest size of the
  opportunity until Aerodrome emissions rise.

The cross-chain loop therefore adds hops and risk **without adding yield** until
the same condition the Base-only product is waiting on — emissions clearing the
gate — is met.

## 3 · The ladder across two chains — the real engineering problem

On Base alone, rung 2 (repay at HF 1.35) is one transaction: `unwind` closes the
LP, receives USDC, repays Aave, all atomically, or reverts. In the cross-chain
loop the same rung is:

| Step | Chain | Signer | Can fail on |
|---|---|---|---|
| 1. Close (part of) the LP | Base | keeper (Base key) | gas spike, sequencer lag |
| 2. CCTP burn | Base | keeper (Base key) | Fast allowance exhausted → Standard path (minutes) |
| 3. Attestation | Circle | — | outage; Standard path waits for Base finality |
| 4. CCTP mint | Solana | keeper (Solana key) | congestion, priority-fee spike |
| 5. Repay on Kamino | Solana | keeper (Solana key) | oracle staleness gate (180 s), reserve paused |

Five signed steps, two keys, gas on two chains, four external dependencies — during a
ZEC crash, which is exactly when Solana priority fees and Base sequencer load are
highest and when the Kamino oracle is most likely to refuse a stale price. The
ladder becomes probabilistic. Between rung 2 firing and repay landing, HF keeps
falling; at 40 % LTV the distance from entry (HF 1.625) to liquidation (HF 1.0) is a
−38.5 % ZEC move, and ZEC has moved 2.3× in a month this summer.

**What makes it engineerable (each costs yield):**

1. **A Solana-side USDC reserve.** Hold back, on Solana, never bridged, the amount
   rung 2 needs — e.g. enough to lift HF from 1.35 back above 1.55. Rung 2 is then
   atomic on Solana; only rungs 3–4 cross chains. Cost: that slice earns Kamino's
   1.20 % supply APY, not LP yield.
2. **Earlier triggers for cross-chain positions.** Derisk at 1.30 instead of 1.20,
   warn at 1.55. The ladder in `packages/shared` is per-venue-class, so this is
   a config, not a rewrite.
3. **Lower offered LTV.** The registry rule already stops at min(LT/1.25 = 52 %, Kamino's
   own 40 %) = 40 % here (the 50 % product cap is gone, 2026-09-12); a cross-chain class
   could stop at 30 % (−53.8 % to liquidation).
4. **A keeper with keys and gas on both chains, and a runbook for each step
   failing.** This doubles the keeper's audit surface and adds Circle to the
   trust list.
5. **The pool-size gate** from `DIRECTION-2026-09-11.md` §4 — mandatory here,
   since the book *is* the Kamino market.

## 4 · The user's side of "very easy"

Three wallets and two gas tokens (a Zcash wallet; a Solana wallet holding SOL;
a Base wallet holding ETH), two bridges, and a chain of signatures — the exact
foot-guns `docs/V1-SIMPLE.md` removed. The program account on Solana and the smart
account on Base can absorb most signatures, and a relayer can pay gas, but every
abstraction is more code and more audit. The deposit flow would also have to show
two disclosures: the OmniBridge bridge and the Circle dependency.

## 5 · Where this sits in the two-lane design

- **Base lane, ZEC entry:** a Morpho Blue cbZEC/USDC market (Chainlink ZEC/USD is
  live on Base). One chain, atomic ladder, existing code. This is the shortest
  path to "ZEC → LP with real protection".
- **Solana lane, LP leg:** Orca / Meteora / Raydium concentrated liquidity on the
  same chain as the loan — atomic ladder again, once the gate has Solana inputs.
- **Cross-chain loop:** a third, *Advanced-mode* option with the reserve, the
  earlier triggers, the lower LTV and both disclosures — offered only when the
  Base gate actually clears. Not the Simple path.

## 6 · What is decided and being built (D6, revised 2026-09-13)

The design is `docs/SOLANA-ARCHITECTURE.md` §14 and the Base half is BUILD-PLAN A5; this list is what
changed against the proposal above.

1. **The ladder is per position, not per class.** D7 (2026-09-12) derives the rungs from the entry HF the
   user chose, on both chains; a cross-chain position at Kamino's 40 % cap enters at HF 1.625 and runs
   1.57 / 1.40 / 1.23 / 1.06 (hysteresis 0.06) — earlier than any Base position, without a second table.
   The "warn 1.55 / repay 1.45 / derisk 1.30 / emergency 1.10, LTV cap 30 %" class proposed here is superseded.
2. **The reserve is the rung-2 requirement**, computed on chain from the entry HF and the live debt
   (`R = D × (disarm₂ − rung₂) / disarm₂`, 4.1 % of the debt at entry 1.625), enforced by `deposit_for_burn`
   — a burn that would leave the Account under it is refused — and reported by the keeper when the owner
   moves it. Shared carries the same rule (`reserveFractionFor`, `reserveUsdcFor`).
3. **Circle's fee, allowance and both domain ids are recorded** (`VERIFIED-SOLANA-FACTS.md` Addendum 1) and
   the exact call shapes, PDAs and message format on both chains (Addendum 3); the "~8 s" is still to be
   measured on devnet ↔ Sepolia (Stream C).
4. **Neither burn can be mis-addressed:** the Solana Account records the user's Base account and the Base
   router records the Account's Solana USDC token account; each side's burn goes only there.
5. **Done 2026-09-13**: the forecast takes a `venueBorrow` input, so a cross-chain cell is priced against
   **Kamino's** rate and Kamino's collateral parameters, and a borrow Kamino's pool cannot fund is refused
   (`pool_cannot_fund`) rather than priced at an optimistic rate. `GET /v1/forecast?crossChain=1` serves it.
   Still open: whether the keeper may run the deploy-direction `openLpOnly` automatically (§14.6 — the
   founder's call).
