# Audit scope — Base-first v1 (tree of 2026-09-05)

What an auditor is asked to read, what it must guarantee, and what we have
not verified ourselves. Line counts are `wc -l` on this tree. The ABI seam
(selectors, errors, events) is `CONTRACT-ABI.md` and the generated
`contracts/abi/oilskin-abi.json`; read the code, not the tables.

Abbreviations: ABI = application binary interface; EVM = Ethereum Virtual
Machine; HF = health factor; LT = liquidation threshold; LTV = loan-to-value;
LP = liquidity provision; TWAP = time-weighted average price; RPC = remote
procedure call; EIP = Ethereum Improvement Proposal.

## In scope — on chain (`contracts/src`, 2,856 lines, solc 0.8.24, via-IR, EVM cancun)

| Contract | Lines | Role | Owner / admin |
|---|---|---|---|
| `account/OilskinAccount.sol` | 511 | The user's account: `exec` / `execBatch` (owner), `execAsKeeper` (grant-checked), `execFromPeripheral` / `execNestedPeripheral` (active peripheral only), grants and budgets in transient-storage context | none; `owner` immutable after `initialize` |
| `account/OilskinAccountFactory.sol` | 71 | CREATE2 clones, `accountOf`, `createAccount`, `createAccountAndExec` | none |
| `account/Peripheral.sol` | 55 | Base for venues / router: `_exec`, `_execMany`, `_approveCallReset` | — |
| `router/StrategyRouter.sol` | 303 | `openLeveragedLp`, `unwind`, `sweep`; stateless, asserts zero balance | none |
| `venues/AaveV3Venue.sol` | 158 | `ICollateralVenue` over Aave v3; provider-resolved addresses; LT / LTV read at call time | none |
| `venues/SnuggleLpVenue.sol` | 557 | `ILpVenue` over the Snuggle engine; fee chokepoint; band; width bounds; C-2 enumeration; refund folding | none; `performanceBps`, `treasury` immutable |
| `venues/MorphoBlueVenue.sol` | 99 | Skeleton; every call reverts `VenueDisabled`; `enabled() == false` | none |
| `registry/CollateralRegistry.sol` | 142 | Asset → venue / enabled / note; `maxOfferedLtvBps` derived; `entryHfFloorWad` in (1, 10] | `Ownable2Step` — the only owned contract |
| `swap/AerodromeSwapAdapter.sol` | 79 | One Slipstream `exactInputSingle`, recipient = account, `minOut > 0` | none |
| `oracle/PythOracleAdapter.sol` | 181 | v1.1 Morpho `IOracle` with same-tx Pyth refresh, `maxAge`, `PegBreak` vs pool TWAP — **built, not deployed, not used** | none |
| `libraries/TickMath.sol` | 48 | Vendored tick → sqrt-price | — |
| `interfaces/*.sol` | 652 | `IOilskinAccount`, `ICollateralVenue`, `ILpVenue`, `ISwapAdapter`, `IAaveV3`, `ISnuggleVault` (verified 2026-09-03 shape), `IAerodromeCLPool`, `IAerodromeSwapRouter` (**unprobed**), `IMorphoBlue`, `IPermit2`, `IPyth` | — |
| `script/Deploy.s.sol` | 257 | `BaseAddresses` (from `VERIFIED-BASE-FACTS.md` only), env-driven config, mainnet guard, two-step registry handover | — |

Dependencies compiled in: OpenZeppelin v5.7.0 (`Clones`, `Ownable2Step`,
`IERC20*`, receivers, `Math`), forge-std v1.16.2 (tests only).

## In scope — off chain

| Area | Lines | Safety-critical paths |
|---|---|---|
| `agent/src` | 3,437 | `engine/valuation.ts` (fail-closed HF), `engine/ladder.ts` (hysteresis / re-arm), `dispatch/policy.ts` (plan → `Call[]`), `dispatch/keeperDispatcher.ts` (grant read → simulate → send → confirm; idempotency), `store/keeperStore.ts` (atomic store, lock, tamper), `log.ts` (redaction), `config.ts` |
| `web/lib` (+ `app/`, `components/`) | 6,099 excl. the 2,786-line generated ABI | `plan.ts` (the calls users sign), `execute.ts` (guarded writes, band quoting, `swapMinOut`), `tickmath.ts`, `reads.ts` / `positions.ts` (chain reads), `cow.ts` (spot), `onboarding.ts`, `copy.ts` (disclosures) |
| `services/yield/src` | 3,914 | `sources/aave.ts`, `sources/gauges.ts` (strict decoding), `gate.ts`, `model.ts` (the gate), `server.ts` (503 on stale) |
| `packages/shared/src` | 1,499 | `base.ts` (addresses), `health.ts`, `collateral.ts`, `fees.ts`, `width.ts` |

