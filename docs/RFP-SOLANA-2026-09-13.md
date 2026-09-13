# Request for proposal — security audit, Oilskin **Solana module** (Anchor / Rust)

Prepared 2026-09-13. Every number is measured from the tree at the hash in §1. Where a figure is the founder's
to decide rather than the code's to report, it is left blank and marked.

Abbreviations: LOC = lines of code; HF = health factor; LTV = loan-to-value; PDA = program-derived address;
ATA = associated token account; CCTP = Circle's Cross-Chain Transfer Protocol; CPI = cross-program invocation.

## 1 · What you would audit, and at which commit

**Repository:** `mbrobert/ZEC-Defi-App` (private; read access provided on NDA).
**Measured at:** `e1d57a49fde396a1c56d186af7ebc2bf90e521b3`, 2026-09-13.
**Audit target:** the freeze commit, **tagged `beta-audit-1`**, expected **2026-12-11**. This package is an
inquiry against today's tree so scope and price can be agreed before the freeze.

| Area | Size | Notes |
|---|---|---|
| `solana/programs/oilskin/src` | **2,592 lines** Rust, Anchor 1.2.0 | 141 of those lines are generated from `packages/shared` and pinned by seam tests — read them, but they are not hand-written |
| `solana/tests` | 4 localnet specs | 36 passing against a validator with Kamino's ZCASH market and Circle's CCTP V2 programs cloned from mainnet |
| `agent/src/solana` | part of 10,993 lines TypeScript | The keeper's Solana path: in scope for *what the delegation permits*, not as application code |

The program is **not deployed**. Its upgrade authority will be handed to a Squads v4 multisig at deploy
(`docs/SOLANA-DEPLOY.md`); until then the deployer key holds it and our copy says so.

**Not in this RFP:** the Base module (Solidity), which is the subject of a parallel RFP. If you audit both
chains to the same standard, say so in §6 question 5 — we would prefer one firm and one report.

## 2 · What to read, in this order

1. `docs/SOLANA-ARCHITECTURE.md` — the design, including §14, the cross-chain addendum.
2. `docs/VERIFIED-SOLANA-FACTS.md` — every program, account, offset and parameter, read from mainnet and
   dated, with four addenda. Nothing in the program is typed from memory; this document is why.
3. `docs/CROSSCHAIN-RUNBOOK-2026-09-13.md` — the five-step cross-chain rung and every way it fails.
4. `docs/AUDIT-2026-09-13.md` — our own adversarial pass over this code, with two fixes and six observations.
5. `CLAUDE.md`, `docs/BUILD-PLAN-2026-09-12.md`, `docs/RISKS.md`.

## 3 · The trust model in one page

- **The user's Account** is a PDA seeded by their wallet (`["account", wallet]`). The owner is set once by
  `init_account` and never changes. It owns a Kamino obligation on the ZCASH market.
- **The exit is always through the program.** Kamino refuses to hand a program-owned obligation to a wallet
  (verified, not assumed — `release_obligation` *cannot* be built), so `repay`, `withdraw`, `transfer_out` and
  `close_position` are the exit, and all are owner-only with no keeper and no off-chain component.
- **The keeper's whole surface is one instruction**, `keeper_protect`, inside a `Grant` PDA the owner creates
  and can revoke individually or all at once by an epoch bump. The grant bounds per-period USDC repaid and ZEC
  sold, a slippage allowance, an expiry, and a bitmask of which ladder rungs may be acted on. Collateral leaves
  the obligation only into the Account's own token account, and leaves that only under an SPL delegation sized
  by a payment already received at Kamino's own oracle price.
- **Whoever holds the program's upgrade authority can change all of the above.** That is a deployer key until
  the Squads hand-over, and the multisig afterwards. Our copy says so in those words.
- **Third parties we depend on and do not control:** Kamino (klend), Scope (its oracle), the ZEC bridge
  program and Wormhole, Circle (USDC issuer, CCTP programs and the attester set).

## 4 · Invariants we already assert, and the ones we want attacked

Asserted on localnet against the cloned mainnet world, plus host unit tests:

- A borrow is refused unless the refreshed HF is at or above the entry floor **and** the LTV is at or under
  the reserve's own cap; both are read from Kamino at call time, never typed.
- `keeper_protect` charges the grant's budgets from the instruction's arguments **before** any CPI; refuses a
  rung that is not the most severe crossed rung the grant allows; and refuses an action that neither reached
  the rung's disarm level nor exhausted a budget.
- The ladder a position is judged against is derived from the entry HF recorded at its own borrow, in integer
  arithmetic that the seam test proves equals the TypeScript rule at every entry from 1.10 to 5.00.
- `deposit_for_burn` refuses a burn that would leave the Account under the reserve its live debt requires, and
  can only pay the Base account the owner recorded.

**Please attack these specifically:**

1. Any way to make `keeper_protect` act when no rung is crossed, or act twice for one crossing, or take more
   collateral than the USDC paid in covers at the oracle price.
2. Account substitution anywhere: a Kamino account, a Scope feed, or a CCTP account that is not the one the
   generated constants name. Every one is checked by address — we want to know if any check is missable.
3. The obligation lifecycle: klend closes an emptied obligation, and several instructions must behave when the
   account is gone rather than merely empty.
4. The reserve rule: any path that leaves an Account able to burn its USDC to Base while its Solana debt
   depends on that USDC.
5. The CCTP CPI: the account list, the signing seeds, and whether a malicious `message_sent_event_data` or
   denylist account can change the outcome.
6. Arithmetic: Kamino's scaled fractions (2^60), the cToken exchange-rate rounding, and the integer ladder.

## 5 · Launch parameters — **the founder to complete before kickoff**

- Deposit cap at launch: **\_\_\_**
- Allowlist size at launch: **\_\_\_**
- Day-one funds at risk: **\_\_\_**
- Note for sizing: Kamino's ZCASH market held ≈ 355,600 USDC available and ≈ 1,202 ZEC supplied when last
  read; one borrower is 59 % of its debt. The market's own depth, not our cap alone, bounds the product.

## 6 · The six questions (asked identically of every firm, so that quotes compare)

1. **Earliest kickoff date** you could commit to, assuming a signed engagement within two weeks of your reply.
2. **Review length** in calendar weeks for the scope in §1, and how many engineers.
3. **Fix-review window**: is a re-review of our fixes included, and for how long after delivery?
4. **Price**, as a range against the scope in §1, and what would move it.
5. Do you audit **EVM (Solidity)** to the same standard? If so, quote both modules together as well as
   separately.
6. Will you **publish the report**, and may we publish it before launch?

## 7 · Practical notes

- Every suite is green at the hash in §1: the program's host unit tests **12**; the seam tests **14** (the
  generated ladder and address constants must equal `packages/shared`, which is itself pinned to the facts
  document); localnet **36 passing / 0 failing**; the keeper **311** with an IDL seam of **77** checks pinning
  its hand-written encoders to the committed IDL.
- `solana/SETUP.md` and `solana/scripts/localnet.sh` build the world from clean: the validator clones Kamino,
  Scope, the ZEC mint and Circle's two CCTP programs from mainnet, with Scope replaced by a local mock so
  prices can be walked. **There is no devnet ZCASH market**, which is why the localnet clone exists.
- **What we have not proven, and will say so to any firm:** nothing has crossed a chain for real. The burn is
  proven against Circle's cloned program; the delivery is proven up to Circle's signature check, which is as
  far as a localnet can go without Circle's attester keys.
- **Contact:** the founder, `founder@joule-solutions.com`.
