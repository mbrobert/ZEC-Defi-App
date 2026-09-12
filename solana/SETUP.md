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

## Build, then prove the program on localnet

```bash
cd solana
anchor keys sync              # once: writes target/deploy/oilskin-keypair.json (gitignored) and the program id
anchor build                  # builds programs/oilskin AND programs/mock_scope (the localnet-only Scope stand-in)
cargo test --manifest-path programs/oilskin/Cargo.toml --lib     # 5 host unit tests (health.rs)
```

Localnet with the ZCASH-market world cloned from mainnet (read-only clone; nothing is sent anywhere real):

```bash
bash scripts/localnet.sh                       # terminal 1 — warp-slot above mainnet; klend + Farms cloned; the Scope MOCK at Scope's id; market, reserves, vaults, Scope accounts, mints cloned; ZEC and USDC mint authorities swapped for throwaway keys
anchor test --skip-local-validator             # terminal 2 — deploys oilskin to :8899 and runs tests/*.spec.ts (15)
```

**If a validator from before 2026-09-12 13:00 is still running, restart it with the script above**: the old
world had the real Scope program and a slot-0 ledger, and both make klend refuse every borrow. A second
instance for parallel work: `RPC_PORT=8999 FAUCET_PORT=9901 GOSSIP_PORT=8101 PORT_RANGE=8200-8400
LEDGER=.anchor/test-ledger-2 bash scripts/localnet.sh`, then `anchor test --skip-local-validator
--provider.cluster http://127.0.0.1:8999`.

Why the mock and the warp: `docs/SOLANA-ARCHITECTURE.md` §11. In short, klend refuses a Scope price older than
180 s and overflows on a future-dated one, and its `slots_elapsed` overflows when the validator's slot is below
the cloned reserves' mainnet slot. The fixtures (`fixtures/`, gitignored, regenerated per run) are the two mint
authorities only.

## Key hygiene (the rules in `CLAUDE.md`, applied here)

- `target/deploy/*-keypair.json`, `~/.config/solana/`, `fixtures/*.json` are never committed and never read
  into a Claude session (`.gitignore`, `.claude/settings.json`).
- `anchor deploy`, `solana program deploy`, `anchor upgrade`, `solana transfer` are denied to Claude Code.
  There is nothing to deploy yet; when there is, the founder runs it.
- The keeper's Solana key, when one exists, follows the Base rule: observe-only without it, never in a Claude
  session.
