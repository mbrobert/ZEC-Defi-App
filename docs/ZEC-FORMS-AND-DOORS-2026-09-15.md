# ZEC forms, and the two doors — plan of record for the Zcash direction

**Founder's decision, 2026-09-15:** *"Oilskin allows/permits/utilizes all forms
of ZEC, whether it's cbZEC, NEAR Intent bridged ZEC from Solana, wrapped ZEC,
etc."* — and: build Door 1 and Door 2 into the code now; **ZSA-dependent work
waits until ZSAs actually go live.**

This file is the *what and where* for that direction. It does not change
`docs/BUILD-PLAN-2026-09-12.md` (decisions D1–D13) or `docs/ROADMAP.md` (dates
and the 2026-12-11 freeze); it slots into both, and §6 says exactly where.

Abbreviations on first use: ZEC = Zcash's native coin; ZSA = Zcash Shielded
Assets (ZIP 226/227, **Draft**); HF = health factor; LTV = loan-to-value;
LT = liquidation threshold; CCTP = Circle's Cross-Chain Transfer Protocol;
MPC = multi-party computation; TSS = threshold signature scheme;
KYC = know-your-customer; PDA = program-derived address.

---

## 1 · The constraint that shapes all of this

Read 2026-09-14 from the primary sources (`zips.z.cash`, the Zcash repo, the
grants site):

- **Zcash has no Turing-complete compute.** ZIP 227 is explicitly *not*
  programmability; ZIP 228's swaps are exact-match only, with no partial fills
  and matching done off-chain. There is no Zcash-side contract that can hold
  collateral, run a health ladder, or own a liquidity position.
- **ZIP 226 / 227 / 228 are all `Draft`.** ZIP 220 and ZIP 230 are `Withdrawn`.
  The last activated upgrade is NU6.2 (2026-06-03); **NU7 has no date.**

So the engine does not move. Oilskin's lending, the HF slider, the ladder, the
keeper grant, the LP venues — all of that stays exactly where it is, on Base
and Solana, inside the audited surface.

**What Zcash gets is the two doors.** The user's ZEC arrives through a door and
leaves through a door, and both doors can be private. The room in between is
the machine we already built and are about to freeze for audit.

> The one-line version for the website: *you keep your privacy on the way in and
> on the way out; the part that has to be public — the loan — is the part that
> has to be public anywhere.*

---

## 2 · Part A — the ZEC form registry (the "all forms of ZEC" requirement)

### 2.1 What is already agnostic (measured, not assumed)

Grepped at HEAD `6a05968`, 2026-09-15, excluding `node_modules`, `lib`, `out`,
`dist`:

- **`contracts/src/` mentions cbZEC only in comments**, plus the Sepolia mock
  deploy (`contracts/script/DeploySepolia.s.sol`, `CBZEC_USDC_TICK` etc.) and
  the two oracle adapters (`ChainlinkOracleAdapter`, `PythOracleAdapter` — both
  marked `BUILT, UNUSED`). `CollateralRegistry.sol` keys assets **by address**,
  not by symbol. **No Solidity change is required to support a new ZEC form.**
  That is the single most important fact in this document: the audited surface
  does not care which ZEC it is.
- The **Solana** side already treats its ZEC as generic: `SolanaTokenSymbol` is
  `"ZEC" | "USDC"`, and `packages/shared/src/solana.ts` describes the bridged
  mint by its properties (mint authority `FvUL…NYds` is a **System-owned key,
  not a program**; **no freeze authority**), not by a brand.

### 2.2 What is hard-coded and must change

| File | Symbol | Problem |
|---|---|---|
| `packages/shared/src/collateral.ts:13` | `export type CollateralSymbol = "cbBTC" \| "WETH" \| "cbZEC"` | A closed union. A second ZEC form cannot be expressed. |
| `packages/shared/src/base.ts:27` | `export type TokenSymbol = … \| "cbZEC" \| …` | Same, one layer down. |
| `packages/shared/src/collateral.ts:81` | `COLLATERAL_SYMBOLS` | Fixed array; every consumer maps over it. |
| `web/lib/copy.ts`, the wizards, `web/app/onboard/page.tsx` | user-facing strings | Say "cbZEC" where they mean "your ZEC". |

### 2.3 The new file: `packages/shared/src/zecForms.ts`

One row per **form of ZEC**, describing it by its *properties*, so the UI, the
keeper and the yield service can reason about a form they have never seen:

