# Feedback round 2 — custody, wallet connections, venues, names (2026-08-13)

Answers to the follow-up notes. Everything below is grounded in fresh research
(sources cited inline); the few things that couldn't be confirmed are labeled.
Three of your instincts get confirmed here, one gets a hard "the rails don't
exist," and one research finding changes the venue plan more than the exploit
itself did.

---

## 1 · "Why can't users just connect their ZEC wallet like MetaMask?"

Because the rails don't exist — verified at the source-code level, not
assumed:

- **There is no Zcash namespace in WalletConnect.** The chain-agnostic
  registry WalletConnect builds on lists 43 ecosystems (EVM, Bitcoin, Solana,
  even Monero) — Zcash is not one of them
  (namespaces.chainagnostic.org). No namespace → no wallet can expose ZEC to
  a dApp, no dApp SDK can request a ZEC transaction. Full stop.
- **Unstoppable Wallet's WalletConnect is EVM + Stellar only** — verified in
  their Android source: only `WCHandlerEvm` and `WCHandlerStellar` are
  registered. So even the one wallet holding both shielded ZEC and Base
  assets can't let a website move its ZEC. Connect Unstoppable to our site
  and you get the *Base* side only.
- **The community tried to fund exactly this** — "WalletConnect v2
  Integration for Zcash" — and the Zcash Community Grants committee
  **rejected it in May 2026**. Nobody is building it.

So the MetaMask mental model isn't something wallets chose to skip — it's
structurally absent, because Zcash L1 has no smart contracts for a dApp to
call. "Connecting" is meaningful on chains where the app's contracts live
next to your funds. On Zcash, any DeFi interaction is, unavoidably, a *send*.

**The one real exception — and it's a partnership, not a build.** The
MetaMask "Zcash Shielded Wallet" Snap (ChainSafe, audited by Hacken May 2025,
live in the Snaps directory) does shielded sends approved inside MetaMask —
the exact UX you want. But its manifest is origin-locked: only
`webzjs.chainsafe.dev` may invoke it, and MetaMask rejects every other
origin. For our site to trigger it, ChainSafe would have to ship a snap
version allowlisting us (plus MetaMask re-review). It also has <1,000
installs and its maintenance funding ran through end-2025 (last release Feb
2026). Verdict: **worth one email to ChainSafe** — a co-announced "first
DeFi integration of the Zcash Snap" is a story both sides would like — but
nothing to build the product on today.

**What ZIP-321 actually buys us** (and its limits, verified): the spec is
explicitly designed so "users construct transactions by clicking links on
webpages" — approval stays in the wallet, creation is ours. Zingo and
Ywallet register `zcash:` as an OS-level deep link (verified in their Android
manifests) — tap our button, wallet opens pre-filled. Zashi/Zodl, ironically,
only parses it from QR scans (link handling is an open GitHub issue, and the
iOS team is debating removing the URI scheme over phishing concerns). So:
QR is the primary affordance, tap-to-open works for the power-user wallets,
and it's fire-and-forget — no callback, we watch the chain for the deposit.
That's as close to "approve in wallet" as native ZEC gets in 2026.

## 2 · "Who controls the deposit address? Users sending blind seems naive."

Your instinct is correct, and the honest answer needs to be in the product,
not buried. Precisely, from NEAR Intents' own docs and terms:

**The deposit address is controlled by the operator.** 1-Click's docs:
assets are "temporarily transferred to a trusted swapping agent." ZEC rides
their Proof-of-Authority bridge (operator-run — Defuse Labs, Gibraltar /
Intents Technology Ltd, BVI; internal key management undisclosed). Refunds
are a real, operational feature (`refundTo` address, `deadline` after which
refund begins, `REFUNDED` status) — but the ToS explicitly disclaims any
legal *obligation* to refund or recover. It is not your address, not our
address, not an MPC network: it's their bridge, for the minutes the swap is
in flight.

Three facts that frame this correctly:

1. **The flagship wallet ships this exact flow.** Zashi's built-in swaps ARE
   NEAR Intents 1-Click — same deposit addresses, same bridge — marketed by
   ECC as decentralized swaps, moving ~$800M/month at peak. The ZEC
   community's most-trusted wallet already normalized sending to a 1-Click
   deposit address. We're not asking users to do anything Zashi doesn't.
