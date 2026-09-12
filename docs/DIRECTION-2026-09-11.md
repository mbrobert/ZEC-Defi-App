# Direction record — chain-agnostic, ZEC-holder-centric (2026-09-11)

**Founder's call (verbatim intent):** Oilskin is chain agnostic and ZEC customer
centric. Wherever a market for ZEC exists, a ZEC holder should be able to deploy
their ZEC there through Oilskin.

This file records what that means for the codebase, what it costs, and the one
sequencing decision it forces. Numbers are from
`docs/research/SOLANA-ZEC-KAMINO-2026-09.md` (read live 2026-09-11) and
`docs/VERIFIED-BASE-FACTS.md`. Abbreviations: LTV = loan-to-value; LP = liquidity
provision; PDA = program-derived address (Solana's contract-owned account);
CCTP = Circle's Cross-Chain Transfer Protocol; MPC = multi-party computation.

## 1 · What "chain agnostic" means here, precisely

The *product* is chain-agnostic. The *code* is not, and cannot be made so with
one abstraction — Base is an EVM chain (Solidity, clone accounts, viem), Solana
is not (Rust/Anchor programs, PDAs, SPL tokens, different signing). What
survives across chains and what has to be built per chain:

| Shared (one copy, every chain) | Per chain (a sibling module, not a port) |
|---|---|
| The thesis and the Simple ⇄ Advanced UX shell (`web/`) | The user's own account container — `OilskinAccount` on Base; an Anchor program + PDA on Solana |
| Health ladder policy: entry 1.55, warn 1.50 / repay 1.35 / derisk 1.20 / emergency 1.05, +0.05 hysteresis (`packages/shared`) | Venue adapters — `AaveV3Venue` / `SnuggleLpVenue` on Base; a Kamino adapter (and an Orca / Meteora adapter if LP) on Solana |
| Yield gate math — closed form + Monte-Carlo, two-model rule (`services/yield/src/model.ts`, `mc-calibration.ts`) | Gate *inputs* — gauge emissions, borrow rates, oracles are read per chain |
| Entry rule `maxOfferedLtv = min(50 %, LT / 1.55)` | The registry that holds per-venue LT/LTV and the timelock (`CollateralRegistry` on Base; program config on Solana) |
| Honest-copy rules, banned words, acronym rule, the audit method | The keeper's read + act path — viem on Base; Solana web3 on Solana |
| Docs, RISKS ledger, deposit-flow charts | The audit itself — Solana programs are audited by different firms (OtterSec, Neodyme, Zellic, Sec3) |

So the honest engineering translation is: **a multi-chain product with per-chain
venue modules under one UX and one policy layer.** The `contracts/` + `agent/`
work on Base is not wasted by this — it becomes "the Base module".

## 2 · Where a ZEC holder can actually go today (2026-09-11)

| | Base | Solana |
|---|---|---|
| ZEC as collateral | **No** — cbZEC registered, disabled; no lending market lists it | **Yes** — Kamino ZCASH market: LTV 40 %, LT 65 %, cap 13,000 ZEC, 1,022 deposited |
| USDC to borrow | $183 M pool, 4.51 % APR, a $1 M borrow moves nothing | $802 K pool, **$413 K left to borrow**, 2.78 % APY now → 7 % at +$300 K → 32 % at +$400 K |
| LP leg | Aerodrome + Snuggle engine exist — but the gate refuses every pool today (0 / 27) | No Aerodrome, no Snuggle; Orca / Meteora / Raydium exist; nothing built or modelled |
| Self-custodial entry for a ZEC holder | No — cbZEC is a Coinbase-custodied wrap behind a Coinbase account | Yes-ish — OmniBridge (NEAR MPC) bridged ZEC; mint authority is a key, no freeze authority |
| Oilskin code that exists | contracts, keeper, gate, web — 1,000+ tests green | none |

**Consequence.** Today the full loop for a ZEC holder — ZEC → USDC → LP — does
not exist on either chain alone. Borrow-only exists on Solana. The LP leg exists
only on Base and is gated off by the math. The only way to run the full loop
today is cross-chain: ZEC on Kamino → USDC over CCTP → Aerodrome on Base — the
two-chain shape rejected on 2026-09-05, rejected then for a rate reason that has
since reversed *for small size only*.

## 3 · The decision this forces: sequencing

> **Decided 2026-09-12 (founder):** build **both** the Base implementation and
> the Solana implementation, in full — option C below. The B-lite variant
> (wallet-signed, notify-only) is **rejected**: the protection ladder is an
> action on every chain Oilskin ships on, and the user experience has to be
> easy. Sections 3's other options stay as the record of what was weighed.

Three orders. Each is a scenario with its cost stated; the choice is the founder's.

**A. Base first, then Solana (the current plan, unchanged).** Ship what is built.
A ZEC holder's entry is cbZEC, which is disabled until a Base market exists —
so at launch Oilskin serves cbBTC/WETH holders and ZEC holders wait. Cost:
the "ZEC customer centric" promise is not true on day one. Fastest to a live
product; the audit already scoped.

**B. Solana borrow-only first, then Base.** Build the smallest Solana module:
connect wallet → deposit bridged ZEC into Kamino → borrow USDC → hold, with
the ladder. This is the one thing a ZEC holder can do today at decent terms.
Cost: new stack, new audit, and the pool is $413 K deep — the product would
*be* the market and would move its own rate. Kamino's own Multiply already
offers the borrow-and-loop; Oilskin's difference is the ladder, the copy, and
the hand-holding, not the primitive. Everything on Base pauses or runs in
parallel.

**C. Both at once.** Two stacks, two audits, one team of Claude Code + founder.
Cost: the launch date. Nothing in the repo today argues the team has the
bandwidth; the checklist's long pole (external audit) doubles.

There is a **B-lite** worth naming: Solana borrow-only *without* an Oilskin
program — the user's own wallet signs each Kamino instruction, Oilskin is the
guide + the notifier, no auto-protection. It ships fastest and needs no Solana
audit, but the protection ladder — the thing the whole product is named for —
is a notification, not an action. That is a different product promise and the
copy would have to say so.

## 3b · The Base–Solana bridge, read 2026-09-12 — what it does and does not solve

The founder asked why Base's own Solana bridge (`blog.base.org/base-solana-bridge`,
integrated in Aerodrome) is not the answer. Facts, then the answer.

