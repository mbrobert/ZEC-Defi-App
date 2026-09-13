#!/usr/bin/env bash
# Start a local validator with the ZCASH-market world cloned from mainnet, Scope replaced by the localnet mock,
# and the two mint fixtures applied. Read-only against mainnet (clone); nothing is sent anywhere real.
#
#   bash solana/scripts/localnet.sh                       # default ports (RPC 8899), ledger .anchor/test-ledger
#   RPC_PORT=8999 FAUCET_PORT=9901 GOSSIP_PORT=8101 LEDGER=.anchor/test-ledger-2 FIXTURES=fixtures-2 PORT_RANGE=10100-10400 bash solana/scripts/localnet.sh
#   (a second validator: its own ledger, ports AND fixtures directory; run the specs with OILSKIN_FIXTURES=fixtures-2.
#   The websocket port is RPC_PORT + 1, so RPC_PORT and RPC_PORT + 1 must BOTH be free — a second validator on
#   8998 beside one on 8999 starts, then confirms nothing: every spec times out in its `before` hook.)
#   SOLANA_RPC_URL=<keyed rpc>  …                         # kinder to the clone than the public endpoint
#
# Then:  cd solana && anchor test --skip-local-validator [--provider.cluster http://127.0.0.1:8999]
#
# Why Scope is a mock here: Kamino's refresh_reserve refuses a Scope price older than 180 s and OVERFLOWS on a
# future-dated one (klend last_update.rs:96), so a static fixture cannot keep prices fresh. `programs/mock_scope`
# is loaded AT SCOPE'S PROGRAM ID; the cloned OraclePrices account (owner = that id) is then writable by the
# tests, which stamp it fresh before every Kamino-touching call and move the ZEC price to walk the ladder.
# Kamino never CPIs into Scope, so nothing else changes. See docs/SOLANA-ARCHITECTURE.md §11.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"
RPC_PORT="${RPC_PORT:-8899}"
FAUCET_PORT="${FAUCET_PORT:-9900}"
GOSSIP_PORT="${GOSSIP_PORT:-8001}"
LEDGER="${LEDGER:-.anchor/test-ledger}"
# klend's refresh_reserve computes `current_slot − reserve.last_update.slot` with a checked subtraction, and the
# cloned reserves carry MAINNET slot numbers (~446 M), so a validator that starts at slot 0 overflows
# (last_update.rs:96 MathOverflow). Start above mainnet's current slot instead.
WARP_SLOT="${WARP_SLOT:-$(node -e 'fetch(process.argv[1],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot"})}).then(r=>r.json()).then(j=>console.log(j.result+1000000))' "$RPC")}"

command -v solana-test-validator >/dev/null || { echo "solana-test-validator not on PATH — see solana/SETUP.md"; exit 1; }
[ -f target/deploy/mock_scope.so ] || { echo "target/deploy/mock_scope.so missing — run: anchor build"; exit 1; }

# Mint fixtures (solana/fixtures/, gitignored). Throwaway mint authorities are generated per run and printed;
# they are TEST keys for a local ledger and are never written anywhere persistent. A SECOND validator on this
# machine (another ledger) must write its fixtures to its own directory — `FIXTURES=fixtures-<name>` here and
# `OILSKIN_FIXTURES=fixtures-<name>` for the specs — or it would silently replace the mint authorities the first
# validator was started with and every spec against the first one would fail at mintTo (2026-09-13).
FIXTURES="${FIXTURES:-fixtures}"
if [ "$LEDGER" != ".anchor/test-ledger" ] && [ "$FIXTURES" = "fixtures" ]; then
  echo "LEDGER=$LEDGER is not the default ledger: set FIXTURES=fixtures-<name> (and OILSKIN_FIXTURES for the specs) so this validator's mint keys do not replace the default validator's" >&2
  exit 1
fi
mkdir -p "$FIXTURES"
gen_key() { node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync(process.argv[1],JSON.stringify(Array.from(k.secretKey)));console.log(k.publicKey.toBase58())' "$1"; }
ZEC_AUTH="$(gen_key "$FIXTURES/local-mint-authority.json")"
USDC_AUTH="$(gen_key "$FIXTURES/local-usdc-mint-authority.json")"
node scripts/patch-scope-fixture.mjs --out "$FIXTURES" --zec-mint-authority "$ZEC_AUTH" --usdc-mint-authority "$USDC_AUTH"
echo "local ZEC mint authority (test only):  $ZEC_AUTH"
echo "local USDC mint authority (test only): $USDC_AUTH"

PROGRAMS=(
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD   # Kamino Lend (with its programdata)
  FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr   # Kamino Farms
  CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe   # Circle CCTP V2 TokenMessengerMinterV2 (deposit_for_burn; VERIFIED-SOLANA-FACTS Addendum 3)
  CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC   # Circle CCTP V2 MessageTransmitterV2 (send_message)
)
ACCOUNTS=(
  GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd
  6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH 7muPXroaziH8RTD62Ea4gQ3NuAPZswf8Gj7iuPZ6Ae6Y 3oxg1uptz3hSYvPiZEPW1UK2T2G5UUniyc2yjrszQC7R
  FQc32zaNbQnUZmQxd3Fqhg3enqfozyX6K74xcCCHw4NU 8yr67socgzkzXYPMPC8KNCh8eLDPjGvqucLGXmCGdwq4
  EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd C7ipQ9XPEncrVhCLXfHE4aCXPSk1HpPQUr127RwgVG9h HwgFUiBaEHv2QnrpgVxPmWuUC5nqt7iGSna99ZQL8oTB
  HfwrP5s6bL8pGuqAQUGr6S79AEfyWm2F8W6WJkuXmT53 GV12UJQSNK3cQPAGea9bHXcu7STuAadaCLeSwEKirWtQ
  3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH   # Scope OraclePrices — owner HFn8…, which the mock below now is
  4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg 6cMwdbrJ95D7v5655Zsoe7oXmjQJMnagWK8EcdG6qmGM
  5mRY96MiFac9DBToh16j5dgq6kiJCPqhPXPzpoNNtxmw   # ZEC Metaplex metadata
  AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux   # CCTP token_messenger, token_minter
  CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1 BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM   # CCTP local_token[USDC], remote_token_messenger[6 = Base]
  W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU   # CCTP message_transmitter (domain 5)
  3udrkuozTYGBVMyMdxmXWVTUrnpmSh7kEZiq67A8jTws 6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L   # CCTP token_pair[6, Base USDC], custody[USDC] — the receive side (Addendum 4)
  6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3   # CCTP fee recipient USDC token account
)

ARGS=(--reset --url "$RPC" --ledger "$LEDGER" --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "${PORT_RANGE:-8000-10000}" --warp-slot "$WARP_SLOT")
for p in "${PROGRAMS[@]}"; do ARGS+=(--clone-upgradeable-program "$p"); done
for a in "${ACCOUNTS[@]}"; do ARGS+=(--clone "$a"); done
ARGS+=(--bpf-program HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ target/deploy/mock_scope.so)   # the Scope mock, at Scope's id
ARGS+=(--account A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS "$FIXTURES/zec-mint.json")
ARGS+=(--account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v "$FIXTURES/usdc-mint.json")

echo "warp slot $WARP_SLOT (above mainnet, so cloned last_update slots are in the past)"
echo "starting solana-test-validator on :$RPC_PORT — ${#PROGRAMS[@]} programs + Scope mock, ${#ACCOUNTS[@]}+2 accounts cloned from $RPC"
exec solana-test-validator "${ARGS[@]}"
