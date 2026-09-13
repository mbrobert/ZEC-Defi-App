# Deploying Oilskin to Base Sepolia (chain id 84532)

Status: **prepared, not deployed.** Every command that signs is run by the founder, in his own
terminal, with his own keys. Nothing in this file was broadcast.

Facts behind every address here: `docs/VERIFIED-BASE-FACTS.md`, "Addendum — Base Sepolia" and
"Addendum 2 — Base Sepolia deploy dependencies" (read 2026-09-07). The script is
`contracts/script/DeploySepolia.s.sol`; it is proved offline by `contracts/test/DeploySepolia.t.sol`
(8 tests) and its guard was cleared against the live chain by the dry run in §3.

Acronyms on first use: LTV = loan-to-value, LT = liquidation threshold, HF = health factor,
LP = liquidity provision, RPC = remote procedure call, ABI = application binary interface.

---

## 1. What is real on Sepolia and what is substituted

Real, read from the chain: Aave v3 (pool, data provider, oracle), the WETH / test-USDC / test-WBTC
reserves, three Chainlink feeds, Pyth, Permit2, Morpho Blue.

Absent on Base Sepolia, so substituted **behind the same interfaces the mainnet contracts are
already compiled against**:

| Missing on Sepolia | Substitute the script deploys | Interface it satisfies |
|---|---|---|
| cbZEC | `MockB20` (8 dp, live `multiplier()`, blocklist, pause) | the B20 shape read on mainnet |
| cbBTC | Aave's **real** test WBTC reserve — no mock at all | a genuine Aave reserve; supply-only |
| AERO | `MockERC20` (18 dp) | `SnuggleLpVenue.REWARD_TOKEN` |
| Aerodrome Slipstream cbZEC/USDC pool | `MockCLPool` at mainnet tick −24,509 | `IAerodromeCLPool` |
| MaxFi/Snuggle engine | `MockSnuggleVault` (index getter, re-key, 60 s hold) | `ISnuggleVault` |
| Aerodrome Slipstream SwapRouter | `MockAerodromeSwapRouter` priced from the same tick | `IAerodromeSwapRouter` |

The **Oilskin contracts themselves are deployed by the unchanged `Deploy.deploy()`**, so the order
the audit reviewed is what runs: registry (with its immutable timelock) → `AaveV3Venue` against
that registry → assets registered → two-step ownership hand-off → swap adapter → router.

**What a Sepolia run proves:** wallet → factory → account → registry → `AaveV3Venue` → supply →
borrow → `StrategyRouter`, against real Aave, real Permit2 and real Chainlink.
**What it does not prove:** anything about the live engine or the live Slipstream router. That stays
the job of the 11 mainnet fork tests plus `scripts/check-cbzec-b20.sh`.

**The mocks keep their public test switches** (`setPaused`, `setGlitch`, `setMultiplier`, …) and
anyone on the testnet can call them. That is acceptable for a testnet the founder alone exercises,
and it is one more reason none of these addresses may ever appear in a mainnet artefact.

`StrategyRouter.USDC()` on Sepolia is **Aave's test USDC** `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`,
not Circle's Sepolia USDC — Circle's token exists on the chain but is not an Aave reserve, so it
cannot be borrowed.

---

## 2. Before you run anything

**a. Import the deployer key.** You run this; it is never automated and its output is never read
back into this repo.

```bash
cast wallet import oilskin-sepolia --interactive
```

**b. Note the address it prints**, then export the three values every command below needs. Use your
own addresses; on a testnet the deployer may be its own treasury, but `REGISTRY_OWNER` should still
be a second address so the two-step hand-off is exercised as it will be on mainnet.

```bash
export SEPOLIA_RPC_URL=https://sepolia.base.org
export DEPLOYER=<the address cast wallet import printed>
export TREASURY=$DEPLOYER
export REGISTRY_OWNER=<a second address you control>
```

**c. Fund the deployer with Sepolia ETH.** The dry run estimated **19,505,395 gas ≈ 0.000215 ETH**
at 0.011 gwei. Base Sepolia base fee moves, so hold a margin.

```bash
cast balance $DEPLOYER --rpc-url $SEPOLIA_RPC_URL --ether
```

**d. Re-read the tick before you deploy.** The mainnet cbZEC/USDC tick moved 1,281 ticks in the two
days before this file was written. If the value below is not −24509, pass the fresh one as
`CBZEC_USDC_TICK` on both the dry run and the broadcast so the mock pool and the mock swap router
are priced from the same live number.

