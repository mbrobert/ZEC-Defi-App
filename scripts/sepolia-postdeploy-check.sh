#!/usr/bin/env bash
# sepolia-postdeploy-check.sh — DEPLOY-SEPOLIA.md §5.1–§5.4 as one read-only run (slice J,
# 2026-09-12). Every line is a `cast call`; nothing is signed or sent. Addresses come from
# docs/DEPLOYMENTS.md ("Base Sepolia" table) unless overridden in the environment
# (FACTORY, REGISTRY, ROUTER, AAVE_VENUE, LP_VENUE, SWAP_ADAPTER, MORPHO_VENUE, CBZEC, ENGINE,
# MOCK_POOL, MOCK_SWAP_ROUTER, TREASURY, REGISTRY_OWNER, DEPLOYER). Expected values are the ones
# the facts document records (VERIFIED-BASE-FACTS.md, Sepolia addenda) — if a live value differs,
# the chain drifted or the deploy did not do what the script says, and the line says which.
#
#   scripts/sepolia-postdeploy-check.sh                  # reads docs/DEPLOYMENTS.md
#   RPC=<url> scripts/sepolia-postdeploy-check.sh        # another Sepolia endpoint
#
# Exit 0 = every check passed; 1 = at least one FAIL; 2 = no addresses to check yet.
set -uo pipefail

RPC="${RPC:-https://sepolia.base.org}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC="${DEPLOYMENTS_MD:-$HERE/../docs/DEPLOYMENTS.md}"
command -v cast >/dev/null 2>&1 || { echo "cast (Foundry) is not on PATH" >&2; exit 2; }

# The first 0x… (40 hex) on the row whose first cell is the key, inside the Base Sepolia section.
fromdoc() {
  awk -v key="$1" '
    /^## Base Sepolia/ {in_s=1; next}
    /^## / {in_s=0}
    in_s && $0 ~ "^\\| " key " \\|" {
      if (match($0, /0x[0-9a-fA-F]{40}/)) { print substr($0, RSTART, RLENGTH); exit }
    }' "$DOC"
}
pick() { local var="$1" key="$2"; local v="${!var:-}"; [ -n "$v" ] || v="$(fromdoc "$key")"; printf '%s' "$v"; }

FACTORY=$(pick FACTORY OilskinAccountFactory)
REGISTRY=$(pick REGISTRY CollateralRegistry)
ROUTER=$(pick ROUTER StrategyRouter)
AAVE_VENUE=$(pick AAVE_VENUE AaveV3Venue)
LP_VENUE=$(pick LP_VENUE SnuggleLpVenue)
SWAP_ADAPTER=$(pick SWAP_ADAPTER AerodromeSwapAdapter)
MORPHO_VENUE=$(pick MORPHO_VENUE MorphoBlueVenue)
CBZEC=$(pick CBZEC "cbZEC double \\(MockB20\\)")
ENGINE=$(pick ENGINE "engine double \\(MockSnuggleVault\\)")
MOCK_POOL=$(pick MOCK_POOL "cbZEC/USDC pool double \\(MockCLPool\\)")
MOCK_SWAP_ROUTER=$(pick MOCK_SWAP_ROUTER "swap router double \\(MockAerodromeSwapRouter\\)")
TREASURY=$(pick TREASURY treasury)
REGISTRY_OWNER=$(pick REGISTRY_OWNER registryOwner)
DEPLOYER=$(pick DEPLOYER deployer)

if [ -z "$ROUTER" ] || [ -z "$REGISTRY" ] || [ -z "$FACTORY" ]; then
  echo "no Base Sepolia addresses in $DOC yet (StrategyRouter / CollateralRegistry / OilskinAccountFactory rows are empty) — deploy first (DEPLOY-SEPOLIA.md §4), fill the table, run again"
  exit 2
fi

