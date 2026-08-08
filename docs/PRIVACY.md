# Privacy model — what is private, what is public, and why

ZEC holders are the users here, so this document states the boundary exactly.
Everything below was **probed against the live NEAR Intents 1-Click API on
2026-08-08**, not inferred from documentation.

The product's rule: **the most private available path is the default**, and
wherever privacy ends, the interface says so in plain language rather than
implying protection that does not exist.

## What the rails actually do (measured, not assumed)

| Probe | Result |
|---|---|
| Withdrawal recipient `t1KfLd…PmpG` (transparent) | **HTTP 201** — quote returned, settleable |
| Withdrawal recipient `u1l8xu…` (unified, ZIP-316) | **HTTP 400** `recipient is not valid` |
| Withdrawal recipient `zs1z7r…` (Sapling shielded) | **HTTP 400** `recipient is not valid` |
| Control: malformed t-address | **HTTP 400** — endpoint genuinely validates |
| ZEC deposit address issued for a real quote | `t1PQUiuNdGqJh4hLTPtEWEoH1ru7qkuQHvo` — **transparent, freshly generated per quote, no memo** |

NEAR Intents' own chain-support page agrees: Zcash is *"partially supported —
transparent addresses only."* One caveat stated honestly: our `u1…` probe
string was constructed, so its rejection could in principle be a checksum
failure rather than a type rejection. The documentation and the probe agree, so
we treat transparent-only settlement as the operating assumption and re-probe
on every integration review.

## The three legs

### 1. ZEC in — **your coin history stays private**

The bridge hands out a *transparent* deposit address. That does **not** force
you to hold transparent ZEC: spending from your shielded pool to a transparent
address is an ordinary deshielding transaction. Zcash does not reveal where
shielded funds came from.

- **Private:** your balance, your address, and every prior transaction in your
  history. Nothing links this deposit backwards.
- **Public:** the amount deposited and the fact that *some* shielded holder
  funded this particular deposit address.
- **Product default:** the deposit step assumes you are sending from a shielded
  balance and gives instructions for that path. Transparent funding is
  supported and clearly labeled as the less private option.
- **Helped by the rails:** 1-Click generates a new deposit address per quote, so
  separate deposits are not linked to each other by a shared address.

### 2. The middle — **public, unavoidably**

Once ZEC is bridged it becomes a token on NEAR, is supplied as collateral on
Rhea, is borrowed against, and the borrowed asset is deployed on Base. NEAR and
Base are transparent ledgers. Position sizes, health factors, pool choices,
rebalances, and claims are all publicly visible.

No interface can change this, and we do not dress it up. What privacy *does*
survive here is the link back to you: an observer sees a position, not a person
— provided you do not hand them the link in leg 3.

### 3. ZEC out — **lands public, shield immediately**

Rewards and withdrawals settle to a transparent address you control. The
arrival is visible on the Zcash chain. Your wallet can shield it on receipt —
many wallets do this automatically — and once shielded the funds are private
again.

## What actually deanonymizes people

The bridge is not the weak point. These are:

1. **Reusing one receiving address.** Every position paid to the same t-address
   is publicly linked to every other one, and to you. This is the single
   highest-impact mistake, so the interface tracks addresses across your
   positions and warns on reuse.
2. **Using your deposit-refund address as your reward address.** That directly
   joins the inbound and outbound legs, connecting your Zcash identity to the
   full position.
3. **Amount and timing correlation.** A distinctive amount leaving a shielded
   pool and an identical amount appearing on Base moments later correlates the
   two regardless of address hygiene. Partial mitigations: round amounts, avoid
   unusual values, and let time pass. This one has real residual risk and we say
   so rather than pretending otherwise.
4. **Shielding rewards back into the same account you deposited from.** Fine for
   most threat models, weak against an adversary already watching that account.

## What the product does about it

- Shielded funding is the **default assumption**, with instructions written for
  it — not a buried option.
- Shielded addresses (`u1…`, `zs1…`) are **accepted as input and explained**,
  never met with a dead-end "invalid address". Wallets like Zashi now hand users
  unified addresses by default, so a bare rejection would strand exactly the
  users who care most. The interface asks for the transparent receiving address
  from the same wallet and explains why.
- The agent **fails fast, before requesting a quote**, if a stored address is not
  settleable (`rewardExecutor.ts`, invariant #0). Rewards stay accrued and retry
  — nothing is lost, and the error names the real reason instead of surfacing
  the bridge's generic `recipient is not valid`.
- **Address reuse is detected and flagged** per position.
- A dedicated **Privacy view** shows this boundary map per position, so the
  answer to "what can people see about me?" is a click away.

## If shielded settlement ships

Nothing in the contracts or the agent assumes transparent addresses beyond the
`settleable` check in `packages/shared/src/constants.ts`. When 1-Click accepts
`u1…` recipients, flipping `describeZcashAddress` makes shielded payouts the
default end-to-end; the UI copy keyed off `settleable` follows automatically.
Re-run the probes in this document to confirm before flipping it.