> **It has moved. Read live 2026-09-13: `tick = -24046`** (463 ticks above the −24509 recorded here,
> ≈ 4.7 % in price). So this is not a formality — read it yourself at the moment you deploy and pass
> what you get, because it will have moved again.

```bash
cast call 0x0Fc47C17AF86078d809358db1b4db2DeBC988566 'slot0()(uint160,int24,uint16,uint16,uint16,bool)' --rpc-url https://mainnet.base.org
```

---

## 3. Dry run — no `--broadcast`, nothing is signed

This is the exact command that was run on 2026-09-07 and passed: the guard cleared against live
Aave, and all eight deployments plus the faucet mint simulated.

```bash
cd contracts && TREASURY=$TREASURY REGISTRY_OWNER=$REGISTRY_OWNER forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url $SEPOLIA_RPC_URL --sender $DEPLOYER -vvvv
```

Expect `SIMULATION COMPLETE`, a `Chain 84532` block, and the two logged sections — the Oilskin
addresses and the `Base Sepolia substitutes (NOT mainnet artefacts)` list. **Read the logged tick.**
If the guard reverts, do not work around it: it means a dependency drifted, and the fix is to
re-read the chain and update `docs/VERIFIED-BASE-FACTS.md` before deploying.

Guard failures and what each means:

| Revert | Meaning |
|---|---|
| `NotBaseSepolia(chainId)` | wrong RPC |
| `MissingEnv("TREASURY" / "REGISTRY_OWNER")` | the export in §2b did not reach `forge` |
| `NoCode(name, addr)` | that dependency vanished from Sepolia — re-read the chain |
| `AaveProviderDrift(what, expected, actual)` | Aave re-pointed its provider; re-read and update the facts document |
| `ReserveShape("WETH not collateral" …)` | Aave changed a reserve's flags; the substitute plan needs re-checking |
| `FaucetPermissioned()` | Aave closed the open faucet; test collateral now needs another route |

---

## 4. Deploy — you run this, with your key

Identical to the dry run plus `--broadcast --account oilskin-sepolia`. `--account` makes `cast`
prompt you for the keystore password; the password is never passed on the command line and never
enters this repo.

```bash
cd contracts && TREASURY=$TREASURY REGISTRY_OWNER=$REGISTRY_OWNER forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url $SEPOLIA_RPC_URL --account oilskin-sepolia --sender $DEPLOYER --broadcast --slow -vvvv
```

Add `--verify --verifier-url https://api-sepolia.basescan.org/api --etherscan-api-key $BASESCAN_API_KEY`
only if you have a Basescan key set; verification is optional and its absence does not affect the
deployment.

Save the printed addresses into your shell before §5:

```bash
export FACTORY=  REGISTRY=  ROUTER=  AAVE_VENUE=  LP_VENUE=  SWAP_ADAPTER=  MORPHO_VENUE=  CBZEC=  ENGINE=  MOCK_POOL=  MOCK_SWAP_ROUTER=  AERO=
export USDC=0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f
export WETH=0x4200000000000000000000000000000000000006
export WBTC=0x54114591963CF60EF3aA63bEfD6eC263D98145a4
```

---

## 5. Post-deploy checklist

Every command in §5.1 to §5.4 is read-only (`cast call`). Only §5.5 sends transactions, and each of
those is yours to run.

### 5.1 Wiring

```bash
cast call $ROUTER 'REGISTRY()(address)' --rpc-url $SEPOLIA_RPC_URL   # → $REGISTRY
cast call $ROUTER 'LP_VENUE()(address)' --rpc-url $SEPOLIA_RPC_URL   # → $LP_VENUE
cast call $ROUTER 'SWAP()(address)' --rpc-url $SEPOLIA_RPC_URL       # → $SWAP_ADAPTER
cast call $ROUTER 'USDC()(address)' --rpc-url $SEPOLIA_RPC_URL       # → Aave test USDC, NOT Circle's
cast call $ROUTER 'PERMIT2()(address)' --rpc-url $SEPOLIA_RPC_URL    # → 0x000000000022D473030F116dDEE9F6B43aC78BA3
cast call $AAVE_VENUE 'PROVIDER()(address)' --rpc-url $SEPOLIA_RPC_URL   # → 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00
cast call $AAVE_VENUE 'REGISTRY()(address)' --rpc-url $SEPOLIA_RPC_URL   # → $REGISTRY
cast call $SWAP_ADAPTER 'ROUTER()(address)' --rpc-url $SEPOLIA_RPC_URL   # → $MOCK_SWAP_ROUTER
cast call $LP_VENUE 'ENGINE()(address)' --rpc-url $SEPOLIA_RPC_URL       # → $ENGINE (mock)
```

