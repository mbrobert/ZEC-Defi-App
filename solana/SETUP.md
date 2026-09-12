# Solana module — setup (`solana/`)

What is here on 2026-09-12: the facts readers, the shared-ladder seam, the Anchor workspace with an **empty**
program (no instruction handlers, by the founder's instruction until `docs/SOLANA-ARCHITECTURE.md` is read),
and the localnet harness. Toolchain versions are the ones crates.io and npm published as stable on 2026-09-12;
confirm them at the first build and record what actually built in `docs/TESTING.md`.

Abbreviations: PDA = program-derived address; CLI = command-line interface; RPC = remote procedure call.

## What runs today without any Solana toolchain

```bash
npm install                              # root; the solana workspace's dependencies pin @kamino-finance/klend-sdk 12.0.0
npm run build -w @zyo/shared
npm test -w @zyo/solana                  # the ladder seam: generated/ladder.rs == packages/shared (node:test)
node solana/scripts/gen-ladder.mjs       # regenerate programs/oilskin/src/generated/ladder.rs after a shared change
SOLANA_RPC_URL=<rpc> BASE_AAVE_USDC_BORROW_APR_PCT=<pct> npm run facts -w @zyo/solana        # → solana/.facts/facts.json
SOLANA_RPC_URL=<rpc> npm run authorities -w @zyo/solana                                     # → solana/.facts/authorities.json
```

The public RPC (`https://api.mainnet-beta.solana.com`) works for the readers but rate-limits `getTransaction`
bursts; the readers back off and retry. Set `SOLANA_RPC_URL` in `.env` (Claude Code never reads `.env`).

## Toolchain (the founder installs these; Claude Code does not run installers)

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
exec $SHELL && rustc --version

# Solana CLI (Agave 4.2.2, stable 2026-08-28) — installs to ~/.local/share/solana/install/active_release/bin
sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.2/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
solana config set --url localhost

# A local CLI keypair for the validator / test fee payer. It lives at ~/.config/solana/id.json — a path
# .claude/settings.json denies to Claude Code. It is a test key; never fund it on mainnet.
solana-keygen new --no-bip39-passphrase

# Anchor (via avm) — 1.2.0 is crates.io's max_stable for anchor-cli on 2026-09-12
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 1.2.0 && avm use 1.2.0
anchor --version
```

## Build, then prove the harness

```bash
cd solana
anchor keys sync              # writes target/deploy/oilskin-keypair.json (gitignored) and rewrites the placeholder id
anchor build                  # compiles the empty program + the generated ladder module
```

Localnet with the ZCASH-market world cloned from mainnet (read-only clone; nothing is sent anywhere):

```bash
bash scripts/localnet.sh                       # terminal 1 — clones klend, Scope, Farms, the market, reserves, vaults, mints
anchor test --skip-local-validator             # terminal 2 — tests/localnet.spec.ts: the world and both fixtures are present
```

What the two fixtures are for is in `docs/SOLANA-ARCHITECTURE.md` §11: Scope prices are stamped with a
far-future timestamp so Kamino's 180 s staleness check passes on a fresh validator (**first thing to verify:
that klend does not reject a future timestamp**), and the ZEC mint's authority is swapped for a throwaway local
key so tests can mint collateral (`fixtures/local-mint-authority.json`, gitignored, regenerated per run).

## Key hygiene (the rules in `CLAUDE.md`, applied here)

- `target/deploy/*-keypair.json`, `~/.config/solana/`, `fixtures/*.json` are never committed and never read
  into a Claude session (`.gitignore`, `.claude/settings.json`).
- `anchor deploy`, `solana program deploy`, `anchor upgrade`, `solana transfer` are denied to Claude Code.
  There is nothing to deploy yet; when there is, the founder runs it.
- The keeper's Solana key, when one exists, follows the Base rule: observe-only without it, never in a Claude
  session.