Out of scope: `prototype/` (no money path), `services/yield` backfill /
bands (informational), `contracts/test/mocks` (test doubles).

## Trust model

- **The user owns everything.** `OilskinAccount.owner` is the wallet that
  created it, set once by the factory. Every Aave position (`onBehalfOf` =
  account) and every engine id (minted to the account) belongs to the account.
  `exec` is owner-only with no other gate: the owner can call any target with
  any calldata, so no Oilskin contract, grant, registry state or keeper can
  stand between the user and their funds (invariant 1 below).
- **Peripherals hold nothing and own nothing.** Router, venues and adapter
  have no storage (beyond immutables), no owner, no upgrade path; the router
  asserts `balanceOf(router) == 0` at the end of every call. Callback rights
  (`execFromPeripheral`) exist only for the *active* target of the current
  `exec`, are non-transitive, and are delegated explicitly by
  `execNestedPeripheral`.
- **The keeper is grant-bounded.** A keeper call must match an active grant
  `(keeper, target, selector)`; ETH value and every token operation in the
  call tree (`transfer`, `approve`, `increaseAllowance`, `transferFrom`,
  Permit2 `approve` / `transferFrom`) is charged against per-token per-period
  budgets computed from **calldata**; an unbudgeted token reverts. The owner
  kills one grant with `revoke` or all with `revokeAll` (epoch bump). The
  keeper's recommended targets are `StrategyRouter.unwind` (pays only the
  account, `withdrawAmount` HF-gated) and `SnuggleLpVenue.closeMany`; nothing
  should grant `openLeveragedLp`, `borrow`, `sweep` or raw token selectors.
- **The registry owner** (a Safe — plan) can register / enable assets and set
  the entry-HF floor within (1, 10]. It cannot touch an account, and `unwind`
  ignores `enabled`.
- **The fee** is `SnuggleLpVenue.performanceBps` (immutable, ≤
  `MAX_PERFORMANCE_BPS` 2000) on the *gain* collected at `claim` / `close`,
  paid to the immutable `treasury`; principal is withdrawn afterwards and never
  taxed; a treasury that cannot receive skips the fee.
- **Third parties we call and do not control:** Aave v3 (pool, data provider,
  oracle via the provider), the Snuggle engine, Aerodrome pools / gauges /
  SwapRouter, Permit2, Pyth (v1.1), CoW settlement (web only).

## Invariants (what the tests already assert; the auditor should try to break them)

From `contracts/test/invariant/Invariants.t.sol` (Handler with 15 actions,
256 runs × depth 40 = 10,240 calls per invariant in the default profile;
the build report also ran 768 × 64):

1. **The user can always exit via raw `exec`** — under random sequences, a
   glitching engine enumeration, a disabled asset and no grants
   (`invariant_userCanAlwaysExitViaExec`, snapshot probe).
2. **A keeper never exceeds a grant** — no un-granted call succeeds, budgets
   never overspent, the keeper never ends up holding a token or a position
   (`invariant_keeperNeverExceedsGrant`).
3. **The fee never touches principal** — the treasury never holds more than
   `performanceBps` of the yield the engine actually paid
   (`invariant_feeNeverTouchesPrincipal`).
4. **Router and peripherals hold nothing** after every call
   (`invariant_routerAndPeripheralsHoldNothing`).
5. **No standing allowances** survive a call (`invariant_noStandingAllowances`).

