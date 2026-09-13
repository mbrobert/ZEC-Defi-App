# The cross-chain rung, step by step — what runs, what can fail, and what a person must do

**Status: built 2026-09-13 (BUILD-PLAN D6, Stream C), never run against a real transfer.** The design is
`docs/SOLANA-ARCHITECTURE.md` §14; the addresses and call shapes are `docs/VERIFIED-SOLANA-FACTS.md`
Addenda 1, 3 and 4. This page is the operator's view: what the keeper does on its own, and the handful of
states where it stops and a person decides.

Abbreviations: CCTP = Circle's Cross-Chain Transfer Protocol; HF = health factor; LP = liquidity provision;
PDA = program-derived address; ALT = address lookup table; ATA = associated token account.

## 0 · The shape of the problem

On one chain a protective rung is one transaction: close, repay, done, or it reverts. For a position whose
collateral is on Solana and whose USDC is working on Base, the same rung is **five steps across two chains and
two keys**, and it runs at the worst moment — a falling market, when Solana's priority fees and Base's
sequencer load are both highest. It cannot be atomic. What it can be is **resumable**, and that is what the
keeper implements: every step is recorded before it is taken, and re-entering a half-finished rung continues
it rather than starting again.

The keeper only takes this path when it has to. Rung 2 (repay) is always answered on Solana from the
account's own reserve. Rungs 3 and 4 cross a chain **only when the account's idle USDC cannot reach the
disarm level** — and once a delivery has landed, that same test sends the next firing down the Solana path,
which is what ends the sequence instead of burning a second time.

## 1 · The five steps

| # | Step | Chain | Signer | Recorded as |
|---|---|---|---|---|
| 1 | `StrategyRouter.closeLpAndBurn`: close LP ids, swap the non-USDC leg, burn USDC to the account's recorded Solana token account | Base | keeper's Base key, inside a grant for that selector | `bridge.stage = burn-sent` |
| 2 | The Base receipt: our `BurnedToSolana`, Circle's `DepositForBurn` and the transmitter's `MessageSent` must agree | Base | — (a read) | `burn-confirmed`, with the nonce and message bytes |
| 3 | Circle attests the message (Fast ≈ seconds; Standard waits for Base finality) | Circle | — | `attested`, with the signatures |
| 4 | `MessageTransmitterV2.receive_message`: Circle pays the USDC out of its custody account to the account's ATA | Solana | keeper's Solana key (anyone could) | `delivered` |
| 5 | `keeper_protect` repay-only: the delivered USDC goes to the Kamino debt | Solana | keeper's Solana key, inside the grant | an ordinary rung dispatch |

Step 5 needs no cross-chain code at all. A delivery moves no health factor, so the rung fires again on the
next tick — and by then the account holds the USDC, so the ordinary repay-only path spends it.

**Where the money is, at each stage.** After step 1 it is burned: it exists only as a message. Between 1 and 4
it is *in Circle's hands*, recoverable only by delivering the attested message — which **anyone** can do, since
the recipient is fixed in the message bytes. After step 4 it is in the user's own Solana account. At no point is
it in the keeper's.

## 2 · What fails, and what happens

The rule behind the table: **anything that is not a disagreement is a wait.** A pending attestation, an
unindexed burn, an RPC outage and a full mempool all leave the record open and are retried on the next tick.
Only a message that is not the burn we made, or a transaction that reverted, ends a rung.

