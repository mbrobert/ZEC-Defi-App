# Solana module — architecture (design record, 2026-09-12; program and keeper built and proven on localnet the same day)

What the Solana module is, account by account and instruction by instruction, before a line of handler code
exists. Every number here comes from `VERIFIED-SOLANA-FACTS.md` (read live 2026-09-12) or from
`packages/shared`; anything labelled **decision** is the founder's to make and is collected in §12. The Base
module's design (`ARCHITECTURE.md`) is the reference for every choice below: where the Solana design departs from
it, the departure and its reason are stated.

**Status (2026-09-12, night).** The founder read this document, decided §12, installed the toolchain and
started the localnet; the gate on handlers is lifted. **Built and proven on localnet (26/26):** every owner
instruction in §3 and `keeper_protect`, the ladder walked by the Scope mock (repay-only at HF 1.30, the
sale path at HF 1.17), and the **keeper process** (§5, `agent/src/solana/`): discovery by program-account scan,
valuation from one simulated refresh, the repay-only plan from the Account's idle USDC and the funded sale inside
Kamino's cap, the signed transaction landing, the delegated ZEC collected, observe-only refusing by name
(`solana/tests/keeper.spec.ts`, 5). **Cannot be built:** `release_obligation` (§3, §12 (3)). **Not yet
built:** the pool-size gate (§7), the web flow (§8); nothing is deployed and no keeper runs anywhere. Three facts
the program run established and the code now embodies: klend marks a reserve stale after every state change, so
a post-action health view refreshes the reserves again before the obligation; klend **closes an obligation a
full withdraw empties** (rent back to the Account PDA), so `deposit` re-creates it on the same PDA; and on this
market Kamino's own 40 % LTV cap binds before Oilskin's 1.55 floor on both `borrow` and `withdraw` (HF at the
cap is 1.625), which makes the floors defense in depth — proven by host unit tests, not by the venue. One fact
the keeper run added: the same cap binds a **sale** too — collateral cannot leave above 40 % LTV, so a sale that
repays and releases in one instruction lands the position at HF 1.625, above every disarm level; the keeper
sizes the sale to whichever of the two (our disarm level, Kamino's cap) needs more ZEC, and says which.

Abbreviations: HF = health factor; LT = liquidation threshold; LTV = loan-to-value; PDA = program-derived address
(an account controlled by a program rather than a key); CPI = cross-program invocation (one Solana program
calling another); ATA = associated token account (the canonical token account for a wallet and a mint); SPL =
Solana Program Library (the token standard); CU = compute units (Solana's gas); APR = annual percentage rate;
TWAP = time-weighted average price; RPC = remote procedure call; MPC = multi-party computation.

## 0 · What it is, and what it is not

It is the Solana twin of `OilskinAccount` + its keeper grant: a **program-owned Kamino obligation** whose
authority is a PDA the user's wallet owns, so that (a) the user, and only the user, can deposit, borrow, repay,
withdraw and leave, and (b) a keeper the user delegated can act *inside the ladder's rungs only*, with amounts
bounded per period, revocable in one transaction. The venue is Kamino Lend's **ZCASH market**; the collateral is
**bridged ZEC** (NEAR Intents / OmniBridge); the debt is **USDC**.

It is **borrow-and-hold**. There is no liquidity-provision leg on Solana: no Aerodrome, no Snuggle engine, and
nothing modelled for Orca / Meteora (`DIRECTION-2026-09-11.md` §2). The yield gate does not apply; the
**pool-size gate** (§7) does. A loan never crosses a chain.

It is **not a port**. Solidity clones with `exec(target, data)` passthroughs do not map onto Solana, where every
instruction names its accounts and the program must know each CPI it makes. The consequence is stated in §3: the
program exposes a *typed* instruction for every Kamino operation the user needs, and the "user can always leave"
guarantee (`FLOWS.md` §8) is delivered by two always-available owner instructions rather than by a generic call.

## 1 · The shape

```mermaid
flowchart LR
    subgraph User
        W[Wallet<br/>Phantom · Solflare · Backpack · Ledger]
        UI[web/ Next.js<br/>Simple ⇄ Advanced · one decision per screen]
    end

    subgraph Sol["Solana mainnet — Oilskin program (Anchor)"]
        P[oilskin program<br/>typed owner instructions · keeper_protect<br/>ladder constants generated from packages/shared]
        A[(Account PDA<br/>seeds account · wallet<br/>owner = wallet, immutable)]
        G[(Grant PDA<br/>seeds grant · account · keeper<br/>expiry · epoch · per-period budgets · rung mask)]
        TA[(Account ATAs<br/>ZEC · USDC, owner = Account PDA)]
    end

    subgraph Kamino["Kamino Lend — ZCASH market GBJ3…Eowd"]
        UM[(UserMetadata PDA<br/>user_meta · Account PDA)]
        OB[(Obligation PDA<br/>owner = Account PDA)]
        RZ[ZEC reserve 6e8X…<br/>LTV 40 · LT 65 · cap 13,000]
        RU[USDC reserve EW9v…<br/>curve · $2 M limit]
        SC[Scope OraclePrices 3t4J…<br/>430 MostRecentOf Pyth Lazer + Chainlink]
    end

    subgraph Off["Off-chain"]
        K[agent/ keeper<br/>discover · value fail-closed · ladder · keeper_protect · notify]
        Y[services/yield<br/>Kamino reserve reader · pool-size gate]
    end

    W -- signs --> UI
    UI -- "init_account · deposit · borrow · repay · withdraw · grant · revoke" --> P
    P -- "invoke_signed (Account PDA)" --> A
    A --> TA
    P -- "CPI: initUserMetadata · initObligation · deposit… · borrow… · repay… · withdraw…" --> OB & UM
    P -- "CPI: refreshReserve → refreshObligation (same tx)" --> RZ & RU
    RZ & RU -- "price chain 430 / 13" --> SC
    K -- "getProgramAccounts (Account PDAs) · obligation · Scope 430/429 · independent price" --> P & OB & SC
    K -- "keeper_protect(rung, amounts)" --> P
    P -- "grant checks + HF on chain" --> G
    UI -- "/v1/solana/gate" --> Y
    Y -- "getAccountInfo (USDC reserve · ZEC reserve · Scope)" --> RU & RZ & SC
```

Two facts about the shape carry over from Base unchanged, and one is new:

1. **The entry floor lives where the debt is created.** `borrow` and `withdraw` in the Oilskin program enforce
   HF ≥ `ENTRY_HF_FLOOR` after the operation (Kamino's own LTV check runs too; ours is stricter). No sequence
   through the program can open debt below the floor. The twin of `AaveV3Venue.borrow` → `EntryHfTooLow`.
2. **The keeper's whole surface is one instruction** (`keeper_protect`), the twin of "one root
   `StrategyRouter.unwind` per pool" — and the web asks the user to sign a `grant` whose shape the keeper's own
   test pins.
3. **New: the ladder is in the program, not only in the keeper.** `keeper_protect` refuses to act unless the
   refreshed on-chain HF is below the rung the keeper names, and refuses to "succeed" unless the action lifted
   HF to the rung's disarm level or exhausted its budget. On Base the rung is decided off-chain and the grant
   bounds only *amounts*; on Solana the chain also checks the *reason*. This is possible because Kamino's
   `refreshObligation` gives the program the venue's own HF inputs inside the same transaction.

## 2 · Accounts (all PDAs of the Oilskin program unless stated)

| Account | Seeds | Fields | Who can change it |
|---|---|---|---|
| **Account** | `["account", wallet]` | `owner` (wallet, set once), `bump`, `grant_epoch: u64`, `obligation`, `created_slot`, `version: u8`, reserved | owner-only instructions; `grant_epoch` bumps on `revoke_all` |
| **Grant** | `["grant", account, keeper]` | `keeper`, `expiry_ts`, `epoch` (must equal `account.grant_epoch` to be live), `period_secs`, `period_start_ts`, `repay_usdc_per_period`, `repay_usdc_spent`, `sell_zec_per_period` (0 = the keeper may never sell collateral), `sell_zec_spent`, `max_sell_slippage_bps`, `allowed_rungs: u8` (bitmask over ladder ids), `bump` | owner: `grant` (create/overwrite), `revoke`; owner: `revoke_all` kills every grant at once |
| Account ATAs | canonical ATA(Account PDA, mint) for ZEC and USDC | SPL token accounts | only the Account PDA signs transfers out, only via owner instructions |
| Kamino **UserMetadata** | `["user_meta", account]` under klend | Kamino's | created once by `init_account` via CPI |
| Kamino **Obligation** | `[tag=0, id=0, owner=account, lending_market, seed1=default, seed2=default]` under klend | Kamino's; `owner` = Account PDA | every mutation is a CPI signed with the Account PDA's seeds |

Rules that carry over from `OilskinAccount`:

- **The owner is immutable.** No transfer-ownership instruction. A lost wallet is a lost account, as on Base.
- **No admin, no fee logic in the account.** The program has no global config account in v1; the ladder and
  the entry rule are compile-time constants generated from `packages/shared` (§6). Changing a rung is a program
  upgrade, which is visible on chain and governed by the policy in §12 (2).
- **Per-call context does not survive the transaction.** Solana has no reentrancy across a transaction boundary
  in the EVM sense, and a CPI cannot re-enter the caller with the same signer (the runtime refuses program
  reentrancy except for self-recursion, which the program does not use). No transient-storage twin is needed.
- **Budgets are charged from instruction arguments, never balance snapshots** — the twin of "calldata amounts,
  never balances": `keeper_protect` charges `repay_usdc` and `sell_zec` from its arguments before any CPI. The
  cToken/liquidity exchange rate that Kamino applies on withdraw is not a rebasing surprise for the budget
  because the budget is in ZEC liquidity units the instruction names.

What is different, and why:

- **USDC has a freeze authority on Solana** (`7dGbd2…Crar`, Circle). A frozen Account ATA cannot repay from idle
  USDC; the ladder's fallback is collateral sale if the grant allows it (§12 (1)). Copy states it.
- **The obligation belongs to the PDA, not the wallet**, so Kamino's own UI will not show the position as the
  user's. The Oilskin dashboard is the user's view; §3 "release" is the exit hatch that hands the obligation to
  the wallet if the founder decides to offer it.

## 3 · Instruction set

Every owner instruction requires `signer == account.owner`. Every instruction that touches the obligation runs
Kamino's `refreshReserve` (ZEC, USDC) and `refreshObligation` CPIs **first, in the same transaction**, so the HF
the program checks is the HF Kamino would liquidate against at that slot.

### Owner

| Instruction | Args | What it does | Floor / guard |
|---|---|---|---|
| `init_account` | — | creates the Account PDA and its two ATAs; CPI `initUserMetadata` and `initObligation` (tag 0, id 0) with the Account PDA as `obligationOwner` via `invoke_signed` | idempotent by PDA existence; refuses a wallet that is itself a PDA |
| `deposit` | `amount_zec: u64` | wallet ATA → Account ATA; CPI `depositReserveLiquidityAndObligationCollateralV2` | Kamino's deposit limit and 24-h withdrawal cap apply; nothing to add |
| `borrow` | `amount_usdc: u64` | CPI `borrowObligationLiquidityV2` to the Account USDC ATA | **after the borrow: HF ≥ ENTRY_HF_FLOOR (1.55) and LTV ≤ min(MAX_OFFERED_LTV_CAP 50 %, reserve LTV 40 %)** — today that is 40 % and HF 1.625 at the top preset |
| `repay` | `amount_usdc: u64` or `u64::MAX` | CPI `repayObligationLiquidityV2` from the Account USDC ATA | — |
| `withdraw` | `collateral_amount: u64` (cToken units) or `u64::MAX` | CPI `withdrawObligationCollateralAndRedeemReserveCollateralV2` to the Account ZEC ATA. `u64::MAX` withdraws **the most Kamino allows** (everything when there is no debt, and then klend closes the emptied obligation) | **after the withdraw: HF ≥ ENTRY_HF_FLOOR unless debt ≤ LOAN_DUST_UNITS** (the twin of the router's exit floor and slice C's one dust threshold) |
| `transfer_out` | `mint, amount: u64` | Account ATA → wallet ATA | owner-only; this plus `repay`/`withdraw` is the always-exit path — no grant, no keeper, no Oilskin off-chain component needed |
| `close_position` | `min_zec_out: u64` | `repay(MAX)` then `withdraw(MAX)` in one instruction; the "unwind" | refuses if the Account USDC ATA cannot cover the debt (the user tops up first) |
| `grant` | `keeper, expiry_ts, period_secs, repay_usdc_per_period, sell_zec_per_period, max_sell_slippage_bps, allowed_rungs` | creates or overwrites the Grant; **a re-grant inside a live period carries spend forward** (Base's rule) | refuses `expiry ≤ now`, `period == 0`, an empty rung mask, a zero repay budget, slippage > 500 bps |
| `revoke` | `keeper` | kills that Grant (`expiry = 0`); refuses a Grant that never existed, so a watcher can tell a kill switch from a no-op | — |
| `revoke_all` | — | `account.grant_epoch += 1`: every Grant issued before is dead | — |
| ~~`release_obligation`~~ — **impossible on klend** (verified 2026-09-12) | — | klend's ownership transfer is initiate → **approve by Kamino's global admin** → accept, and its `ownership_transfer_execution_context_checks` refuse the instruction when invoked by CPI or when the transaction carries anything but compute-budget instructions. A PDA can only sign by CPI, so an Account-owned obligation can never be handed to a wallet. The exit hatch is `close_position` + `transfer_out`: no keeper, no grant, no Oilskin off-chain component, only the program being deployed | — |

### Keeper — one instruction (built 2026-09-12)

`keeper_protect { rung_id: u8, repay_usdc: u64, sell_zec: u64 }`, signer = `grant.keeper`.

**Why it repays first and never swaps.** Kamino refuses to release collateral while the obligation's LTV is
above the reserve's cap (`WithdrawTooLarge`), which is exactly the state the ladder acts in — so "withdraw,
sell, repay" cannot exist on this venue, and neither can an in-program swap of collateral. The order is
**repay first, then release what the repayment earned**: the keeper puts `repay_usdc` into the Account's USDC
token account in the same transaction (its own capital, or a klend flash loan it repays after selling), the
program repays it to Kamino, withdraws `sell_zec` of collateral into the Account's ZEC token account, and
approves the keeper as SPL delegate for exactly what arrived — provided `repay_usdc` covers that ZEC at the
Scope price (entry 430) less the grant's slippage allowance. The keeper pulls the ZEC with a later
instruction and sells it wherever it likes. Collateral leaves Kamino only into the Account's own token
account, and leaves that account only under a delegation sized by a payment already received; the keeper's
margin on a sale is bounded by the allowance the owner signed (≤ 5 %). With `sell_zec = 0` the same instruction
is a plain repay from the Account's idle USDC.

Checks, in order, each a named error:

1. Grant live: `epoch == account.grant_epoch`, `now < expiry`, `rung_id` set in `allowed_rungs`.
2. Period roll: if `now ≥ period_start + period`, spent counters reset and `period_start = now` (the view the
   keeper reads applies the same roll, as `grantOf` does on Base).
3. Budgets, charged from the arguments before any CPI: `repay_usdc ≤ remaining`, `sell_zec ≤ remaining`;
   `sell_zec > 0` refused when `sell_zec_per_period == 0`.
4. Refresh: CPI `refreshReserve` ×2, `refreshObligation`; refuse if the obligation's `lastUpdate.stale` or the
   ZEC reserve's price status is not fully checked (`priceStatus` bits, `VERIFIED-SOLANA-FACTS.md`).
5. **The rung is real:** HF (computed in §4) `< LADDER[rung_id].hf_bps`, and `rung_id` is the *most severe*
   crossed rung the grant allows (`RungNotCrossed` if healthier than named, `RungUnderstated` if a more severe
   allowed rung is crossed). `warn` is notify-only and refused (`RungIsNotifyOnly`). The ZEC reserve's price
   status must carry all six of klend's checks (`PriceNotChecked`).
6. Action: (a) repay `repay_usdc` from the Account USDC ATA (CPI), refresh; (b) if `sell_zec > 0`: withdraw
   `sell_zec` (converted to cTokens at the reserve's exchange rate, rounded up, and re-measured as the token
   account's delta), require `repay_usdc ≥ scope_price(430) × delta × (1 − max_sell_slippage_bps)`
   (`SaleBelowFloor`), then SPL-approve the keeper as delegate for the delta.
7. **Outcome check:** HF after ≥ `LADDER[rung_id].disarm_hf_bps`, **or** the repay budget is now exhausted,
   **or** (on a sale) the sell budget is — otherwise `ProtectionIneffective`: an action that changed nothing
   cannot be recorded as a success (Base's "a confirmed action that did not clear its rung re-arms it" becomes
   a chain-level refusal).
8. Event `KeeperProtected { account, keeper, rung, repaid_usdc, sold_zec, hf_before_bps, hf_after_bps }`.

What the keeper can never do, by construction: move any token to any account but the Account's own ATAs and
Kamino; change a Grant; take collateral except under a delegation the program sized against USDC it had
already repaid at the Scope price; act above the rung; act after `revoke`/`revoke_all`/expiry.

## 4 · Health on chain

After `refreshObligation`, Kamino's obligation carries `depositedValueSf`, `borrowedAssetsMarketValueSf`,
`allowedBorrowValueSf` (LTV-weighted) and `unhealthyBorrowValueSf` (LT-weighted), all in Kamino's 2^60
scaled-fraction `Fraction`. The program defines

> `HF = unhealthyBorrowValueSf / borrowedAssetsMarketValueSf` (∞ when debt is zero or dust),

which for one collateral and one debt reduces to `deposited × LT / debt` — the same definition as Base's Aave
HF, with Kamino's own price and LT, so a position Kamino would liquidate at HF < 1 is the position the ladder
sees at 1.0. Kamino's borrow factor (150 % on ZEC, 100 % on USDC) affects only borrowing *ZEC*, which this
market disables; the program still uses Kamino's field rather than recomputing, so any future parameter change
is inherited, not typed. Arithmetic is integer on the `Fraction` bits; HF is compared in basis points against the
generated constants (§6).

Fail-closed twins of Base's G-rules, for the **off-chain** keeper valuation (`agent/`): Scope entry 430 and its
two sources read directly; an independent price (Pyth Hermes ZEC/USD or a Jupiter quote) must agree within
`ORACLE_DEVIATION_BPS`; staleness is measured per source (430's two sources publish every few seconds; USDC's
13 is heartbeat-driven); reserve `priceStatus` must be all-checked; obligation `stale` must be 0; the keeper's
recomputed HF must reproduce Kamino's within rounding. Any failure → `UNKNOWN` → the ladder never runs, exactly as
on Base.

## 5 · The keeper (`agent/`) on Solana — built 2026-09-12

A sibling loop to the Base keeper, not a fork of it: the Base monitor and dispatcher (audited) are untouched;
what is pure is reused, what is chain-shaped is new under `agent/src/solana/`.

**Reused as is.** `engine/ladder.ts` (the shared HF ladder with hysteresis, shape-only), the progress watchdog
and deadline helpers, the notifier with its channels (log, owner history, webhook) and the honest
`personReached` rule, and the crash-safe store — now generic over an **id codec**: the Base store keeps
EVM addresses and 0x hashes, the Solana store keeps base58 keys and signatures, and a store file refuses to
open under the other codec (`store/keeperStore.ts`, `idCodec` in the file).

**New, file by file.**

| File | What it does | Proven by |
|---|---|---|
| `layouts.ts` | Hand-written byte layouts and encoders: `UserAccount` / `Grant` decode, klend `Obligation` / `Reserve` at the verified offsets (facts file), Scope entries, PDAs (Account, grant, obligation, market authority, ATAs), `refresh_reserve` / `refresh_obligation` / `keeper_protect` / SPL transfer encoders, anchor error names | `scripts/verify-solana-idl.mjs` (**77** checks against the committed `solana/idl/oilskin.json`, inside `npm test -w @zyo/agent`); `test/solana-layouts.test.ts` on a mainnet fixture (slot 446,506,191) |
| `reader.ts` | Discovery: `getProgramAccounts` filtered by size and the `UserAccount` discriminator (no cursor — the program's accounts are few and the scan is one call). Valuation input: **one simulated transaction** (`refresh_reserve` ZEC, `refresh_reserve` USDC, `refresh_obligation`) with the refreshed account states returned, so the keeper reads Kamino's own numbers at the current slot and never re-derives interest or prices; the Account's token balances; the grant; the block time. Independent price: Jupiter's quote on mainnet, **declared absent** on localnet | `solana/tests/keeper.spec.ts` |
| `valuation.ts` | Fail-closed rules on that snapshot — S1 obligation refreshed at the simulation slot and not stale; S2 both reserves active, the ZEC reserve's price status carrying all six klend checks; S3 Scope 430 fresh (≤ min(config, the reserve's own max age)), not future-dated, Scope 13 within 10 % of a dollar; S4 the independent price fresh and within 200 bps of Scope (required when a source is configured); S5 the HF recomputed from Scope and the LT agrees with Kamino's within 100 bps; S6 positive values. Anything else is `UNKNOWN` with the reasons named; `NO_DEBT` at or under `LOAN_DUST_UNITS` | `test/solana-layouts.test.ts`, `test/solana-monitor.test.ts` |
| `policy.ts` | The plan for a fired rung. Target `T` = the rung's disarm HF × (1 + `KEEPER_PLAN_MARGIN_BPS`). **Repay-only** when the Account's idle USDC covers `need = D − C·P·LT / T`. Otherwise a **sale**: `Y` ZEC = max of what reaches `T` and what Kamino's LTV cap needs to let the collateral out; the keeper pays `X = Y·P·(1 − d)` USDC in, `d` ≤ the grant's allowance and ≤ `KEEPER_SALE_DISCOUNT_BPS` (0 by default: fair Scope value); every clamp (grant period budgets, `KEEPER_MAX_SALE_USDC`, the keeper's balance) is applied and named. Refusals by name: no live grant, a rung the grant excludes, discount above the allowance, already above the disarm level, keeper capital short | `test/solana-policy.test.ts` |
| `dispatcher.ts` | Re-values, reads the grant, plans, builds one transaction (compute budget 1.4 M CU, the keeper's USDC transfer when a sale, `keeper_protect(rung, repay, sell)`), signs with the keeper key, **simulates** (a program refusal is classified by anchor error name: `GrantNotLive` / `RungNotAllowed` / `RungIsNotifyOnly` / `UnknownRung` permanent, `RungNotCrossed` / `RungUnderstated` superseding, the rest transient), **persists the signature before broadcast**, sends, confirms, and after a sale **collects** the delegated ZEC into the keeper's own token account in a second transaction. Observe-only dispatcher without a key: warn delivered or `LOGGED_ONLY`, every action `REFUSED` permanently by name | `solana/tests/keeper.spec.ts` |
| `monitor.ts` | The Base tick order — resume pending → head → discover/register → rotated evaluate under concurrency → prune — with the same idempotency record (`account:episode:seq:action`, on disk as `PENDING` before the dispatcher is called), UNKNOWN streaks that escalate at the configured count, the confirmed-but-ineffective re-arm bounded per rung, permanent refusals abandoned instead of retried, `SENT` confirmed on the resume path, and an aborted tick that says so | `test/solana-monitor.test.ts` (8) |
| `config.ts`, `keeper.ts`, `index.ts` | `SOLANA_RPC_URL`, `OILSKIN_SOLANA_PROGRAM_ID` (required), `SOLANA_STORE_PATH` (absolute), `KEEPER_SOLANA_KEYPAIR` (absolute path to a keypair file; **the CLI's default key is refused**; absent → observe-only, which then needs `SOLANA_SIM_PAYER`, a funded pubkey the read-only simulations name), `SOLANA_PRICE_SOURCE` `jupiter` \| `scope-only` (the latter logs a loud localnet-only warning), the freshness/deviation/tolerance knobs, `KEEPER_MAX_SALE_USDC` (0 = never sells), `KEEPER_SALE_DISCOUNT_BPS`, `KEEPER_PLAN_MARGIN_BPS`, the poll/deadline/watchdog/notify timings, `NOTIFY_WEBHOOK_URL`. `runSolanaKeeper(env, opts)` wires it and runs the loop with the Base shutdown pattern; `npm run dev:solana -w @zyo/agent` | `solana/tests/keeper.spec.ts` runs it in-process with `maxTicks` |

**What the localnet run proved (2026-09-12, `keeper.spec.ts`).** At $1,000 the top-preset position values at
HF 1.629 and nothing fires. At $800 (HF 1.30) repay fires; the plan is repay-only, 294.19 USDC of the Account's
idle USDC for an expected HF 1.4070 (the disarm level plus the 50 bps margin); the transaction lands, the grant's
`repayUsdcSpent` equals the USDC that left the Account, the keeper's own USDC did not move, and the next tick
fires nothing. With the idle USDC transferred out and the price at $660 (HF 1.16), de-risk fires; the keeper
pays USDC in at fair Scope value, the program repays it and releases ZEC inside Kamino's 40 % cap, every USDC
paid reduced the debt, the released ZEC equals the ZEC collected into the keeper's account, nothing stays
delegated, and `sellZecSpent` equals it. Observe-only on a fresh store records the next fall and refuses by
name with nothing signed. Two departures from this section's original design are now fact: plan sizing is
the analytic `need` / `Y` above, not the Base "⅓ / ⅔ of value" fractions, because Kamino's cap decides how
much collateral can leave; and the sale floor is enforced by the program from Scope, so the keeper passes
amounts, not a `min_usdc_out`.

## 6 · What is shared, and how it is consumed

| Shared source | Solana consumer | Seam that fails on drift |
|---|---|---|
| `health.ts` `ENTRY_HF_FLOOR`, `HF_LADDER`, `HF_HYSTERESIS`; `collateral.ts` `MAX_OFFERED_LTV_CAP_BPS`; `dust.ts` `LOAN_DUST_UNITS` | `solana/programs/oilskin/src/generated/ladder.rs` — u64 basis points, generated by `solana/scripts/gen-ladder.mjs` (committed, like the ABI bundle) | `solana/test/ladder-seam.test.mjs` (node:test, no toolchain; runs in CI) and `gen-ladder.mjs --check` |
| `collateral.ts` `maxOfferedLtvBps(LT)` | web and yield service compute the offer as `min(maxOfferedLtvStopBps(LT_live), reserveLtv_live)`; the program enforces the same bound in `borrow` | `packages/shared/test/solana.test.ts` pins 6500 → 4193 → 4100 → 4000 |
| `solana.ts` (new): programs, mints, the market, reserves, vaults, Scope indices, klend seeds, a dated snapshot | keeper, yield service, web, `Anchor.toml` clone list, localnet fixtures | `packages/shared/test/solana.test.ts`; the facts reader compares a fresh read against the snapshot and reports drift |
| `web/lib/copy.ts` `BANNED_WORDS`, the acronym rule, the risk list | the Solana onboarding and review copy (§8) | `web/test/copy.test.ts` (extended to the Solana surfaces) |

The keeper and the web select every address by **network**, never by a fallback: `chains.ts`'s
`SupportedChainId` (8453 | 84532) gains a sibling `SolanaCluster` ("mainnet-beta" | "localnet"); a localnet
table exists only so the harness cannot silently read mainnet.

## 7 · The pool-size gate (yield service)

Base's yield gate answers "does this pool clear the borrow rate?" Solana's question is "can this pool fund this
borrow at a rate below the threshold, without the borrower *becoming* the market?" — fail-closed, live inputs,
same shape as `gate.ts`.

New source `services/yield/src/sources/kamino.ts`: strict byte decode of the USDC reserve (available,
borrowed, total supply, curve points, borrow limit, 24-h caps, `status`, `borrowDisabled`), the ZEC reserve (LT,
LTV, deposit limit, remaining cap, oracle max ages), and Scope 430/13 (price, age). `sampledAt` only; `stale` is
serve-time. New verdict `evaluateSolanaBorrowGate({ amountUsdc, collateralZec })` with reasons added to
`GateReason`:

| Reason | Rule (today's numbers) |
|---|---|
| `venue_paused` / `borrow_disabled` | reserve status ≠ 0 or market `borrowDisabled` |
| `deposit_cap_reached` | `collateralZec` > remaining deposit limit (13,000 − 1,192 ZEC) or > remaining 24-h cap |
| `pool_depth_insufficient` | `amountUsdc` > available − reserve buffer (available $358,199) |
| *(shown, not a refusal — decision 4)* `projectedBorrowAprPct` | `kaminoCurveAprBps(curve, utilAfter)`: the rate the depositor will pay after this borrow (+$84 K takes it past Base's Aave rate today); displayed beside the amount |
| *(shown, not a refusal — decision 4)* `poolSharePct` | the account's share of the pool's debt after the borrow (one obligation is 58.8 % today) |
| `rates_stale` / `oracle_stale` | as on Base |

Served at `/v1/solana/gate`; the web refuses to offer an amount the gate refused and shows the reason in plain
words. The projection table in `VERIFIED-SOLANA-FACTS.md` is what this code recomputes live.

## 8 · The deposit flow and what it must say (web, Simple mode; Advanced adds the choices)

One decision per screen, the risk stated before the button:

1. **"Your ZEC on Solana is a bridged token."** Kamino's wording verbatim (the floor, `VERIFIED-SOLANA-FACTS.md`),
   then Oilskin's three additions in plain words: the bridge program can be upgraded by its operators and is
   the only thing that mints this ZEC; Circle can freeze USDC; Kamino's market owner can change every parameter
   (LTV, threshold, caps, rate curve) at any time. Link to `RISKS.md` §22 and `PRIVACY.md` §6.
2. **Amount**, with the pool-size gate's verdict live ("this pool can fund up to $X today below the rate we
   publish").
3. **LTV preset** — 30 % / 40 % / Top, where Top = 40 % today (shared rule 41 %, Kamino's cap 40 %); entry HF
   and the drop-to-liquidation shown from live LT, never typed.
4. **Protection grant** — what the keeper may do, in the words of §3: repay from idle USDC up to N per day;
   **sell up to M ZEC per day to stop a liquidation** (on by default — decision 1; Advanced mode can set M to
   zero); never move funds anywhere else; you can cancel in one transaction.
5. **Review** — the risk list (§9 items), the exact instruction the wallet will sign, the account address.

Copy rules: `BANNED_WORDS` apply ("private", "shielded", "non-custodial", …); "self-custodial" is not claimed
for a bridged asset; acronyms spelled out on first use.

## 9 · Risks specific to this module (for `RISKS.md` §22 and `web/lib/copy.ts`)

1. **Bridge trust path.** Zcash → NEAR (OmniBridge, MPC/TSS custody of the locked ZEC) → Wormhole messaging →
   the Solana bridge program `dahP…CPxe`, whose PDA `["authority"]` is the only minter. Upgradeable by
   `5kx8…Web6` (a PDA; controller not identified).
2. **No shielded privacy** on Solana; the entry from Zcash is transparent at the bridge's deposit address
   (`INFRA-2026-09.md` on NEAR Intents' t-address deposits).
3. **Kamino market owner powers.** `A11E…zMeR` can change LTV/LT/caps/curve/oracle instantly; no timelock is
   visible on chain. Kamino, Scope and Farms are all upgradeable.
4. **Pool depth and concentration.** $358 K borrowable; one borrower is 59 % of the debt; a liquidation of that
   one obligation is a $260 K sale.
5. **Liquidation depth.** $4.5 M across 30 pools; a 400 ZEC sale moves price 0.56 % today; Kamino's bonus 2–7 %
   plus a 50 % protocol cut of it.
6. **Oracle.** MostRecentOf(Pyth Lazer, Chainlink) with a 15 % divergence gate and a two-hour source age;
   reserve max age 180 s; heuristic band $400–$2,000 — a ZEC price outside the band halts the reserve.
7. **USDC freeze authority.**
8. **Keeper dependence** (Base §10 applies) and, new, **compute budget**: a `keeper_protect` with a sale may not
   fit one transaction (§11 measures it).
9. **Oilskin's own program upgradeability** (§12 (2)).
10. **Solana-specific chain risk:** priority-fee spikes during a crash delay the keeper; RPC provider dependence.

## 10 · Audit

A Solana program is audited by different firms than Solidity: **OtterSec, Neodyme, Zellic, Sec3** (and Certora
for formal specs) are the names the founder should request quotes from. Scope of the audit: PDA seed collisions
and bump handling; `invoke_signed` seed exposure; every Kamino CPI's account list (a wrong `lendingMarketAuthority`
or vault is a fund-loss bug); HF math against Kamino's `Fraction`; grant budget parsing and period roll; the
outcome check in `keeper_protect`; the swap floor; the exit hatches; the upgrade authority. Out of scope: Kamino,
Scope, the bridge — third-party code we call, not audit (as `AUDIT-SCOPE.md` says of Aave and the engine).

## 11 · Test plan (localnet; there is no devnet ZCASH market)

`solana/scripts/localnet.sh` starts `solana-test-validator` with the mainnet programs cloned as upgradeable
programs (klend, Scope, Farms) and the accounts cloned (the market, both reserves, their four vaults, the two
cToken mints and vaults, Scope `OraclePrices` + `OracleMappings` + configuration, the ZEC and USDC mints), all
from `SOLANA_TOKENS` / `KAMINO_ZCASH_MARKET` in shared. Two fixtures make it usable:

- **Scope prices go stale in 180 s, and a future-dated timestamp is refused** (verified 2026-09-12: klend
  computes the age with a checked subtraction and returns `MathOverflow`). So the harness loads
  `programs/mock_scope` — LOCALNET ONLY — **at Scope's own program id**; the cloned `OraclePrices` account
  (owner = that id) becomes writable, and the tests stamp entries 430, 429, 13 and 456 with the validator's
  clock before every Kamino-touching call (`stamp_fresh`) and move the ZEC spot and TWAP together
  (`set_price`) to walk the ladder. Kamino never CPIs into Scope, so nothing else changes.
- **The validator must start above mainnet's slot** (`--warp-slot`): klend's `slots_elapsed` is
  `current − last_update.slot` with a checked subtraction, and the cloned reserves carry mainnet slot numbers.
- **ZEC and USDC cannot be minted locally** (the ZEC authority is the bridge's PDA, USDC's is Circle's): the
  fixture rewrites both mints' authorities to test keypairs generated by the harness at run time (never
  committed); USDC minting lets a test cover the interest a full repay needs.

**As run (2026-09-12, 26 passing in 24 s under `anchor test --skip-local-validator`):** `localnet.spec.ts` 4 (the
world), `owner-path.spec.ts` 11, `ladder.spec.ts` 6 (the program's `keeper_protect` at every rung), and
`keeper.spec.ts` 5 — the keeper **agent** itself (§5), run in-process against the same world with a throwaway
keeper key generated under `fixtures/`. The specs time the grant by the **chain** clock (`getBlockTime`), never
the host's: a warped validator runs hours ahead of the wall clock, and the keeper's freshness rules compare
chain time with chain time.

Scenarios as planned, mirroring `contracts/test`: init → deposit → borrow at 40 % (HF 1.625) → refuse a borrow at 45 % →
price fixture −8 % → `keeper_protect(warn)` refused (warn is notify-only, no budget) → −17 % → `repay` lifts to
1.40 → −27 % → `derisk` → revoke → keeper refused by name → owner `close_position` → `transfer_out`. Property
tests (Rust, `proptest`): the keeper never exceeds the grant under random sequences; the owner can always exit;
HF after any owner instruction ≥ floor or debt is dust. CU is metered per instruction and recorded in
`TESTING.md`; if `keeper_protect` with a sale exceeds the limit, §12 (1)'s two-instruction variant is taken.

## 12 · Decisions for the founder — DECIDED 2026-09-12

The founder answered all seven on 2026-09-12 after reading this document; the build proceeds on these.

| # | Decision | What it changes below and in the code |
|---|---|---|
| 1 | **Yes — the keeper may sell collateral to repay when liquidation threatens**, to prevent liquidation of the whole position. | Built as "repay first, then release what the repayment earned" (§3), because Kamino will not release collateral while LTV is above its cap. The keeper funds the repayment (its capital or a flash loan) and receives ZEC at the Scope price less the grant's allowance; per-period USDC and ZEC caps and the outcome check bound it. The Simple-mode grant enables it by default; the pre-sign copy says "may repay with its own USDC and take up to M ZEC per day at the oracle price, less at most s %, to stop a liquidation". |
| 2 | **Squads multisig** holds the program's upgrade authority. | Deploy hands the authority to a Squads v4 multisig with a published delay and a watcher; until that handover the deployer key holds it and the copy says so (`RISKS.md` §22). |
| 3 | **Yes** — `release_obligation` exists. | **Cannot be built (verified 2026-09-12):** klend's transfer needs Kamino's global admin to approve it and refuses the initiate step under CPI or with any companion instruction, so a PDA-owned obligation is untransferable. The exit hatch is `close_position` + `transfer_out`, which need nothing from Oilskin but the deployed program. The founder's intent — the user can always leave alone — is met by those two. |
| 4 | **The depositor decides.** Oilskin shows what the borrow rate will be; it does not refuse on rate. | §7's gate refuses only what cannot be funded (`pool_depth_insufficient`, `deposit_cap_reached`, `venue_paused`, staleness); the projected borrow APR after the borrow and the market's concentration are **shown**, never a refusal. Founder's framing: once ZEC can be bridged to Solana and borrowed against there, this is the best Solana-native option. |
| 5 | **No performance fees yet.** | No fee logic in the program or the flow. |
| 6 | Free RPC while building. | Localnet needs none; the public `api.mainnet-beta.solana.com` serves the readers and the clone; a free keyed tier (Helius, QuickNode, Alchemy) goes into `.env` as `SOLANA_RPC_URL` when the keeper needs `getProgramAccounts` reliability. |
| 7 | **One audit, both modules together.** | `AUDIT-SCOPE.md` will list `solana/` alongside `contracts/` when the Solana module reaches parity; the RFP names an EVM firm and a Solana firm, or one that does both. |

The original questions, kept for the record:

1. **May the keeper sell collateral to repay?** Base never withdraws collateral in a keeper plan because USDC
   comes from closing LP. On Solana a hold position has no USDC source but (a) idle USDC the user left in the
   account and (b) a sale of ZEC. Options: *sale off* (the ladder repays only from idle USDC; a user who
   withdrew the USDC is protected only by warnings — the copy must say so); *sale on, bounded* (per-period ZEC
   cap, Scope-priced floor, ≤ 5 % slippage, only at repay/derisk/emergency). Recommendation: **sale on, bounded,
   off by default in Simple mode with a one-sentence opt-in**, because the product is named for the ladder
   acting. Sub-decision if on: in-instruction Jupiter CPI (one tx, CU risk) vs a two-instruction session.
2. **Program upgrade authority.** Solana programs are upgradeable unless the authority is set to none. Options:
   burn after audit (a bug is then permanent, fixed by a new program and migration); or a Squads multisig with
   a published delay and a watcher (the registry-owner shape of `RISKS.md` §16). Copy cannot say "no operator
   powers" under either until the delay is real and announced.
3. **Exit hatch shape.** `close_position` + `transfer_out` always work and need no Oilskin off-chain
   component. Should `release_obligation` (hand the Kamino obligation to the wallet) also exist? It is the
   stronger guarantee but depends on klend's ownership-transfer instructions accepting a PDA initiator (not
   verified).
4. **Pool-size threshold.** "Refuse a borrow priced above Base's live Aave USDC rate" (today +$84 K), or a fixed
   published APR, or a utilisation ceiling (e.g. never above the 90 % kink → +$278 K)? And a concentration cap.
5. **Fees.** There is no LP yield on Solana, hence no performance fee. Nothing in v1, or a small fixed fee on
   `borrow`? Nothing is the honest default until the value is proven.
6. **Keeper key and RPC.** A paid RPC (Helius / Triton / QuickNode) is needed for `getProgramAccounts` and
   priority-fee estimation; the keeper key's custody follows the Base rule (never in a Claude session, never in
   `.env` read by tooling).
7. **Audit firm and budget** (§10), and whether the Solana audit is sequenced after the Base audit or in parallel
   (the direction memo's cost statement stands).

## 13 · Not in this design

The LP leg on Solana (Orca / Meteora / Raydium — not modelled, not gated); moving USDC between chains (CCTP —
a different product); the "lite" notify-only variant (rejected); Kamino Multiply (Kamino's own loop product —
Oilskin's difference is the ladder, not the primitive); elevation groups (none active on this market);
Kamino obligation orders (disabled on this market).