```ts
export type ZecFormId =
  | "cbzec-base"          // Coinbase B20 wrapper on Base
  | "zec-solana-bridged"; // OmniBridge / NEAR Intents SPL mint on Solana
  // future rows are DATA, not code: "zec-native-zsa", "<wrapper>-<chain>", …

export type ZecCustody =
  | "custodial"   // a named issuer holds the underlying and can pause/block
  | "bridged-mpc" // an MPC/TSS signer set holds it; no single issuer
  | "native";     // the Zcash chain itself (ZSA era — no row yet)

export interface ZecForm {
  id: ZecFormId;
  chain: "base" | "solana" | "zcash";
  symbol: string;                 // what the chain calls it
  assetRef: string;               // EVM address or Solana mint — the real key
  decimals: number;
  custody: ZecCustody;
  /** Who can stop a transfer. `null` means nobody could when last read. */
  freezeAuthority: string | null;
  /** Does obtaining this form require identity verification? */
  kycRequired: boolean;
  /** Lending venue that accepts it as collateral today, or null. */
  collateralVenue: "aave-v3" | "morpho-blue" | "kamino-zcash" | null;
  enabled: boolean;
  disabledReason?: string;        // shown verbatim; never softened
  riskNotes: readonly string[];   // stated before the button, always
  /** Facts-file row that proves every field above. Required. */
  verifiedIn: string;             // e.g. "docs/VERIFIED-SOLANA-FACTS.md §1"
}
```

**Rules that come with it, and they are not optional:**

1. **`verifiedIn` is mandatory.** A form with no facts-file row does not compile
   into the registry. This is `CLAUDE.md` rule 3 made structural — the way a new
   wrapper gets added is: read it on chain, write the facts row, then add the
   form. Never the other way round.
2. **A form is never enabled by symbol.** `enabled` is set by whether a lending
   venue actually accepts that exact `assetRef` — read live, not typed.
3. **The counterfeit check follows the form, not the brand.**
   `packages/shared/src/base.ts` already pins cbZEC's address and flags
   `0xb2000…` look-alikes; that logic generalizes to "is this `assetRef` the
   pinned one for this form", and every form gets the same treatment.
4. **`CollateralSymbol` widens to `"cbBTC" | "WETH" | ZecFormId`**, or — cleaner
   — the collateral registry keys on `assetRef` and carries a `zecForm?: ZecFormId`
   pointer. Claude Code picks whichever produces the smaller diff across
   `agent/`, `services/yield/` and `web/`; both are acceptable. **What is not
   acceptable is a third place that lists ZEC forms.**

### 2.4 The two rows at launch (both already verified)