### 5.2 Registry state, ownership and the timelock

```bash
cast call $REGISTRY 'owner()(address)' --rpc-url $SEPOLIA_RPC_URL          # → $DEPLOYER, until §5.5a
cast call $REGISTRY 'pendingOwner()(address)' --rpc-url $SEPOLIA_RPC_URL   # → $REGISTRY_OWNER
cast call $REGISTRY 'TIMELOCK_DELAY()(uint256)' --rpc-url $SEPOLIA_RPC_URL # → 172800
cast call $REGISTRY 'entryHfFloorWad()(uint256)' --rpc-url $SEPOLIA_RPC_URL # → 1250000000000000000
cast call $REGISTRY 'assets()(address[])' --rpc-url $SEPOLIA_RPC_URL       # → [WBTC, WETH, cbZEC mock]
```

Per asset — WBTC and WETH enabled, the cbZEC stand-in registered but **disabled** with its note:

```bash
cast call $REGISTRY 'isEnabled(address)(bool)' $WBTC --rpc-url $SEPOLIA_RPC_URL   # true
cast call $REGISTRY 'isEnabled(address)(bool)' $WETH --rpc-url $SEPOLIA_RPC_URL   # true
cast call $REGISTRY 'isEnabled(address)(bool)' $CBZEC --rpc-url $SEPOLIA_RPC_URL  # false
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $WBTC --rpc-url $SEPOLIA_RPC_URL  # 6640
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $WETH --rpc-url $SEPOLIA_RPC_URL  # 6800
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $CBZEC --rpc-url $SEPOLIA_RPC_URL # 0
cast call $REGISTRY 'config(address)((address,uint8,address,bool,string))' $CBZEC --rpc-url $SEPOLIA_RPC_URL
```

The last one must show `decimals = 8`, `enabled = false`, and the note
`no collateral market on Base yet`.

**Where 6,640 and 6,800 come from — nothing is typed.** `maxOfferedLtvBps` is
`min(LT ÷ entryHfFloor, the venue's own max LTV)`; the 50 % product cap that used to sit above them
was removed with the floor decision of 2026-09-12. At a **1.25** floor and the Sepolia reserve
parameters re-read live on 2026-09-13 (block 46,775,990, unchanged from Addendum 2): WBTC
8300 ÷ 1.25 = 6640 against a venue LTV of 8150, and WETH 8500 ÷ 1.25 = 6800 against 8350 — the
floor binds on both. **If you deploy with a different `ENTRY_HF_FLOOR_WAD`, both numbers move**, and
`scripts/sepolia-postdeploy-check.sh` derives them from whatever the registry reports rather than
comparing against a constant, so it follows automatically.

### 5.3 Risk parameters are read live, never typed

These come from Aave, not from a constant in our code. Both must equal the values in
`docs/VERIFIED-BASE-FACTS.md` Addendum 2 at the block you read (WETH LT 8500 / LTV 8350, WBTC LT
8300 / LTV 8150). **If they differ, Aave changed them and the facts document is what must be
updated** — the offer will follow automatically.

```bash
cast call $AAVE_VENUE 'liquidationThresholdBps(address)(uint256)' $WETH --rpc-url $SEPOLIA_RPC_URL  # 8500
cast call $AAVE_VENUE 'maxLtvBps(address)(uint256)' $WETH --rpc-url $SEPOLIA_RPC_URL                # 8350
cast call $AAVE_VENUE 'liquidationThresholdBps(address)(uint256)' $WBTC --rpc-url $SEPOLIA_RPC_URL  # 8300
cast call $AAVE_VENUE 'maxLtvBps(address)(uint256)' $WBTC --rpc-url $SEPOLIA_RPC_URL                # 8150
cast call $AAVE_VENUE 'enabled()(bool)' --rpc-url $SEPOLIA_RPC_URL      # true
cast call $MORPHO_VENUE 'enabled()(bool)' --rpc-url $SEPOLIA_RPC_URL    # false — built over NO markets on Sepolia (none exists there)
```

