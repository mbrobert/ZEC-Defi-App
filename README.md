# ZEC Yield Orchestrator

Earn yield on **native ZEC** — from hands-off lending to managed
concentrated-liquidity strategies — with rewards deliverable straight back to
your own Zcash wallet.

**Mode 1 · Simple Lending** — deposit ZEC → supplied as collateral on
[Rhea Finance](https://www.rhea.finance/) (NEAR) → earn supply APY, optionally
borrow against it. No Base involvement.

**Mode 2 · Full Strategy** — additionally borrow USDC/cbBTC/WETH → delivered to
Base via [NEAR Intents](https://docs.near-intents.org/) → deployed into curated
MaxFi / [SnuggleFi](https://www.snuggle.fi/) concentrated-liquidity positions
with your exact parameters (range width, rebalance delay, auto-compound) →
rewards **compound** or are **sent home as native ZEC**.

Simple positions upgrade to Full in place. Withdrawals are never pausable.

## Repo layout

| Path | What | Status |
|------|------|--------|
| `contracts/` | Foundry — PositionVault, RewardRouter, LP adapters + mocks | ✅ 57 tests + 9 live-engine fork tests |
| `agent/` | Zero-dependency Node daemon — monitors, decision engines, 1-Click client, executors | ✅ 62 tests incl. adversarial suite |
| `web/` | Next.js app — deposit wizard, dashboard, BFF stubs | source ready, `npm i` to run |
| `prototype/` | Single-file interactive HTML prototype (no deps) | ✅ open in a browser |
| `packages/shared/` | Types, verified constants, pool registry, presets | ✅ builds |
| `docs/` | ARCHITECTURE · FLOWS · RISKS · INTEGRATIONS | ✅ |

## Quickstart

```bash
# contracts (needs foundry: https://getfoundry.sh)
cd contracts
# first time only — libraries are not vendored in the repo:
git clone --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
forge test -vv

# agent — zero deps; Node ≥ 20
cd agent && npm run test        # tsc + node:test
RHEA_MODE=mock npm run dev      # run the daemon in mock mode

# web
npm install                     # workspace root
npm run dev -w @zyo/web         # http://localhost:3000

# instant demo, no install
open prototype/index.html
```

## How a full strategy moves

```
Zcash wallet ──ZEC──▶ Rhea MCA ──supply──▶ ZEC collateral
                                   │ borrow (≤50% LTV)
                                   ▼
                        NEAR Intents (1-Click)
                                   ▼
                     PositionVault (Base) ──▶ MaxFi/SnuggleFi LP
                                   │ fees/incentives
                                   ▼
                  RewardRouter ──compound──▶ back into LP
                        │
                        └─route──▶ 1-Click ──native ZEC──▶ your Zcash wallet
```

The off-chain agent watches Rhea health factors (warn 1.5 / critical 1.2 /
emergency 1.05), tracks LP range status, and claims rewards only when they
clear gas + bridge costs by a configurable multiple (default 3×, $5 floor,
30-day max hold). Before any send-to-Zcash transaction it hard-verifies the
1-Click quote: recipient must equal the stored Zcash address, destination must
be native ZEC, and the quote hash is emitted on-chain for auditability.

## Security posture

- Principal never routes through the reward path.
- Operator can manage yield, never redirect principal.
- User withdrawal is exempt from `pause()`.
- Per-token routing caps on the RewardRouter.
- `docs/RISKS.md` states every trust assumption plainly.

## Status / next steps

v0.5 — the integration surface is real and fork-verified: the adapter
round-trips deposits, partial exits and full exits against the **deployed
MaxFi/SnuggleFi engine** on a Base mainnet fork; curated pools are pinned to
live registry ids (206-pool registry enumerated on-chain); the Rhea SDK
(Software Development Kit) call sequences are wired; and the 1-Click client is
verified against the live API. Hardening in `docs/AUDIT.md`: MEV
(Maximal Extractable Value) withdrawal slippage floors, per-pool exposure
caps, per-token routing caps, 8 stateful invariants over ~82k random
transitions, a 540-combination scenario matrix, and an adversarial agent
suite. Remaining before mainnet TVL: third-party audit, Safe{Wallet} multisig
+ timelock as owner, production deploy with per-pool caps sized to live TVL.