| Fact | Value | Source |
|---|---|---|
| What it is | Base ↔ Solana message + token bridge, any SPL token → a Base ERC-20 and any Base asset → Solana | blog.base.org, docs.base.org |
| Security | Validators from Chainlink (CCIP oracle) and Coinbase independently verify; Merkle root relayed every ~300 finalized blocks | docs.base.org, blog |
| Base contracts | Bridge `0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188` · BridgeValidator `0xAF24c1c24Ff3BF1e6D882518120fC25442d6794B` · CrossChainERC20Factory `0xDD56781d0509650f8C2981231B6C917f2d5d7dF2` | docs.base.org |
| Solana programs | Bridge `HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM` · Relayer `g1et5VenhfJHJwsdJsDbxWZuotD5H4iELNG61kS4fb9` | docs.base.org |
| How a Solana token gets a Base form | Anyone calls `CrossChainERC20Factory.deploy(remoteToken, name, symbol, decimals)` — permissionless, CREATE2, no owner check | `base/src/CrossChainERC20Factory.sol` (github.com/base/bridge) |
| Time | ~15 min wait for a root update, then a prove + finalize step | github.com/base/bridge README |
| Wrappers deployed so far | **157**, mostly memecoins with 0–7 holders | factory logs, base.blockscout.com, 2026-09-12 |
| A Base wrapper for the Solana ZEC mint | **none exists** — 0 of 157 (`remoteToken` = `0x8769d3af…f213`, the ZEC mint as bytes32) | same |
| Aerodrome's role | a bridged token is an ordinary Base ERC-20, so it can sit in an Aerodrome pool — Aerodrome is where it *trades*, not where it is *lent against* | blog.base.org |