# Real Sepolia dependencies (packages/shared CHAINS[84532]; VERIFIED-BASE-FACTS.md Sepolia addenda).
USDC=0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f
WETH=0x4200000000000000000000000000000000000006
WBTC=0x54114591963CF60EF3aA63bEfD6eC263D98145a4
PROVIDER=0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
POOL_ID=0x446b5f09e94e0becef972a2a3f2f0111ccb8cacb3146aa704bf8f75a6fe3e1d9   # keccak256("aero-cl200-USDC-cbZEC")

pass=0; fail=0
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>&1 | head -1 | awk '{print $1}'; }
# check <label> <actual> <expected> ; addresses compared case-insensitively
check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$(lc "$actual")" = "$(lc "$expected")" ]; then pass=$((pass + 1)); echo "ok    $label = $actual"
  else fail=$((fail + 1)); echo "FAIL  $label = $actual (expected $expected)"; fi
}
optional() { [ -n "$2" ] || { echo "skip  $1 — no address in the table"; return 1; }; }

chain=$(cast chain-id --rpc-url "$RPC"); check "chain id" "$chain" 84532
echo "block $(cast block-number --rpc-url "$RPC") at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "--- 5.1 wiring"
check "router.REGISTRY()" "$(call "$ROUTER" 'REGISTRY()(address)')" "$REGISTRY"
optional LP_VENUE "$LP_VENUE" && check "router.LP_VENUE()" "$(call "$ROUTER" 'LP_VENUE()(address)')" "$LP_VENUE"
optional SWAP_ADAPTER "$SWAP_ADAPTER" && check "router.SWAP()" "$(call "$ROUTER" 'SWAP()(address)')" "$SWAP_ADAPTER"
check "router.USDC() is Aave's test USDC, not Circle's" "$(call "$ROUTER" 'USDC()(address)')" "$USDC"
check "router.PERMIT2()" "$(call "$ROUTER" 'PERMIT2()(address)')" "$PERMIT2"
optional AAVE_VENUE "$AAVE_VENUE" && {
  check "aaveVenue.PROVIDER()" "$(call "$AAVE_VENUE" 'PROVIDER()(address)')" "$PROVIDER"
  check "aaveVenue.REGISTRY()" "$(call "$AAVE_VENUE" 'REGISTRY()(address)')" "$REGISTRY"
}
optional SWAP_ADAPTER "$SWAP_ADAPTER" && optional MOCK_SWAP_ROUTER "$MOCK_SWAP_ROUTER" && check "swapAdapter.ROUTER() is the mock" "$(call "$SWAP_ADAPTER" 'ROUTER()(address)')" "$MOCK_SWAP_ROUTER"
optional LP_VENUE "$LP_VENUE" && optional ENGINE "$ENGINE" && check "lpVenue.ENGINE() is the mock" "$(call "$LP_VENUE" 'ENGINE()(address)')" "$ENGINE"

echo "--- 5.2 registry state, ownership, timelock"
owner=$(call "$REGISTRY" 'owner()(address)'); pending=$(call "$REGISTRY" 'pendingOwner()(address)')
if [ -n "$REGISTRY_OWNER" ] && [ "$(lc "$owner")" = "$(lc "$REGISTRY_OWNER")" ]; then
  pass=$((pass + 1)); echo "ok    registry.owner() = $owner (accepted); pendingOwner = $pending"
elif [ -n "$REGISTRY_OWNER" ] && [ "$(lc "$pending")" = "$(lc "$REGISTRY_OWNER")" ]; then
  pass=$((pass + 1)); echo "ok    registry.owner() = $owner, pendingOwner = $pending (hand-off PENDING — §5.5a not yet run)"
else
  fail=$((fail + 1)); echo "FAIL  registry.owner() = $owner, pendingOwner = $pending (expected registryOwner $REGISTRY_OWNER as owner or pending)"
