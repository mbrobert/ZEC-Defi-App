#!/usr/bin/env bash
# scripts/ledger-read.sh — re-read the top ledger of docs/VERIFIED-BASE-FACTS.md at ONE pinned block.
#
#   scripts/ledger-read.sh [rpc] [block]        (defaults: https://mainnet.base.org, 51226072)
#
# Read-only: `cast call --block` / `cast code` only, no key, nothing signed. Every value the demo
# snapshot carries (web/lib/demo.ts DEMO_MARKET, the prototypes' OIL_CHAIN_READ, the facts file's
# tables) comes from this output: Aave reserve config + rates (ray words; the 4-dp digits are the
# yield service's rayToPct truncation), Chainlink answers with their updatedAt, Pyth ZEC/USD, the
# cbZEC/USDC pool's slot0 / liquidity / fee and its gauge, the Comet utilisation, token supplies and
# code sizes. Pace: 0.4 s between calls — mainnet.base.org rate-limits bursts, and publicnode
# refuses pinned-block reads without a token (HTTP 403). First used 2026-09-12 (Addendum 14); pair
# it with the yield sample's block (`npm run backfill -w @zyo/yield -- sample`) so the demo is one
# read. Needs Foundry's `cast` on PATH.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${1:-https://mainnet.base.org}
B=${2:-51226072}; TS=$(cast block $B --rpc-url $RPC -f timestamp)
echo "block $B timestamp $TS ($(date -u -r $TS +%Y-%m-%dT%H:%M:%SZ)) chain $(cast chain-id --rpc-url $RPC)"
c() { cast call --block $B --rpc-url $RPC "$@"; sleep 0.4; }
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; WETH=0x4200000000000000000000000000000000000006; CBBTC=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf; CBZEC=0xB2000000000000000000008501b13360000cb2EC; AERO=0x940181a94A35A4569E4529A3CDfB74e38FD98631
echo "== token supplies"
for t in USDC:$USDC WETH:$WETH cbBTC:$CBBTC cbZEC:$CBZEC AERO:$AERO; do n=${t%%:*}; a=${t##*:}; echo "$n totalSupply $(c $a 'totalSupply()(uint256)' | awk '{print $1}')"; done
echo "cbZEC multiplier $(c $CBZEC 'multiplier()(uint256)' | awk '{print $1}')"
DP=0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A; PROV=0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
echo "== aave provider"
echo "pool $(c $PROV 'getPool()(address)') dataProvider $(c $PROV 'getPoolDataProvider()(address)') oracle $(c $PROV 'getPriceOracle()(address)')"
echo "== aave reserves (config: decimals,ltv,lt,bonus,reserveFactor,collateral,borrowing,stableBorrow,active,frozen | data: unbacked,accruedToTreasury,totalAToken,totalStableDebt,totalVariableDebt,liquidityRate,variableBorrowRate,stableBorrowRate,avgStable,liquidityIndex,variableBorrowIndex,lastUpdate)"
for t in cbBTC:$CBBTC WETH:$WETH USDC:$USDC cbZEC:$CBZEC; do n=${t%%:*}; a=${t##*:}
  cfg=$(c $DP 'getReserveConfigurationData(address)(uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)' $a | awk '{print $1}' | tr '\n' ' ')
  dat=$(c $DP 'getReserveData(address)(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)' $a | awk '{print $1}' | tr '\n' ' ')
  paused=$(c $DP 'getPaused(address)(bool)' $a 2>/dev/null | awk '{print $1}')
  echo "$n config: $cfg"; echo "$n data: $dat"; echo "$n paused: $paused"
done
echo "== chainlink feeds (roundId, answer, startedAt, updatedAt, answeredInRound)"
for f in BTC_USD:0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F ETH_USD:0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 USDC_USD:0x7e860098F58bBFC8648a4311b374B1D669a2bc6B cbBTC_USD:0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D; do n=${f%%:*}; a=${f##*:}; echo "$n $(c $a 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' | awk '{print $1}' | tr '\n' ' ') desc=$(c $a 'description()(string)')"; done
echo "== pyth ZEC/USD (price, conf, expo, publishTime)"
echo "$(c 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a 'getPriceUnsafe(bytes32)((int64,uint64,int32,uint256))' 0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24)"
echo "== cbZEC/USDC pool + gauge"
POOL=0x0Fc47C17AF86078d809358db1b4db2DeBC988566; G=0x8779E34E5d38358B0cB957c553B40cC1208C81FB
echo "slot0 $(c $POOL 'slot0()(uint160,int24,uint16,uint16,uint16,bool)' | awk '{print $1}' | tr '\n' ' ')"; echo "liquidity $(c $POOL 'liquidity()(uint128)' | awk '{print $1}')"; echo "fee $(c $POOL 'fee()(uint24)' | awk '{print $1}')"
echo "gauge rewardRate $(c $G 'rewardRate()(uint256)' | awk '{print $1}') periodFinish $(c $G 'periodFinish()(uint256)' | awk '{print $1}')"
echo "== compound v3 usdc comet utilization"
echo "$(c 0xb125E6687d4313864e53df431d5425969c15Eb2F 'getUtilization()(uint256)' | awk '{print $1}')"
echo "== code presence (bytes)"
for x in Morpho:0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb Permit2:0x000000000022D473030F116dDEE9F6B43aC78BA3 CoWSettlement:0x9008D19f58AAbD9eD0D60971565AA8510560ab41 Pyth:0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a; do n=${x%%:*}; a=${x##*:}; code=$(cast code --block $B --rpc-url $RPC $a); echo "$n $(( (${#code} - 2) / 2 ))"; sleep 0.4; done