### 5.4 Account address determinism and the LP venue's fee

`accountOf` is a pure function of factory and owner, so it answers before any account exists.

```bash
cast call $FACTORY 'accountOf(address)(address)' $DEPLOYER --rpc-url $SEPOLIA_RPC_URL
cast call $FACTORY 'isDeployed(address)(bool)' $DEPLOYER --rpc-url $SEPOLIA_RPC_URL   # false before §5.5b
cast call $FACTORY 'IMPLEMENTATION()(address)' --rpc-url $SEPOLIA_RPC_URL
cast call $LP_VENUE 'performanceBps()(uint256)' --rpc-url $SEPOLIA_RPC_URL  # 1000
cast call $LP_VENUE 'treasury()(address)' --rpc-url $SEPOLIA_RPC_URL        # $TREASURY
cast call $LP_VENUE 'poolTokens(bytes32)(address,address,address)' $(cast keccak "aero-cl200-USDC-cbZEC") --rpc-url $SEPOLIA_RPC_URL
```

The last one returns `(token0, token1, pool)` and must show test USDC as token0, the cbZEC mock as
token1, and `$MOCK_POOL` as the pool. That ordering is what `StrategyRouter.openLeveragedLp` checks
before it will open a position. The pool id itself is `keccak256("aero-cl200-USDC-cbZEC")` =
`0x446b5f09e94e0becef972a2a3f2f0111ccb8cacb3146aa704bf8f75a6fe3e1d9`, which the script also logs.

### 5.5 The transactions only you can send

Each is a separate signed transaction. They are listed, not run.

**a. Accept registry ownership**, from `$REGISTRY_OWNER`'s key — the hand-off is deliberately two
steps, exactly as it will be on mainnet:

```bash
cast send $REGISTRY 'acceptOwnership()' --rpc-url $SEPOLIA_RPC_URL --account <registry-owner-keystore>
```

Then re-check: `cast call $REGISTRY 'owner()(address)'` must return `$REGISTRY_OWNER`, and
`pendingOwner()` the zero address.

**b. Mint test collateral from Aave's open faucet** (`isPermissioned()` is false, so no permission
is needed). Per-call caps measured on 2026-09-07: **1,000,000 USDC** and **1 WBTC**.

```bash
cast send 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc 'mint(address,address,uint256)(uint256)' $WBTC $DEPLOYER 100000000 --rpc-url $SEPOLIA_RPC_URL --account oilskin-sepolia
```

For WETH, wrap Sepolia ETH instead — WETH is the OP-stack predeploy, not a faucet token:

```bash
cast send $WETH 'deposit()' --value 0.01ether --rpc-url $SEPOLIA_RPC_URL --account oilskin-sepolia
```

**c. Create your account** and confirm it landed at the address `accountOf` predicted in §5.4:

```bash
cast send $FACTORY 'createAccount(address)(address)' $DEPLOYER --rpc-url $SEPOLIA_RPC_URL --account oilskin-sepolia
```

**d. First deposit through the router.** Do this from the web app or a script, not by hand — the
Permit2 signature and the price band are what the app builds. `docs/DEPOSIT-FLOW.md` (Step 5 of the
backlog, not yet written) will be the reference for the call sequence.

---

## 6. After a successful deploy — minutes, not an afternoon (slice J, 2026-09-12)

Everything below is prepared; the only typing left is pasting addresses once. The checklist with
the boxes is `docs/SEPOLIA-REHEARSAL.md`; what the rehearsal proves and cannot prove is there too.

1. **Record it (2 minutes).** Open `docs/DEPLOYMENTS.md`, "Base Sepolia": fill `deployedAtBlock`,
   `deployedAtUtc`, `deployer`, `treasury`, `registryOwner` (leave `registryOwnerAccepted` as
   `pending`), the eight Oilskin addresses and the five substitutes from the two logged sections
   of §4, the logged tick, and the tx hashes. That table is the one place every other file reads
   an address from — the keeper's and the web's env, the Sepolia Playwright suite, and the check
   script — so nothing else has to be edited.