fi
check "registry.TIMELOCK_DELAY()" "$(call "$REGISTRY" 'TIMELOCK_DELAY()(uint256)')" 172800
check "registry.entryHfFloorWad()" "$(call "$REGISTRY" 'entryHfFloorWad()(uint256)')" 1550000000000000000
check "isEnabled(WBTC stand-in)" "$(call "$REGISTRY" 'isEnabled(address)(bool)' "$WBTC")" true
check "isEnabled(WETH)" "$(call "$REGISTRY" 'isEnabled(address)(bool)' "$WETH")" true
optional CBZEC "$CBZEC" && check "isEnabled(cbZEC double) — disabled with its note" "$(call "$REGISTRY" 'isEnabled(address)(bool)' "$CBZEC")" false
check "maxOfferedLtvBps(WBTC)" "$(call "$REGISTRY" 'maxOfferedLtvBps(address)(uint256)' "$WBTC")" 5000
check "maxOfferedLtvBps(WETH)" "$(call "$REGISTRY" 'maxOfferedLtvBps(address)(uint256)' "$WETH")" 5000
optional CBZEC "$CBZEC" && check "maxOfferedLtvBps(cbZEC double)" "$(call "$REGISTRY" 'maxOfferedLtvBps(address)(uint256)' "$CBZEC")" 0

echo "--- 5.3 risk parameters, read live from Aave (facts: WETH 8500/8350, WBTC 8300/8150)"
optional AAVE_VENUE "$AAVE_VENUE" && {
  check "WETH liquidationThresholdBps" "$(call "$AAVE_VENUE" 'liquidationThresholdBps(address)(uint256)' "$WETH")" 8500
  check "WETH maxLtvBps" "$(call "$AAVE_VENUE" 'maxLtvBps(address)(uint256)' "$WETH")" 8350
  check "WBTC liquidationThresholdBps" "$(call "$AAVE_VENUE" 'liquidationThresholdBps(address)(uint256)' "$WBTC")" 8300
  check "WBTC maxLtvBps" "$(call "$AAVE_VENUE" 'maxLtvBps(address)(uint256)' "$WBTC")" 8150
  check "aaveVenue.enabled()" "$(call "$AAVE_VENUE" 'enabled()(bool)')" true
}
optional MORPHO_VENUE "$MORPHO_VENUE" && check "morphoVenue.enabled() — no market on Sepolia" "$(call "$MORPHO_VENUE" 'enabled()(bool)')" false

echo "--- 5.4 account determinism and the LP venue"
impl=$(call "$FACTORY" 'IMPLEMENTATION()(address)'); echo "info  factory.IMPLEMENTATION() = $impl"
if [ -n "$DEPLOYER" ]; then
  echo "info  factory.accountOf(deployer) = $(call "$FACTORY" 'accountOf(address)(address)' "$DEPLOYER"), isDeployed = $(call "$FACTORY" 'isDeployed(address)(bool)' "$DEPLOYER")"
fi
optional LP_VENUE "$LP_VENUE" && {
  check "lpVenue.performanceBps()" "$(call "$LP_VENUE" 'performanceBps()(uint256)')" 1000
  [ -n "$TREASURY" ] && check "lpVenue.treasury()" "$(call "$LP_VENUE" 'treasury()(address)')" "$TREASURY"
  pt=$(cast call "$LP_VENUE" 'poolTokens(bytes32)(address,address,address)' "$POOL_ID" --rpc-url "$RPC" 2>&1 | awk '{print $1}' | tr '\n' ' ')
  set -- $pt
  check "poolTokens(cbZEC pool id).token0 = test USDC" "${1:-}" "$USDC"
  [ -n "$CBZEC" ] && check "poolTokens(cbZEC pool id).token1 = cbZEC double" "${2:-}" "$CBZEC"
  [ -n "$MOCK_POOL" ] && check "poolTokens(cbZEC pool id).pool = mock pool" "${3:-}" "$MOCK_POOL"
}

echo "--- $pass ok, $fail FAIL"
[ "$fail" -eq 0 ]
