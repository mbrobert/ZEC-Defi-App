# CLAUDE.md — Oilskin (ZEC-Defi-App)

Read this before doing anything. These are the founder's standing rules; they
override convenience every time.

## What this is

Oilskin: a chain-agnostic, ZEC-holder-centric DeFi app (founder's direction,
2026-09-11/12: wherever a market for ZEC exists, a ZEC holder can deploy it
there through Oilskin). Two modules, both built in full — never a "lite"
notify-only variant:

- **Base module** (this repo today): users deposit cbBTC, WETH or cbZEC into
  their OWN smart account (`OilskinAccount`, EIP-1167 clone, owner = their
  wallet), borrow USDC on Aave v3 — or, for cbZEC, on a Morpho Blue
  cbZEC/USDC market the founder creates (Chainlink ZEC/USD is live on Base) —
  and deploy it into Aerodrome Slipstream liquidity through the MaxFi/Snuggle
  engine when the yield gate clears. A keeper (`agent/`) protects health inside
  a signed, scoped grant.
- **Solana module** (designed 2026-09-12, no handlers yet): bridged ZEC
  (NEAR Intents / OmniBridge) as collateral on Kamino's ZCASH market, USDC
  borrowed, the same ladder run by an Anchor program + PDA the user's wallet
  owns. Facts in `docs/VERIFIED-SOLANA-FACTS.md`; design in
  `docs/SOLANA-ARCHITECTURE.md`; direction in `docs/DIRECTION-2026-09-11.md`.
  No instruction handlers are written until the founder has read the design.

A loan never crosses a chain. Shared across chains: the health ladder, the
entry rule, the yield-gate math, the copy rules, the one website.
Nothing is deployed yet. Start with `README.md`, `SETUP.md`,
`docs/DIRECTION-2026-09-11.md`, `docs/BASE-PIVOT-2026-09.md`,
`docs/VERIFIED-BASE-FACTS.md`, `docs/VERIFIED-SOLANA-FACTS.md`,
`docs/AUDIT-2026-09-06.md`, `docs/TESTING.md`.

## Hard rules (never break these)

1. **Never construct, sign, or broadcast a transaction.** You may write and test
   code that does, and you may run read-only chain calls (`cast call`,
   `eth_call`, `eth_getLogs`). Deploys and any signed action are run by the
   founder himself, in his terminal, with his keys.
2. **Never read, request, print, or store a private key, seed phrase, keystore
   file, keystore password, or API secret.** `.env`, `.env.*`,
   `~/.foundry/keystores/`, and anything under `~/Documents/**/sensitive` are off
   limits (also enforced in `.claude/settings.json`). Public addresses and tx
   hashes are fine. If a task needs a secret, stop and tell the founder which
   variable to set and where; do not look for it.
3. **Never invent a number.** Every address, parameter, rate, LTV, heartbeat,
   or tick bound must be read from the chain or a primary source, dated, and
   recorded in `docs/VERIFIED-BASE-FACTS.md` before code depends on it. Probe
   every external contract on-chain (`cast code` non-empty, a real selector
   returns) before building on it — one "well-known" router address had no code.
4. **No financial or legal advice.** Model scenarios with the inputs stated;
   the founder decides.
5. **Push every green commit immediately.** GitHub `mbrobert/ZEC-Defi-App`
   `main` is the source of truth. A container recycle once lost 158 files of
   unpushed work; do not let that happen again. Commit → run the relevant
   suite → push. Never force-push `main`.
6. **When you remove or supersede something, grep for everything that still
   refers to it** (docs, copy, tests, prototypes) and strip it in the same
   commit. Replace, don't accumulate.
7. **Copy, don't move; deletions are the founder's job.** Never `rm` files the
   founder created; propose the deletion and let him do it.
8. **Spell out acronyms on first use** in any doc or user-facing copy
   (LTV = loan-to-value, HF = health factor, LP = liquidity provision, …).
9. **Honest copy.** Never claim "no operator custody", "guaranteed", "safe",
   "risk-free", or any word in `web/lib/copy.ts` `BANNED_WORDS`. A timelocked
   registry owner is still an owner; say so.
10. **Model discipline.** The founder runs this on Claude Fable 5.1 at high
    effort only. If you notice you are a different model, say so at the top of
    your reply and stop until he confirms.

## Working conventions

- Node ≥ 22, npm workspaces (`packages/shared`, `agent`, `services/yield`,
  `web`, `solana`). Build `packages/shared` first; every consumer imports its `dist/`.
- `solana/` is an Anchor workspace (Rust + Solana CLI + Anchor 1.2.0, installed
  by the founder per `solana/SETUP.md`); the ladder constants in
  `solana/programs/oilskin/src/generated/ladder.rs` are generated from
  `packages/shared` (`node solana/scripts/gen-ladder.mjs`) and pinned by
  `npm test -w @zyo/solana`. Never commit or read `target/deploy/*.json`,
  `~/.config/solana/`, or `solana/fixtures/*.json`.
- Foundry for `contracts/` (solc 0.8.24, via-IR, EVM cancun). Libraries are
  cloned into `contracts/lib/` and are NOT committed (see `SETUP.md`).
- Before claiming anything is done, run the suite that proves it and quote the
  count (`docs/TESTING.md` lists the expected counts). A suite that was green
  before your change must be green after it.
- Contract ABI (application binary interface) is generated, never hand-typed:
  `node scripts/verify-abi.mjs --write` → `contracts/abi/oilskin-abi.json` →
  `web/scripts/sync-abi.mjs`. If you touch a signature, regenerate both and run
  the agent's ABI seam (`npm test -w @zyo/agent`).
- Findings go in a dated `docs/AUDIT-*.md` with severity, file:line, the
  failing scenario, the fix commit, and the regression test path. Regression
  tests live in `contracts/test/audit-regressions/`.
- Keep the Simple / Advanced toggle. Every flow is written for someone who has
  never used DeFi: one decision per screen, plain words, the risk stated
  before the button.
- Prefer small commits with messages that say what changed and why. End commit
  messages with the Co-Authored-By trailer Claude Code adds by default.
- Do not run the keeper, yield service, or web app against mainnet with a
  signing key. Observe-only mode (no `KEEPER_PRIVATE_KEY`) is the only mode you
  run.