2. **Read it back (seconds, read-only).**
   ```bash
   scripts/sepolia-postdeploy-check.sh
   ```
   §5.1–§5.4 as one run — wiring, registry state and the pending hand-off, Aave's live LT / LTV
   against the facts (WETH 8500 / 8350, WBTC 8300 / 8150), the Morpho venue disabled, the LP
   venue's fee and pool tokens. It ends with `N ok, 0 FAIL` or names the line that differs.
3. **Accept ownership (one signature, §5.5a)** from `REGISTRY_OWNER`'s key, then run step 2 again:
   the ownership line flips from `hand-off PENDING` to `accepted`. Put the tx hash in
   `registryOwnerAccepted`.
4. **Keeper, observe-only (no key).** `cp deploy/sepolia/keeper.observe-only.env.example
   keeper.sepolia.env`, fill `ACCOUNT_FACTORY_ADDRESS`, `STRATEGY_ROUTER_ADDRESS`, `CBZEC_ADDRESS`,
   `AERO_ADDRESS` (the two doubles are the MockB20 and MockERC20 lines of the substitutes list —
   a missing one is refused by that variable's name) and `DISCOVERY_FROM_BLOCK` = `deployedAtBlock`;
   then `set -a; . ./keeper.sepolia.env; set +a; npm run agent`. The first log lines are
   `NOT BASE MAINNET` (with what the run proves) and the per-feed bounds it derived from the
   aggregators — `node scripts/sepolia-feed-policy.mjs` prints the same numbers from the same code
   without starting the keeper (2026-09-12: BTC/USD and ETH/USD **2,460 s**, USDC/USD
   **172,848 s**; `SEPOLIA-REHEARSAL.md` has the gaps behind them).
5. **Web.** `cp deploy/sepolia/web.env.example web/.env.local`, fill the same four addresses under
   their `NEXT_PUBLIC_` names (`NEXT_PUBLIC_CBZEC_ADDRESS` / `NEXT_PUBLIC_AERO_ADDRESS` are the
   keeper's `CBZEC_ADDRESS` / `AERO_ADDRESS` twins — same two doubles, same reason: Base Sepolia
   has neither token, and a build pointed at 84532 refuses to read the mainnet ones), then
   `npm run web`. Wallets are asked for Base Sepolia, explorer links go to sepolia.basescan.org,
   the spot page says CoW is Base mainnet only. The rehearsal suite runs the moment step 1 is done:
   ```bash
   cd web && npx playwright test -c playwright.sepolia.config.ts
   ```
   (until then it prints one skip whose reason names this section).
6. **Collateral and the first account (§5.5b–c, two or three signatures).** The keeper discovers
   the account on its next tick; the dashboard shows it under the connected wallet.
7. **The Morpho venue stays empty.** It deploys over no markets on Sepolia (the Morpho API does not
   index 84532; none is known there), reports `enabled() == false`, and the registry refuses to
   point an asset at it. Rehearsing a venue switch means creating a market there first
   (permissionless `Morpho.createMarket`) and passing its id in `MORPHO_MARKET_IDS` — not part of
   this rehearsal.

Behind step 4 and 5: `packages/shared` `CHAINS[84532]` (`src/chains.ts`) is this document's
addendum in `VERIFIED-BASE-FACTS.md` — Aave's provider / pool / data provider / oracle, its test
USDC and test WBTC (standing in under the **cbBTC** role), WETH, the Chainlink BTC / ETH / USDC
feeds, Pyth, Permit2, Multicall3, Morpho Blue. Both consumers select by chain id and never fall
back to a mainnet address: an unknown chain is `ConfigError: CHAIN_ID: unsupported chain …`, an
override for a pinned token (any `*_ADDRESS` on 8453) is refused.

---

## 7. Before you touch mainnet from this shell

Every `export` above lives on in the terminal you typed it in. `contracts/script/Deploy.s.sol`
reads `USDC`, `WETH`, `TREASURY` and `REGISTRY_OWNER` by exactly these names, and the mainnet
guard now refuses a treasury that equals the broadcaster and a registry owner that is not a
contract (wave-2 S-LOW-1) — but it cannot tell a deliberate value from a leftover. Clear them:

```bash
unset SEPOLIA_RPC_URL DEPLOYER TREASURY REGISTRY_OWNER USDC WETH WBTC CBZEC_USDC_TICK FACTORY REGISTRY ROUTER AAVE_VENUE LP_VENUE SWAP_ADAPTER MORPHO_VENUE CBZEC ENGINE MOCK_POOL MOCK_SWAP_ROUTER AERO
```
