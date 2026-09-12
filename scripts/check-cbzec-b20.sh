#!/usr/bin/env bash
# check-cbzec-b20.sh — the one fork assertion no fork EVM can execute, done with `cast` against a
# live Base RPC instead.
#
# cbZEC (0xB2000000000000000000008501b13360000cb2EC) is a Base B20 native contract: `eth_getCode`
# returns the single byte 0xef, which Base's node routes to a native implementation and which every
# fork EVM (revm under forge, anvil) treats as an invalid opcode — `OpcodeNotFound` on the first
# call (docs/VERIFIED-BASE-FACTS.md Addendum 3, 2026-09-10). So the former
# `test_fork_cbzecIsAB20WithLiveMultiplier` could never pass inside `forge test`, and on 2026-09-12
# (slice I) it became this script, run by the CI `fork` job at the same pinned block as the suite.
#
# It asserts exactly what the test asserted: the code is the one 0xef byte, decimals() = 8,
# symbol() = "cbZEC", and multiplier() answers with a non-zero 32-byte word (printed, never pinned:
# the multiplier is a rebase factor that MAY change — 1e18 on every read so far). Read-only.
#
#   scripts/check-cbzec-b20.sh <rpc-url> [block]        block defaults to $FORK_BLOCK, else latest
#   FORK_URL=<rpc> FORK_BLOCK=<n> scripts/check-cbzec-b20.sh
#
# Exit 0 = every fact holds at the block it prints. Exit 1 = a mismatch (the chain drifted or the
# RPC is not Base) — the line that failed says which. Needs `cast` (Foundry) on PATH.
set -euo pipefail

RPC="${1:-${FORK_URL:-}}"
BLOCK="${2:-${FORK_BLOCK:-}}"
CBZEC=0xB2000000000000000000008501b13360000cb2EC   # docs/VERIFIED-BASE-FACTS.md, token table

if [ -z "$RPC" ]; then
  echo "check-cbzec-b20: no RPC — pass it as the first argument or set FORK_URL" >&2
  exit 1
fi
command -v cast >/dev/null 2>&1 || { echo "check-cbzec-b20: cast (Foundry) is not on PATH" >&2; exit 1; }

fail() { echo "check-cbzec-b20: FAIL — $*" >&2; exit 1; }

chain=$(cast chain-id --rpc-url "$RPC")
[ "$chain" = "8453" ] || fail "chain id is $chain, not Base (8453)"

if [ -z "$BLOCK" ]; then
  BLOCK=$(cast block-number --rpc-url "$RPC")
  pinned="latest"
else
  pinned="pinned"
fi
at=(--block "$BLOCK" --rpc-url "$RPC")

code=$(cast code "${at[@]}" "$CBZEC")
[ "$code" = "0xef" ] || fail "code at $CBZEC is '$code', not the single B20 byte 0xef (block $BLOCK)"

decimals=$(cast call "${at[@]}" "$CBZEC" 'decimals()(uint8)')
[ "$decimals" = "8" ] || fail "decimals() = $decimals, not 8 (block $BLOCK)"

symbol=$(cast call "${at[@]}" "$CBZEC" 'symbol()(string)')
symbol=${symbol%\"}; symbol=${symbol#\"}
[ "$symbol" = "cbZEC" ] || fail "symbol() = '$symbol', not cbZEC (block $BLOCK)"

# Raw word, exactly as the test decoded it: 32 bytes back, non-zero.
raw=$(cast call "${at[@]}" "$CBZEC" 'multiplier()')
[ "${#raw}" -ge 66 ] || fail "multiplier() returned '${raw}' — fewer than 32 bytes (block $BLOCK)"
multiplier=$(cast --to-dec "$raw")
[ "$multiplier" != "0" ] || fail "multiplier() is zero (block $BLOCK)"

echo "check-cbzec-b20: OK at block $BLOCK ($pinned), chain 8453"
echo "  code(cbZEC)   = $code  (B20 native contract; no fork EVM can execute it)"
echo "  decimals()    = $decimals"
echo "  symbol()      = $symbol"
echo "  multiplier()  = $multiplier  ($(cast --from-wei "$multiplier") × — a rebase factor, printed not pinned)"