| Field | `cbzec-base` | `zec-solana-bridged` |
|---|---|---|
| chain | Base | Solana |
| assetRef | `BASE_TOKENS.cbZEC.address` (pinned) | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS` |
| decimals | 8 | 8 |
| custody | `custodial` (Coinbase B20) | `bridged-mpc` (OmniBridge signer set) |
| freezeAuthority | issuer can pause and block; balances rebase via a live `multiplier()` | **none** at last read; mint authority is a plain key, not a program |
| kycRequired | yes, to mint/redeem at Coinbase | no |
| collateralVenue | **null** — D3 stands: no Base market lists cbZEC, and Oilskin does not create one | `kamino-zcash` |
| enabled | **false**, with D3's reason shown verbatim | true |
| verifiedIn | `docs/VERIFIED-BASE-FACTS.md` | `docs/VERIFIED-SOLANA-FACTS.md` §1 |

**This changes no decision.** D3 (don't create a cbZEC market) is untouched.
What changes is that cbZEC stops being *the* ZEC and becomes *a* ZEC — one row
among several, disabled on its own merits rather than by being the only name in
the type.

### 2.5 What the user sees

A single **"Your ZEC"** entry point that asks one question — *where is your ZEC
right now?* — and then shows every route it can take, each with its real
properties side by side: who can freeze it, whether identity is required, which
market will lend against it, what it costs to get there, and how long it takes.
Today that table has two rows and only one of them ends in a loan. That is an
honest answer and it is a better answer than hiding the choice.

---

## 3 · Part B — Door 1: the private exit

**What it is.** After a position is unwound and the user is holding USDC in
their own account, they can choose **"send it out as ZEC to my own Zcash
address"** instead of leaving it as USDC. The route is NEAR Intents:
USDC → (intent, solver-filled) → native ZEC at a `zs…`/unified address the user
supplies.

**Why this is the door and not the room.** It happens *after* every contract
call is finished. It is a destination choice on money the user already
withdrew.

### 3.1 What it touches

| Layer | Change | Contract change? |
|---|---|---|
| `packages/shared/` | `zecExit.ts` — address validation, quote shape, route constants | no |
| `services/yield/` | `GET /v1/exit-quote` — proxies a live NEAR Intents quote; never caches a rate into code | no |
| `web/lib/` | `exit.ts` — quote, confirm, disclosure gate | no |
| `web/app/dashboard/` | the destination step at the end of unwind | no |
| `agent/` | **nothing.** The keeper never touches this path. | no |

**Zero Solidity. Zero Anchor. Zero new audit surface.** That is what makes this
buildable before the freeze without trading anything off under `ROADMAP.md`
rule 2.

### 3.2 The hard rules for Door 1

1. **Oilskin never holds the funds and never signs.** The app builds a transfer
   the user signs in their own wallet (`CLAUDE.md` rule 1). If the route needs a
   deposit address, that address is fetched live and shown in full for the user
   to verify — never abbreviated, never auto-submitted.
2. **The transparent hop is disclosed before the button, in plain words.** NEAR
   Intents moves ZEC out of the Orchard shielded pool to a **transparent address
   controlled by the bridge's signer set**, and the user re-shields on arrival.
   The copy says that. It does not say "private" without saying *which part*.
   Suggested wording, subject to the copy pass:
   > *Your ZEC lands at a transparent Zcash address first, then you shield it
   > yourself. Between here and there, a group of bridge signers controls the
   > coin. If that group failed, the ZEC in flight is at risk.*
3. **No refund path is assumed.** If a solver does not fill, the doc says what
   actually happens — read it from the protocol, do not guess.
4. **`BANNED_WORDS` applies.** No "private", "anonymous", "safe" or
   "untraceable" as a bare claim. Describe the mechanism; let the user conclude.

### 3.3 The blocker, stated honestly

**Nothing about NEAR Intents is in a `VERIFIED-*-FACTS.md` file yet.**
`docs/VERIFIED-SOLANA-FACTS.md` §6 item 5 already flags this: the OmniBridge
signer set, the MPC/TSS custody of the locked ZEC, and the withdrawal delay are
**unread**. So Door 1 starts with a facts pass, not with code:

**Step Z1 — `docs/VERIFIED-ZEC-ROUTES-<date>.md`**, one row per claim, each with
how it was read and when:

- the quote/intent endpoints and their real request/response shapes, observed —
  not guessed from documentation
- fee and slippage on a live USDC → ZEC quote, both directions
- the signer set: how many, who, what threshold, and whether that is readable
  on chain or only published
- the withdrawal delay, measured
- minimum and maximum size
- whether any step asks for identity, measured rather than claimed
- what happens to an unfilled intent, and after how long

Until Z1 exists, Door 1's UI ships **behind a flag, disabled**, with the reason
shown. Under `CLAUDE.md` rule 3 there is no other honest order.

### 3.4 One thing for the lawyer, not for us

Routing a user's funds into a privacy-preserving swap is a different question
from lending against collateral. Add it as a fourth item to the lawyer's read
already scheduled in `docs/AUDIT-SHORTLIST-2026-09.md` §5. **Do not build a
legal opinion into the copy** (`CLAUDE.md` rule 4) — state the mechanism, flag
the question, let the founder and counsel answer it.

---

## 4 · Part C — Door 2: the private entry

**What it is.** The route already works — a ZEC holder can bridge into the
Solana lane and borrow on Kamino today. What is missing is that **the website
never says so.** `web/app/onboard/page.tsx` is written for someone who already
has a token on Base.

**So Door 2 is mostly copy and one screen**, and it is the cheapest real win in
this document:

1. Onboarding asks *where is your ZEC?* — Base, Solana, a Zcash address, or an
   exchange — and routes accordingly.
2. For "a Zcash address", show the NEAR Intents route to the Solana lane as a
   **first-class, supported path**, with its costs, its time, and the same
   transparent-hop disclosure as Door 1 (§3.2 item 2 — one shared copy block,
   not two that can drift).
3. For "Base", say plainly that cbZEC is registered but no market lends against
   it (D3's `disabledReason`, verbatim), and offer the Solana lane instead.
4. The form registry from §2 is what makes this screen data-driven instead of a
   hand-written branch per case.

**Same rules as Door 1**: no transaction is ever built or signed by Oilskin for
the bridge leg; the deposit address is shown in full; the disclosure precedes
the button.

---

## 5 · What deliberately does NOT happen

Written down so it is not re-litigated in November.

| Not doing | Why |
|---|---|
| Any ZSA work | ZIP 226/227 are `Draft`; NU7 has no date. Founder: *"we will work later on more when ZSA actually go live."* **Nothing on the roadmap depends on a Draft ZIP.** |
| A Zcash-side contract, vault, or matching engine | Zcash has no Turing-complete compute. This is not a scheduling question. |
| Creating a cbZEC lending market on Base | D3, unchanged. |
| Oilskin custody of funds at any point in either door | `CLAUDE.md` rule 1. The user signs; the user's address receives. |
| Any change to `contracts/` or `solana/` for this direction | §2.1 — the registry is address-keyed. If a diff here starts touching Solidity, **stop and re-read this section**: something has gone wrong. |
| Shipping Door 1 before Z1 | `CLAUDE.md` rule 3. |

---

## 6 · Where this lands against `ROADMAP.md`

The freeze (`beta-audit-1`, 2026-12-11) covers **the contract hash**. Every item
below is off-chain, so none of it enlarges what the auditors price — but it
still costs calendar time, so it is sequenced, and rule 2's "name what comes
off" is answered in the last row.

| Item | Where | Audit surface | Note |
|---|---|---|---|
| §2 ZEC form registry (`zecForms.ts` + the union widening) | **Before freeze** — it is typed shared code the wizards already depend on | none | Do it early; every later row assumes it |
| §4 Door 2 — onboarding routes by where the ZEC is | **Before freeze**, batched into the copy pass (`ROADMAP.md` rule 5) | none | Cheapest real win here |
| §3.3 Step Z1 — `VERIFIED-ZEC-ROUTES` facts pass | **Before freeze**; a Cowork research batch, not Claude Code's tokens (`ROADMAP.md` rule 6) | none | Gates Door 1 |
| §3 Door 1 — private exit, built behind a flag | **Before freeze, shipped dark**; flag flips at v1.1 once Z1 lands and counsel has answered | none | Nothing user-visible before the flag flips |
| §3.4 lawyer item | Added to `AUDIT-SHORTLIST-2026-09.md` §5 | — | Founder's call, not ours |
| ZSA anything | **Not scheduled.** Revisit when NU7 has a date | — | This is the trade: the ZSA work that felt urgent is the work that comes off |

**Net effect on the freeze date: none.** Nothing in this document adds a line of
Solidity or Anchor, and the one item with unknown effort (Door 1) ships disabled
if it is not ready.

---

## 7 · Order of work for Claude Code

1. `packages/shared/src/zecForms.ts` + the two rows, each with `verifiedIn`
   pointing at an existing facts row. Tests: every form's `assetRef` matches the
   pinned address in `base.ts` / `solana.ts`; no form is enabled without a
   `collateralVenue`; the counterfeit classifier rejects a look-alike per form.
2. Widen `CollateralSymbol` / `TokenSymbol` (or re-key on `assetRef` — §2.3
   rule 4), then fix every consumer the compiler names. Run the full shared,
   agent, yield and web suites and quote the counts. **Counts that were green
   before must be green after** (`CLAUDE.md` working conventions).
3. Grep for `cbZEC` in user-facing copy and replace it with the form's own label
   wherever it means "the ZEC representation on this chain" — and leave it alone
   where it genuinely means the Coinbase token (`CLAUDE.md` rule 6).
4. Door 2: `web/app/onboard/page.tsx` — the *where is your ZEC?* branch, driven
   by the registry. One shared disclosure block, used by both doors.
5. Door 1 scaffolding behind `NEXT_PUBLIC_ZEC_EXIT_ENABLED=false`: shared types,
   the service route, the UI, the disclosure — **no live calls until Z1 exists.**
6. Add the lawyer item to `AUDIT-SHORTLIST-2026-09.md` §5.
7. Update `docs/BETA-SCOPE-2026-09-13.md` with an "all forms of ZEC" row in
   **In beta** (the registry and Door 2) and a Door 1 row in **Not in beta**
   (ships dark, flips at v1.1), then update `docs/STATUS.md` via
   `npm run status`.

Commit small, run the suite that proves each step, quote the counts, push.
