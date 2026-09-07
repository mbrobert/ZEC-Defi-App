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
the job of the 8 mainnet fork tests.

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
cast call $REGISTRY 'entryHfFloorWad()(uint256)' --rpc-url $SEPOLIA_RPC_URL # → 1550000000000000000
cast call $REGISTRY 'assets()(address[])' --rpc-url $SEPOLIA_RPC_URL       # → [WBTC, WETH, cbZEC mock]
```

Per asset — WBTC and WETH enabled, the cbZEC stand-in registered but **disabled** with its note:

```bash
cast call $REGISTRY 'isEnabled(address)(bool)' $WBTC --rpc-url $SEPOLIA_RPC_URL   # true
cast call $REGISTRY 'isEnabled(address)(bool)' $WETH --rpc-url $SEPOLIA_RPC_URL   # true
cast call $REGISTRY 'isEnabled(address)(bool)' $CBZEC --rpc-url $SEPOLIA_RPC_URL  # false
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $WBTC --rpc-url $SEPOLIA_RPC_URL  # 5000
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $WETH --rpc-url $SEPOLIA_RPC_URL  # 5000
cast call $REGISTRY 'maxOfferedLtvBps(address)(uint256)' $CBZEC --rpc-url $SEPOLIA_RPC_URL # 0
cast call $REGISTRY 'config(address)((address,uint8,address,bool,string))' $CBZEC --rpc-url $SEPOLIA_RPC_URL
```

The last one must show `decimals = 8`, `enabled = false`, and the note
`no collateral market on Base yet`.

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
cast call $MORPHO_VENUE 'enabled()(bool)' --rpc-url $SEPOLIA_RPC_URL    # false — off until Step 2
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

## 6. After a successful deploy

1. Record the deployed addresses, the chain id, the block and the date in a new
   `docs/DEPLOYMENTS.md` — a testnet deployment is a fact like any other, and nothing may quote an
   address that is not written down with its date.
2. Point the agent and the web app at the testnet addresses (`SETUP.md` lists the variables). Run
   the keeper in **observe-only mode**: no `KEEPER_PRIVATE_KEY`.
3. Leave `MorphoBlueVenue` disabled. Enabling it is Step 2 of the backlog and goes through
   `proposeVenue` → 2-day timelock → `acceptVenue`, even on a testnet, because that is the
   procedure being tested.