Unit-level properties (181 tests, 8 fuzz tests at 512 runs by default):
only the factory initialises an account, exactly once; only the owner can
`exec`; reentrancy through every door reverts; callback rights are per-call
and non-transitive; grants expire, revoke, epoch-bump, period-roll; every token
selector including Permit2's is charged; malformed calldata for a recognised
selector fails closed; `maxOfferedLtvBps` = floor(LT / floor) capped 5000;
`EntryHfTooLow` exactly at the offered max; `ExitHfTooLow`; unwind works on
disabled assets; Permit2 wrong-spender / reused-nonce refused; width bounds;
band required / out of range / unreadable pool; C-2 enumeration (empty, grows,
prunes, re-key, glitch → `EnumerationFailed`, paused → `EngineUnreachable`);
close fee on yield only; refused claims skipped; per-id try/catch; B20 rebase
up and down, blocked account, blocked treasury, paused reward token, blocked
swap; Pyth same-tx gate, stale, peg break both directions; deploy guard
refuses unknown chain / missing env / no code / Aave provider drift.

## Not verified — say so before anyone relies on it

| Item | State | Where it bites |
|---|---|---|
| **Fork tests against Base** | `contracts/test/fork/BaseFork.t.sol`, 8 tests, `vm.skip` without `FORK_URL` — **never run from this container** (no RPC). Reported as SKIPPED. | Aave provider resolution, live reserve params, cbZEC B20 shape, engine index-getter shape (its live end-of-list revert is *logged* by `test_fork_engineIndexGetterShape` and has never been recorded), supply → borrow → repay → withdraw under a real account, open → close on the live engine |
| **Aerodrome Slipstream SwapRouter** | Address **not in `VERIFIED-BASE-FACTS.md`**; `Deploy.s.sol` requires `AERODROME_SWAP_ROUTER` from env and refuses without it; `IAerodromeSwapRouter.exactInputSingle` shape unprobed | `AerodromeSwapAdapter` and therefore the swap leg of `unwind` |
| **Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`) | Not in the facts doc. The web uses viem's `base` chain definition with a per-call fallback (`web/lib/reads.ts: safeMulticall`); the keeper issues one `eth_call` per read (≈12 + 4 per account per tick) | RPC load, not safety |
| **Morpho Blue market ids** (cbBTC/USDC, WETH/USDC) | Never discovered (GraphQL listing failed three times); `MORPHO_BLUE.marketIds = {}`; `MorphoBlueVenue` disabled | v1.1 only |
| **CoW `vaultRelayer`** | `COW_PROTOCOL.vaultRelayer = null` in shared; the web reads `settlement.vaultRelayer()` live | spot approve target |
| **cbZEC B20 policy** (blocklist, pause) | `owner()` / `paused()` revert on the precompile; `multiplier()` read once = 1e18 (2026-09-05). No shipped code reads policy state; the web's disclosure says it does — **must-fix** (`RISKS.md` §4) | cbZEC spot / LP users |
| **Aave PoolDataProvider casing** | The facts doc printed a non-EIP-55 casing; code pins the checksummed `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` (same hex). Corrected in the doc 2026-09-05 | none |
| **Gauge-emission words** | 2026-08-31 block 50675328, not a 2026-09-05 read | the yield verdict's inputs, not its logic |
| **Web ↔ keeper grant shape** | Web grants `unwind` only; keeper needs `closeMany` too — refused for LP positions (`RISKS.md` §10) | keeper protection in practice |
| **Web `swapMinOut` on unwind** | Sized from the indexer's USD value; degrades to 1 on a zero cache value (`FLOWS.md` §3) | swap floor on unwind |
| **Borrow-and-hold entry floor** | UI-only; the hold batch bypasses `StrategyRouter` (`FLOWS.md` §2) | HF at entry on the hold path |
| **Static analysis / formal** | No Slither, Aderyn, Halmos or Tenderly run recorded | — |
| **External audit** | None | everything |

## Deployment facts an auditor needs

Nothing is deployed. The addresses the contracts will bind to are in
`CONTRACT-ABI.md` §10 and `script/Deploy.s.sol: BaseAddresses`, every one from
`VERIFIED-BASE-FACTS.md` (read live 2026-09-05 ~01:00 UTC). The engine proxy
`0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55` and its verified behaviours are
from `AUDIT-FINDINGS-2026-09-03.md` Part 1 (head ≈ block 50,821,540).