**The answer.** The bridge moves tokens; it does not create lending markets.
Oilskin's ZEC blocker on Base has never been "ZEC isn't on Base" — cbZEC has
been on Base the whole time. The blocker is that **no Base lending market lists
any ZEC**. Bridging OmniBridge ZEC to Base through this bridge would produce a
*second* ZEC on Base (Zcash → NEAR MPC → Solana → Chainlink/Coinbase validators →
Base: two bridges, two trust models, two withdrawal waits) that also has no
lending market. It fragments ZEC liquidity between cbZEC and bridged-ZEC and
adds a hop to explain to the user, without unlocking the loop.

Where it *is* useful: the reverse direction and non-collateral flows — a Base
asset out to Solana, or a bridged-ZEC/USDC pool on Aerodrome if a ZEC-paired LP
is ever wanted. For moving *USDC* between the chains, Circle's CCTP is native
USDC with no wrapper and is the better rail.

**The finding that actually unlocks ZEC on Base** (read live 2026-09-12): a
Chainlink **ZEC / USD** feed exists on Base — proxy
`0x69e5BC4988a9AF30Ec827C5609c0D41028446ec0`, 18 decimals, 24 h heartbeat,
0.5 % deviation, answer $1,158.94 at block 51,191,450 (updated 564 s earlier).
Pyth also publishes `Crypto.ZEC/USD` (id `be9b59d1…bb24`). That means a
**permissionless Morpho Blue cbZEC/USDC market on Base is oracle-feasible
today** through Morpho's Chainlink oracle factory (cbZEC priced at ZEC/USD, the
same wrapper-priced-by-underlying pattern already noted for cbBTC/BTC-USD).
What it still needs is USDC lenders and an LLTV/IRM choice — Oilskin (or the
founder's LLC) seeding the supply side is the honest description of "creating
the market". This is the Base-side ZEC path; it uses the existing
`MorphoBlueVenue` skeleton and needs no bridge at all.

## 4 · What has to be true before Solana is offered, whichever order

1. **Bridge disclosure.** Copy states, in the deposit flow, what Kamino's own
   page states: the Solana ZEC is a bridged representation via NEAR Intents /
   OmniBridge and carries none of Zcash's shielded privacy; there is a bridge
   operator in the trust path. `docs/RISKS.md` gets a section; the
   banned-words test stays.
2. **Pool-size gate.** The yield service refuses to offer a borrow the pool
   cannot fund at a rate below the venue's published threshold — the same
   fail-closed shape as the LP gate. On Kamino today that threshold is crossed
   at roughly +$200 K of new borrowing.
3. **Oracle facts recorded.** Scope index 430, `MostRecentOf`, 180 s staleness,
   $400 – $2,000 sanity band — into a Solana facts file the way
   `VERIFIED-BASE-FACTS.md` holds Base, before code depends on them.
4. **Liquidation depth stated.** ~$4 M of ZEC liquidity across Solana DEXs; a
   $400 K liquidation is ~10 % of it. Stated in RISKS, not hidden.
5. **Account model chosen** (program-owned obligation with a scoped keeper, or
   wallet-signed with notify-only) and written into `docs/ARCHITECTURE.md`
   before a line of Anchor is written.

## 5 · What changes in the existing artefacts (order chosen: both, in full)

- `README.md` and `CLAUDE.md` "What this is": from "Base-first v1" to
  "chain-agnostic, ZEC-holder-centric; Base module and Solana module" — grep
  for every "Base-first" and fix it in the same commit.
- The Atlas: a third map showing the two lanes under one policy layer
  (done 2026-09-12); the status strip carries the Solana facts.
- The checklist: a Solana track (facts file, account model, Kamino adapter,
  Solana audit RFP) and a Base cbZEC-market track (Morpho Blue market with the
  Chainlink ZEC/USD feed) — done 2026-09-12.
- The Claude Code starter prompt: Step 2 (Morpho Blue venue) is now also the
  cbZEC market step; Step 7 (Solana module) added — see
  `CLAUDE-CODE-HANDOFF.md`.
- New facts file to create before any Solana code: `docs/VERIFIED-SOLANA-FACTS.md`,
  seeded from `docs/research/SOLANA-ZEC-KAMINO-2026-09.md`.