2. **Every native-ZEC-to-DeFi path on earth has this shape.** Verified
   custody map: NEAR Intents = operator bridge, minutes. Maya = 27-of-40
   threshold-signature vaults, minutes. Templar = NEAR's MPC network, for
   the whole life of the loan. zenZEC = custodial wrap, indefinitely. The
   only true no-custody mechanism in existence is Zwap (shielded atomic
   swaps) — in early access since May 2026 with a **$100 per-swap cap**.
   Native ZEC into DeFi without trusting someone's infrastructure for some
   window does not exist; the systems differ in *who* and *for how long*.
   (Zwap is worth watching — if it scales, it becomes our deposit rail.)
3. **So the differentiator isn't eliminating custody — it's blast-radius
   control and honesty.** What we already do: fresh address per quote,
   quote-locked amounts, mandatory refund address, deadline shown, per-step
   tx ids. What we should add on top (see below): a payout address that's
   *cryptographically the only exit*.

**The "user in control at all times" mechanic I recommend — pre-committed
payout address.** At deposit time, the user's Zcash payout address gets
committed immutably into their position. From that moment, every withdrawal
and every reward can only ever flow to an address the *user* chose while
they had full control. Even a total compromise of our frontend, our agent,
or the user's session can't redirect funds anywhere but home. That's a
stronger control guarantee than most "connected wallet" dApps offer — and
it's honest: we can't hold your coins hostage *and* we can't send them
anywhere but to you.

## 3 · The two-wallet confusion — resolved by needing zero connections

Reframe: the core loop should require **no wallet connection at all.**
Deposit = scan a QR from any Zcash wallet (Zodl included). Identity = a
passkey (Face ID / fingerprint — users never see a seed phrase for our app).
Exit = the pre-committed payout address above. One wallet, the one they
already have, never "connected" to anything — which for this audience is a
feature, not a gap.

The Base-side EVM wallet becomes an **optional power-user binding**: bind an
0x address and you get direct on-chain withdrawal rights against the vault,
no trust in our operator required. Advanced users will love it; nobody else
ever sees it. (Unstoppable stays the documented one-app choice for people
who want both sides in one place; MetaMask-Snap one-click deposits become
the upgrade if ChainSafe partners.) Net: instead of "you need two wallets,"
the pitch is "you need the wallet you already have."

## 4 · Templar — how it works, and whether we can use it

Mechanics (verified from their FAQ, code, and independent analysis): your
ZEC never wraps or bridges. It goes to an address on Zcash L1 whose key is
held by **NEAR's Chain Signatures MPC network**; you borrow USDC against it
(the ZEC market settles **USDC on Solana**, launched Nov 26 2025), floating
rate targeting 0–8% by utilization, minimum collateral ratio 120%,
permissionless partial liquidations (liquidator buys collateral at ~95% of
oracle, restoring ~130% health), repay → collateral released in under a
minute. Contracts are MIT-licensed on NEAR (integrable directly); a public
API/JS SDK is roadmap, not shipped.

The honest caveats, because this audience will find them:

- **The custody is a 5-of-8 MPC, not the "30 nodes including Fireblocks and
  BitGo" their marketing claims.** NEAR's own docs say 8 nodes; an
  independent cryptographer's May 2026 review lists the 8 operators, notes
  the threshold equals the one behind the Ronin hack, no proactive key
  refresh, TEE off on mainnet, and unaddressed audit items. Better than a
  single operator; materially oversold.
- **The ZEC market is ~$80K of collateral** — essentially unused, two to
  three orders of magnitude below what we'd need, and the borrow side is
  Solana-USDC (one more bridge hop to reach Base) with no cbBTC/WETH.
- Protocol-wide it's real ($24M TVL, $7.4M loans, Halborn-audited Stellar
  stack, $4M raise from Robot Ventures/DACM/NEAR Foundation, no incidents
  found) — just young, and thin exactly where we need depth.