| Step | Failure | What the keeper does | What a person must do |
|---|---|---|---|
| 1 | No grant for `closeLpAndBurn`, or it lacks `allowCallback` | REFUSED, permanent; escalates | The owner signs the second grant (`CONTRACT-ABI.md`, "the cross-chain protection grant") |
| 1 | The router records a different Solana recipient than the Solana account expects | REFUSED, permanent; escalates | The owner sets the recipient; a half-link is never bridged |
| 1 | Circle's denylist names the account | The simulation reverts by name; FAILED | Nothing on our side — it is Circle's list |
| 1 | Gas spike / sequencer lag | FAILED, retried with the same key; the nonce is persisted before the send | Nothing, unless it exhausts the attempt cap |
| 2 | The three events disagree on amount or recipient | FAILED by name | **Investigate before re-running**: this means the router and Circle saw different things |
| 2 | The receipt is not found yet | stays SENT, retried | Nothing |
| 3 | `status: pending_confirmations` | stays SENT, retried; the reason Circle gives is logged | Nothing — Standard-path transfers wait for Base finality |
| 3 | Circle has not indexed the burn (404 or empty) | stays SENT, retried | Nothing |
| 3 | Circle's service is down (5xx, timeout, unreadable JSON) | stays SENT, retried; classified `unavailable`, never as a bad message | Nothing, unless it persists for hours |
| 3 | **The message does not match our burn** | FAILED, logged at error | **Stop and look.** The keeper will not deliver it. This is the one state that should never happen |
| 4 | No `CCTP_LOOKUP_TABLE` configured | REFUSED, permanent | Create the table at deploy and set the variable (§4) |
| 4 | The nonce is already recorded on chain | CONFIRMED — someone else delivered it; that is a success | Nothing |
| 4 | Solana congestion / priority fees | SENT then retried; the delivery is idempotent because the nonce guard is on chain | Nothing |
| 4 | The simulation fails for any other reason | FAILED with Circle's own log lines | Read the logs; the accounts are pinned by tests, so suspect the cluster |
| 5 | The Kamino oracle is stale, the reserve is paused, the price is out of band | The valuation is UNKNOWN and **no rung acts** (fail closed); escalates after the streak | Wait for the oracle, or act manually through the program's owner path |
| 5 | The repay does not reach the disarm level | The program refuses it as ineffective; the rung re-arms | Usually nothing: the next tick sizes it again |

**The honest worst case.** Between step 1 and step 4 the position on Solana is **not** improving — the USDC
that will repay it is in flight. If the market keeps falling through that window, the ladder's lower rungs fire
against a position that cannot yet be helped from Base, and the Solana-side reserve is what stands in for it.
That is the whole reason the reserve exists (§14.3) and why a cross-chain position's rungs sit higher than a
Base-only one's: the entry HF is at least 1.625, so the ladder is 1.57 / 1.40 / 1.23 / 1.06.

## 3 · Resuming by hand

Every stage lives on the dispatch record in the keeper's store, so the state is readable without the keeper
running: `bridge.stage`, `burnTxHash`, `nonce`, `messageHex`, `attestationHex`, `deliveryTx`.

- **To see where a rung is**: find the dispatch whose `bridge` is set and read its stage.
- **To resume**: start the keeper. A SENT record is re-entered every tick, one stage per tick.
- **To deliver a stuck message without the keeper** (steps 3–4 only, and only the *delivery*): fetch
  `GET https://iris-api.circle.com/v2/messages/6?nonce=<nonce>` and hand the `message` and `attestation` to
  `receive_message`. The recipient is inside the message, so this cannot be misdirected — which is exactly
  why it is safe to do by hand.
- **Never re-run step 1 to "try again"** while a burn is in flight. The keeper will not (it waits inside the
  stall window, `BRIDGE_STALL_S`, and falls back to the Solana-only path past it), and a second burn sends a
  second amount across.

## 4 · What the founder must set up before any of this runs

1. **An address lookup table on Solana, created once at deploy.** Both the burn and the delivery are over the
   legacy transaction size — the delivery measured **1,264 bytes against the 1,232 limit** — so both ride v0
   transactions. `docs/SOLANA-DEPLOY.md` carries the step; the keeper reads it as `CCTP_LOOKUP_TABLE` and
   refuses a delivery by name without it.
2. **The second keeper grant** on any account that will use the loop (`closeLpAndBurn`, its own USDC budget).
3. **Two keys in one process.** The burner needs a Base key beside the Solana key. Nothing in the repository
   wires that today: `runSolanaKeeper` takes a `baseBurner` and is given none, so a linked pair's rungs 3–4
   take the single-chain path until the founder decides how those two keys live together.
4. **`BASE_RPC_URL` and `BASE_ROUTER_ADDRESS`** for the pair read, and `CCTP_ATTESTATION_URL` if pointing at
   Circle's sandbox rather than mainnet.

## 5 · What is still not proven

- **No real transfer has run.** The burn is proven against Circle's cloned program on localnet; the delivery
  is proven up to Circle's signature check, which is as far as any localnet can go without Circle's attester
  keys. End to end on Solana devnet ↔ Base Sepolia is the next real test, and it is the one that would measure
  the "~8 seconds" Circle advertises.
- **The reserve has not been sized against the Monte Carlo.** Today it is the rung-2 requirement
  (4.11 % of the debt at a 1.625 entry); whether that is the right number under a real ZEC drawdown is a
  modelling question, not a code one.
- **Fast versus Standard.** The keeper sends whatever threshold the caller passes. Nothing yet *chooses* Fast
  when the Fast allowance is exhausted, or falls back to Standard automatically.
