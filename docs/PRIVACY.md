# Privacy — what is known about you, by whom

Written for the Base-first v1 tree of 2026-09-05. Read the first sentence of
every section literally. Nothing about this product is private in the sense a
Zcash user means; the pre-pivot design's bridge-based entry, and the claims
it made, no longer exist (`BASE-PIVOT-2026-09.md` §2, "The privacy thesis
inverts").
Abbreviations: KYC = Know Your Customer; RPC = remote procedure call (a chain
node endpoint); ENS = Ethereum Name Service.

## 1 · Coinbase knows the entry

If you arrive with ZEC, the only way to get cbZEC (Coinbase Wrapped ZEC) is
through a Coinbase account: deposit ZEC to your Coinbase ZEC balance (a
transparent address — whatever Zcash balance you send from, the ZEC arrives
there in the clear), choose "Send ZEC on Base", give a Base address. Coinbase
therefore knows **who you are (full KYC), how much, when, and the Base address
that received it**. Exits reverse the path and pay ZEC to **transparent
addresses only**. Reserves sit in transparent t-addresses that anyone can
watch. None of this is Oilskin's to change; the onboarding page says it in
those words (`web/lib/onboarding.ts`, `web/app/onboard/page.tsx`).

If you arrive with cbBTC or WETH already on Base, Coinbase is not in the
picture for Oilskin's part — but cbBTC is itself a Coinbase-issued wrapper,
and however you got the tokens to Base is your own history.

The four words the founder banned from describing the entry (`RISKS.md` §1
lists them) appear nowhere in the product, and tests fail if they reappear
(`web/test/copy.test.ts`; `prototype/test/_harness.mjs: FORBIDDEN`).

## 2 · Everything on Base is public

Base is a transparent ledger. For the address you connect, anyone can read:

- your `OilskinAccount` address (`factory.accountOf(wallet)` is a pure
  function of your wallet address — there is no unlinkable account);
- every Aave supply, borrow, repay and withdrawal made on behalf of it;
- every engine position id it owns, its width, its pool, its rebalances,
  its claims;
- every keeper action (`Executed`, `KeeperSpend` events on the account) and
  every grant you sign (`Granted` / `Revoked` events name the keeper, target
  and selector);
- every CoW order you sign, once settled;
- the performance fee paid to the treasury (`PerformanceFee` events).

An observer sees a position and an address. Whether they see a person depends
on whether that address is linked to you elsewhere — which, for a cbZEC
wrapper address, it is (§1).

## 3 · What Oilskin's software sends, stores and logs

**The web app** (`web/`) has no backend of its own and no analytics; there is
no `gtag`, Sentry, PostHog or similar in `app/`, `components/`, `lib/`. It
talks to:

- a Base RPC (default `https://mainnet.base.org`, `NEXT_PUBLIC_BASE_RPC_URL`)
  for every chain read — that provider sees your IP and every address it is
  asked about;
- your wallet (Coinbase Wallet SDK, MetaMask, WalletConnect relay when a
  project id is set) — each has its own privacy policy; the Coinbase SDK
  probes cross-origin-opener policy with a `HEAD` request at init;
- the yield service (`NEXT_PUBLIC_YIELD_URL`) for `/v1/gate`, `/v1/rates`,
  `/v1/pools` — requests carry no wallet address; the dashboard's indexer
  cache path (`/v1/account/{owner}`) would carry one, and the yield service
  does not serve it yet;
- the CoW Protocol order book (quotes and orders carry your address, by
  design — it is the order's owner).

It stores in your browser's `localStorage`, and nowhere else: the Simple /
Advanced mode (`lib/mode.tsx`) and the in-flight state of an unfinished
signing flow — flow kind, wallet address, step states, transaction hashes
(`lib/inflight.ts`), cleared when the flow completes.

**The keeper** (`agent/`) is Oilskin's process. It reads every
`OilskinAccount` from the factory's `AccountCreated` logs and stores, in its
JSON store on Oilskin's disk (`STORE_PATH`): account and owner addresses,
block cursors, per-account ladder state, and dispatch records (rung, health
factor, transaction hash, status, reason). Its logs (`agent/src/log.ts`)
carry account addresses, health factors and transaction hashes; they redact
every 32-byte hex value not under a `txHash` / `blockHash` / `hash` field
(so a private key can never print), reduce URLs to their origin (provider
keys live in paths), and blank fields named like secrets. The keeper's own
private key never enters the logger (`config.ts` serialises a mode flag only).
There is no user-facing notification channel, so nothing about you is sent
anywhere by the keeper except its transactions to Base.

**The yield service** (`services/yield/`) reads Aave, Aerodrome and the
engine's history over an RPC and, optionally, the Blockscout API with a key
it sends only as a `Bearer` header and never logs. It serves aggregates, not
accounts, and logs handler errors with the request path
(`server.ts`) — no client addresses are read or stored.

**The prototypes** keep their demo state in `localStorage` of your browser
(versioned, validated, reset on corruption) and call nothing over the network
except a `HEAD` probe for the sibling page.

**Oilskin does not** run analytics, collect e-mail, keep a user database,
or receive anything from the wallet beyond what the chain sees. There is no
account system: the wallet is the identity.

## 4 · What links you to a position, in order of strength

1. Wrapping ZEC through Coinbase to the address you then connect (§1).
2. Reusing one wallet across contexts where it is already named (an ENS name,
   an exchange withdrawal, a public post).
3. Amount and timing correlation between a Coinbase send and an Oilskin
   deposit.
4. The keeper grant: `Granted(keeper, …)` on your account tells anyone which
   accounts Oilskin's keeper watches.

Oilskin does not attempt to weaken any of these and does not claim to. If
that matters to you, the product is not built for that threat model; say so
to yourself before signing.

## 5 · What changed from the pre-pivot documents

The previous version of this file described a bridge entry with per-quote
deposit addresses, address-reuse warnings and a "Privacy view", and made
claims about the funding side that this product cannot make. None of that
code exists. Those documents survive only as history (`FEEDBACK-ANSWERS.md`,
`V1-SIMPLE.md`, `SECURITY-REVIEW-2026-08.md`, each with a header saying so).