**Verdict:** not a drop-in today; absolutely the right venue #2. The move:
(a) keep the venue layer pluggable (the RheaSdkService seam already exists
for exactly this), (b) open a direct line to Templar — they want the ZEC
market seeded and we'd be its biggest user; ask about borrow-side liquidity
commitments and the API timeline, (c) their custody story ("your ZEC never
leaves Zcash L1") is the better *narrative* even with MPC caveats — if
their liquidity matures, it likely becomes the headline venue.

## 5 · "Skip Rhea — bridge to Base and borrow on Aave?"

Definitively impossible, verified: **no Aave deployment on any chain has
ever listed ZEC in any form** — the only listing proposal (2020) died, and
Aave v4 (launched March 2026) shipped with no ZEC. There is a wrapped ZEC on
Base (uZEC) with a **$139K market cap and ~$4K/day volume** — dust that no
lending market accepts. And bridging your ZEC to Base as anything else means
*selling* it (a disposal — the whole thesis is not selling). Borrowing
against ZEC can only happen where ZEC is accepted: that set is exactly
**{Rhea, Templar}**, plus CeFi we won't touch.

**The bigger finding — Rhea's lending may still be frozen.** Post-exploit
status as of today: the DEX resumed April 21, but the **lending/margin
contracts were frozen and no verifiable relaunch has been published** — no
post-exploit re-audit in their published audit list, compensation plan
unfinished, TVL down 15% over 30 days. Our integration was verified against
their SDK's call surface, not against live mainnet lending accepting
deposits — that distinction now matters. This goes to the top of the
verification queue: **probe whether Rhea ZEC lending is actually accepting
supply/borrow today** before any launch planning. If it isn't, the plan
becomes: engage both teams now (Rhea on relaunch timeline + re-audit,
Templar on liquidity + API), build against the pluggable seam, and let
whichever venue is bankable first win the launch slot — with per-venue caps
either way. The Rhea-hack narrative risk you're worried about gets defused
the same way: our docs already disclose it plainly, and having Templar as a
credible second rail is the answer to "why should we trust your venue."

## 6 · Names — the man working in the rain

Your image: hard work in cold, sopping rain; the coat keeps him dry and
working. Protection that doesn't stop the work — the work continues
*because* of the shelter. Words that live in that exact image:

| Name | Why it fits |
|---|---|
| **Oilskin** | The literal fisherman's raincoat — rugged work-in-weather protection. Distinctive, ownable, zero DeFi-template smell. My favorite from your image. |
| **Wheelhouse** | The sheltered cabin a captain *works from* through the storm — protection and productivity in one word, plus the idiom "in your wheelhouse." |
| **Mill** (Watermill) | The inversion of the image: the mill doesn't just endure the rain — it puts the water to work. Closest metaphor to "your ZEC works while protected." |
| **Slicker** | The rain slicker itself. Punchy; small caveat that "city slicker" can read as con-man. |
| **Leeward / Lee** | The sheltered side of the storm, where sailors work safely. "Lee" is beautifully short. |
| **Hull** | What keeps the water out while the ship does its job. |
| **Foulweather** | Foul-weather gear — the sailor's version of your raincoat. Rugged, memorable. |
| **Harbor** | Where working boats shelter and still load cargo. Warm, but more generic. |

And note: **Canopy** — already your favorite — fits this image too (the
cover you work under, out of the rain) *on top of* being a Zcash network
upgrade name. It's the only candidate that scores on both the insider nod
and your analogy, which is probably the tiebreaker. My short stack:
**Canopy, Oilskin, Zield, Wheelhouse, Gilt** — all still needing the
domain/trademark pass.

## 7 · Decisions logged + updated verification queue

Logged from your notes: **no fork — the engine's 15% buys infrastructure we
don't have to run** (matches the recommendation; SPDX check and rev-share
email stay queued as upside, not blockers).

New/updated verification items, in priority order:

1. **Is Rhea ZEC lending live and accepting supply/borrow today?** (Direct
   SDK probe / ask the team. Blocks launch planning.)
2. **Templar direct contact** — borrow-side liquidity for a ZEC market at
   our scale, API/SDK timeline, and their real MPC parameters in writing.
3. **ChainSafe contact** — snap origin allowlisting + send-RPC for one-click
   MetaMask ZEC deposits (co-announcement angle).
4. Passkey + pre-committed-payout auth design (product spec for the
   "control at all times" model in §2–3).
5. Zwap tracking — the only true no-custody deposit rail if it scales past
   its $100 cap.
6. Prototype copy round: "who holds what, when" custody timeline card in
   the deposit flow + Docs; zero-connection framing.

Prior queue items unchanged: engine SPDX, 1-Click status fields,
expansion-pool ids, name domain/TM checks.
