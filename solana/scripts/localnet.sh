#!/usr/bin/env bash
# Start a local validator with the ZCASH-market world cloned from mainnet and the two fixtures applied.
# Read-only against mainnet (clone); nothing is signed or sent anywhere. Run from the repo root or solana/.
#
#   SOLANA_RPC_URL=<keyed rpc, optional>  bash solana/scripts/localnet.sh
#
# Then, in another terminal:  cd solana && anchor test --skip-local-validator
#
# Why not Anchor.toml's [test.validator] alone: two cloned accounts must be REPLACED by patched copies —
# Scope's OraclePrices (its prices go stale in 180 s; see docs/SOLANA-ARCHITECTURE.md §11) and the ZEC mint
# (its authority is the bridge program's PDA, so nothing can mint ZEC locally). solana-test-validator applies
# --account after --clone for the same address, which is what this script relies on.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"

command -v solana-test-validator >/dev/null || { echo "solana-test-validator not on PATH — see solana/SETUP.md"; exit 1; }

# Fixtures (written to solana/fixtures/, gitignored). A throwaway mint authority is generated per run and
# printed; it is a TEST key for a local ledger and is never written anywhere persistent.
node scripts/patch-scope-fixture.mjs --out fixtures --future-timestamps
MINT_AUTH_PUBKEY="$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("fixtures/local-mint-authority.json",JSON.stringify(Array.from(k.secretKey)));console.log(k.publicKey.toBase58())')"
node scripts/patch-scope-fixture.mjs --out fixtures --zec-mint-authority "$MINT_AUTH_PUBKEY"
echo "local ZEC mint authority (test only): $MINT_AUTH_PUBKEY  (secret in solana/fixtures/local-mint-authority.json, gitignored)"

PROGRAMS=(
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
  HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ
  FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr
)
ACCOUNTS=(
  GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd
  6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH 7muPXroaziH8RTD62Ea4gQ3NuAPZswf8Gj7iuPZ6Ae6Y 3oxg1uptz3hSYvPiZEPW1UK2T2G5UUniyc2yjrszQC7R
  FQc32zaNbQnUZmQxd3Fqhg3enqfozyX6K74xcCCHw4NU 8yr67socgzkzXYPMPC8KNCh8eLDPjGvqucLGXmCGdwq4
  EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd C7ipQ9XPEncrVhCLXfHE4aCXPSk1HpPQUr127RwgVG9h HwgFUiBaEHv2QnrpgVxPmWuUC5nqt7iGSna99ZQL8oTB
  HfwrP5s6bL8pGuqAQUGr6S79AEfyWm2F8W6WJkuXmT53 GV12UJQSNK3cQPAGea9bHXcu7STuAadaCLeSwEKirWtQ
  4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg 6cMwdbrJ95D7v5655Zsoe7oXmjQJMnagWK8EcdG6qmGM
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 5mRY96MiFac9DBToh16j5dgq6kiJCPqhPXPzpoNNtxmw
)

ARGS=(--reset --url "$RPC" --ledger .anchor/test-ledger --bind-address 127.0.0.1)
for p in "${PROGRAMS[@]}"; do ARGS+=(--clone-upgradeable-program "$p"); done
for a in "${ACCOUNTS[@]}"; do ARGS+=(--clone "$a"); done
# Patched replacements (same addresses as on mainnet):
ARGS+=(--account 3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH fixtures/scope-oracle-prices.json)
ARGS+=(--account A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS fixtures/zec-mint.json)

echo "starting solana-test-validator with ${#PROGRAMS[@]} programs and ${#ACCOUNTS[@]}+2 accounts cloned from $RPC"
exec solana-test-validator "${ARGS[@]}"
