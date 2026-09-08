// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {IAavePool} from "../../src/interfaces/IAaveV3.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {SnuggleLpVenue} from "../../src/venues/SnuggleLpVenue.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AerodromeSwapAdapter} from "../../src/swap/AerodromeSwapAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAave} from "../mocks/MockAave.sol";
import {MockCLPool} from "../mocks/MockCLPool.sol";
import {MockSnuggleVault} from "../mocks/MockSnuggleVault.sol";

/// @notice Drives the whole surface with owner, keeper and adversarial actions, and keeps the
///         ghost accounting the invariants are checked against.
contract Handler is Test {
    OilskinAccount immutable acct;
    AaveV3Venue immutable aaveVenue;
    MorphoBlueVenue immutable morphoVenue;
    SnuggleLpVenue immutable lpVenue;
    CollateralRegistry immutable registry;
    StrategyRouter immutable router;
    AerodromeSwapAdapter immutable swapAdapter;
    MockAave immutable aave;
    MockSnuggleVault immutable engine;
    MockCLPool immutable pool;
    MockERC20 immutable usdc;
    MockERC20 immutable weth;
    MockERC20 immutable cbbtc;
    MockERC20 immutable aero;
    bytes32 immutable poolId;
    address immutable alice;
    address immutable keeper;
    address immutable registryOwner;
    address immutable treasury;

    uint256 constant KEEPER_USDC_BUDGET = 100_000e6;
    uint256 constant KEEPER_WETH_BUDGET = 10e18;
    uint256 constant KEEPER_AERO_BUDGET = 1_000e18;

    // ghosts
    uint256 public g_yieldUsdc;
    uint256 public g_yieldWeth;
    uint256 public g_yieldAero;
    uint256 public g_keeperUnwinds;
    uint256 public g_ownerExits;
    uint256 public g_exitProbes;
    bool public g_exitProbeFailed;
    bool public g_keeperUngrantedSucceeded;
    /// The router's exit — the product's own Close — failed to reach the position in some state
    /// (audit wave 2, M-HIGH-1: it used to follow the registry's pointer and no-op after a switch).
    bool public g_routerExitProbeFailed;
    uint256 public g_routerExitProbes;
    /// Registry venue switches (cbBTC: Aave ↔ Morpho) performed, so the exit probes above are
    /// proved against a moved pointer and not only against the venue every position sits on.
    uint256 public g_switches;
    uint256 public g_calls;
    /// Donations pushed at a peripheral — the invariant asserts they are INERT, not that they are
    /// impossible: anyone can transfer to any address, and a contract that treats that as fatal is
    /// a one-base-unit denial of service.
    mapping(address => mapping(address => uint256)) public g_donated;
    uint256 public g_donations;

    constructor(
        OilskinAccount acct_,
        AaveV3Venue aaveVenue_,
        MorphoBlueVenue morphoVenue_,
        SnuggleLpVenue lpVenue_,
        CollateralRegistry registry_,
        StrategyRouter router_,
        AerodromeSwapAdapter swapAdapter_,
        MockAave aave_,
        MockSnuggleVault engine_,
        MockCLPool pool_,
        MockERC20[4] memory tokens,
        bytes32 poolId_,
        address[4] memory actors
    ) {
        acct = acct_;
        aaveVenue = aaveVenue_;
        morphoVenue = morphoVenue_;
        lpVenue = lpVenue_;
        registry = registry_;
        router = router_;
        swapAdapter = swapAdapter_;
        aave = aave_;
        engine = engine_;
        pool = pool_;
        (usdc, weth, cbbtc, aero) = (tokens[0], tokens[1], tokens[2], tokens[3]);
        poolId = poolId_;
        (alice, keeper, registryOwner, treasury) = (actors[0], actors[1], actors[2], actors[3]);
    }

    // ------------------------------------------------------------- helpers

    /// ±10 % of the live sqrt price — a real window, inside the venue's MAX_BAND_BPS width bound.
    function _band() internal view returns (PriceBand memory) {
        uint256 p = pool.sqrtPriceX96();
        return PriceBand(uint160((p * 9_000) / 10_000), uint160((p * 11_000) / 10_000));
    }

    /// Owner call to a PERIPHERAL (router / venue): the callback opt-in is set.
    function _exec(address target, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(alice);
        (ok, ret) =
            address(acct).call(abi.encodeCall(OilskinAccount.execWithCallback, (target, 0, data)));
    }

    /// Owner call to a plain target (token, pool): no rights handed over.
    function _execPlain(address target, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(alice);
        (ok, ret) = address(acct).call(abi.encodeCall(OilskinAccount.exec, (target, 0, data)));
    }

    function _ids() internal view returns (uint256[] memory) {
        try lpVenue.positionsOf(address(acct)) returns (uint256[] memory ids) {
            return ids;
        } catch {
            return new uint256[](0);
        }
    }

    // ------------------------------------------------------------- actions

    /// Owner supplies cbBTC and borrows USDC within the venue's LTV.
    function supplyAndBorrow(uint256 amount, uint256 ltvBps) external {
        g_calls++;
        amount = bound(amount, 0.01e8, 2e8);
        // The venue enforces the registry's 1.55 entry floor (LT 7800 → LTV ≤ 5032 bps).
        ltvBps = bound(ltvBps, 1000, 5000);
        cbbtc.mint(address(acct), amount);
        _exec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), amount)));
        uint256 usd = (amount * aave.getAssetPrice(address(cbbtc))) / 1e8; // E8
        uint256 borrow = (usd * ltvBps) / 10_000 / 100; // USDC 6 dec
        if (borrow == 0) return;
        _exec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), borrow)));
    }

    /// Owner deploys idle USDC into the LP venue.
    function openLp(uint256 amount) external {
        g_calls++;
        uint256 idle = usdc.balanceOf(address(acct));
        if (idle < 1e6) return;
        amount = bound(amount, 1e6, idle);
        LpOpenParams memory p = LpOpenParams({
            poolId: poolId,
            amount0: 0,
            amount1: amount,
            rangeWidthBps: 1500,
            rebalanceDelay: 12 hours,
            autoCompound: true,
            band: _band(),
            deadline: block.timestamp + 1
        });
        _exec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p)));
    }

    /// The engine accrues realised yield on a random owned id.
    function accrueYield(uint256 seed, uint256 u, uint256 w, uint256 a) external {
        g_calls++;
        uint256[] memory ids = _ids();
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        u = bound(u, 0, 5_000e6);
        w = bound(w, 0, 1e18);
        a = bound(a, 0, 100e18);
        if (u != 0) {
            usdc.mint(address(engine), u);
            engine.setPendingFee(id, address(usdc), u);
            g_yieldUsdc += u;
        }
        if (w != 0) {
            weth.mint(address(engine), w);
            engine.setPendingFee(id, address(weth), w);
            g_yieldWeth += w;
        }
        if (a != 0) {
            aero.mint(address(engine), a);
            engine.setPendingFee(id, address(aero), a);
            engine.setStaked(id, true);
            g_yieldAero += a;
        }
    }

    function ownerClaim() external {
        g_calls++;
        uint256[] memory ids = _ids();
        if (ids.length == 0) return;
        _exec(address(lpVenue), abi.encodeCall(ILpVenue.claim, (ids, _band(), block.timestamp + 1)));
    }

    function ownerCloseOne(uint256 seed) external {
        g_calls++;
        uint256[] memory ids = _ids();
        if (ids.length == 0) return;
        _exec(address(lpVenue), abi.encodeCall(ILpVenue.close, (ids[seed % ids.length], _band())));
    }

    /// Keeper runs the repay rung through the router within its grant.
    function keeperUnwind(uint256 repay) external {
        g_calls++;
        uint256[] memory ids = _ids();
        repay = bound(repay, 0, 50_000e6);
        StrategyRouter.UnwindParams memory u = StrategyRouter.UnwindParams({
            collateralAsset: address(cbbtc),
            positionIds: ids,
            band: _band(),
            // A real quote at the mock router's rate (1 WETH = 2453.45 USDC), 1 % tolerance.
            swap: StrategyRouter.SwapQuote({
                quotedIn: 1e18,
                quotedOut: 2453_450000,
                maxSlippageBps: 100,
                routeData: abi.encode(int24(100))
            }),
            repayAmount: repay,
            withdrawAmount: 0,
            deadline: block.timestamp + 1
        });
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(router), 0, abi.encodeCall(StrategyRouter.unwind, (u)), true);
        vm.prank(keeper);
        (bool ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        if (ok) g_keeperUnwinds++;
    }

    /// A compromised keeper tries every door it was not given.
    function keeperAttack(uint256 seed, uint256 amount) external {
        g_calls++;
        amount = bound(amount, 1, 1_000_000e6);
        Call[] memory calls = new Call[](1);
        uint256 k = seed % 5;
        if (k == 0) {
            calls[0] = Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (keeper, amount)), false);
        } else if (k == 1) {
            calls[0] = Call(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (keeper, amount)), false);
        } else if (k == 2) {
            calls[0] = Call(
                address(aave), 0, abi.encodeCall(IAavePool.withdraw, (address(cbbtc), amount, keeper)), false
            );
        } else if (k == 3) {
            calls[0] =
                Call(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), amount)), true);
        } else {
            uint256[] memory ids = _ids();
            calls[0] = Call(
                address(lpVenue), 0, abi.encodeCall(ILpVenue.claim, (ids, _band(), block.timestamp + 1)), true
            );
        }
        vm.prank(keeper);
        (bool ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        if (ok) g_keeperUngrantedSucceeded = true;
        // direct doors
        vm.prank(keeper);
        (ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execFromPeripheral, (calls)));
        if (ok) g_keeperUngrantedSucceeded = true;
        vm.prank(keeper);
        (ok,) = address(acct).call(abi.encodeCall(OilskinAccount.exec, (address(usdc), 0, calls[0].data)));
        if (ok) g_keeperUngrantedSucceeded = true;
    }

    function rekey(uint256 seed) external {
        g_calls++;
        uint256[] memory ids = _ids();
        if (ids.length == 0) return;
        engine.rekey(ids[seed % ids.length]);
    }

    function toggleAsset(bool enabled) external {
        g_calls++;
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), enabled, enabled ? "" : "paused");
    }

    function revokeAll() external {
        g_calls++;
        vm.prank(alice);
        acct.revokeAll();
    }

    function regrant() external {
        g_calls++;
        _grant();
    }

    function warp(uint256 dt) external {
        g_calls++;
        dt = bound(dt, 1, 2 days);
        vm.warp(block.timestamp + dt);
    }

    function glitchEnumeration(bool on) external {
        g_calls++;
        engine.setGlitch(address(acct), 0, on);
    }

    /// Owner exit through RAW exec to the underlying protocols — must work in every state.
    /// Snapshotted so the run keeps going after the probe.
    /// The registry owner moves cbBTC between Aave and Morpho the only way it can (propose →
    /// timelock → accept). Every position the handler opens sits on Aave; after a switch the
    /// router's exit must still find it through `previousVenues` (audit wave 2, M-HIGH-1), and the
    /// keeper's unwind inside its grant must still repay. Switching back is the same power.
    function switchVenue(bool toMorpho) external {
        g_calls++;
        address target = toMorpho ? address(morphoVenue) : address(aaveVenue);
        if (registry.venueOf(address(cbbtc)) == target) return;
        address feed = registry.config(address(cbbtc)).priceFeed;
        vm.prank(registryOwner);
        registry.proposeVenue(address(cbbtc), target, feed);
        vm.warp(block.timestamp + registry.TIMELOCK_DELAY());
        vm.prank(registryOwner);
        registry.acceptVenue(address(cbbtc));
        g_switches++;
    }

    /// The product's own Close, under a snapshot: `unwind(ids, repay max)` must reach the account's
    /// debt wherever it sits, and once the debt is gone `unwind(withdraw max)` must return the
    /// collateral — whatever the registry currently points at.
    function routerExitProbe() external {
        g_calls++;
        g_routerExitProbes++;
        uint256 snap = vm.snapshotState();
        bool ok = _routerExit();
        if (!ok) g_routerExitProbeFailed = true;
        vm.revertToState(snap);
    }

    function rawExitProbe() external {
        g_calls++;
        g_exitProbes++;
        uint256 snap = vm.snapshotState();
        bool ok = _rawExit();
        if (!ok) g_exitProbeFailed = true;
        vm.revertToState(snap);
    }

    /// Owner exit through the venues (best effort; the raw probe is the guarantee).
    function ownerExit() external {
        g_calls++;
        uint256[] memory ids = _ids();
        if (ids.length != 0) {
            _exec(address(lpVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _band())));
        }
        uint256 debt = aaveVenue.debt(address(acct), address(usdc));
        uint256 held = usdc.balanceOf(address(acct));
        uint256 repay = debt < held ? debt : held;
        if (repay != 0) {
            _exec(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), repay)));
        }
        if (aaveVenue.debt(address(acct), address(usdc)) == 0 && aaveVenue.collateral(address(acct), address(cbbtc)) != 0) {
            _exec(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), type(uint256).max)));
        }
        g_ownerExits++;
    }

    // ------------------------------------------------------------ internal

    function _routerExit() internal returns (bool) {
        uint256 debtBefore = aaveVenue.debt(address(acct), address(usdc));
        uint256 heldBefore = usdc.balanceOf(address(acct));
        StrategyRouter.UnwindParams memory u = StrategyRouter.UnwindParams({
            collateralAsset: address(cbbtc),
            positionIds: _ids(),
            band: _band(),
            swap: StrategyRouter.SwapQuote({
                quotedIn: 1e18,
                quotedOut: 2453_450000,
                maxSlippageBps: 100,
                routeData: abi.encode(int24(100))
            }),
            repayAmount: type(uint256).max,
            withdrawAmount: 0,
            deadline: block.timestamp + 1
        });
        (bool ok,) = _exec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        if (!ok) return false;
        uint256 debtAfter = aaveVenue.debt(address(acct), address(usdc));
        // The repay must have reached the debt: whatever the account holds AFTER is only what was
        // left over once the debt was cleared. Debt remaining next to idle USDC means the router
        // repaid a venue that holds nothing of this account's.
        if (debtAfter != 0 && usdc.balanceOf(address(acct)) != 0) return false;
        if (debtBefore != 0 && heldBefore != 0 && debtAfter == debtBefore) return false;
        if (debtAfter == 0 && aaveVenue.collateral(address(acct), address(cbbtc)) != 0) {
            u.positionIds = new uint256[](0);
            u.repayAmount = 0;
            u.withdrawAmount = type(uint256).max;
            (ok,) = _exec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
            if (!ok) return false;
            if (aaveVenue.collateral(address(acct), address(cbbtc)) != 0) return false;
        }
        return true;
    }

    function _rawExit() internal returns (bool) {
        // 1. Close every engine id straight at the engine (no venue, no band, no enumeration
        //    dependency: read the engine's own list index by index, tolerating a glitch by
        //    falling back to scanning ids 1..nextTokenId).
        uint256 n = engine.nextTokenId();
        for (uint256 id = 1; id < n; id++) {
            (,, address owner,,,,,,,,,,,,,,) = engine.positions(id);
            if (owner != address(acct)) continue;
            (bool ok,) = _execPlain(address(engine), abi.encodeCall(ISnuggleVault.withdraw, (id, false)));
            if (!ok) return false;
        }
        // 2. Repay everything held, withdraw all collateral, sweep to the wallet.
        uint256 debt = aaveVenue.debt(address(acct), address(usdc));
        uint256 held = usdc.balanceOf(address(acct));
        uint256 repay = debt < held ? debt : held;
        if (repay != 0) {
            Call[] memory calls = new Call[](3);
            calls[0] = Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(aave), repay)), false);
            calls[1] =
                Call(address(aave), 0, abi.encodeCall(IAavePool.repay, (address(usdc), repay, 2, address(acct))), false);
            calls[2] = Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(aave), 0)), false);
            vm.prank(alice);
            (bool ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execBatch, (calls)));
            if (!ok) return false;
        }
        if (aaveVenue.debt(address(acct), address(usdc)) == 0) {
            uint256 coll = aaveVenue.collateral(address(acct), address(cbbtc));
            if (coll != 0) {
                (bool ok,) = _execPlain(
                    address(aave), abi.encodeCall(IAavePool.withdraw, (address(cbbtc), type(uint256).max, address(acct)))
                );
                if (!ok) return false;
            }
        }
        address[3] memory toks = [address(usdc), address(cbbtc), address(weth)];
        for (uint256 i = 0; i < 3; i++) {
            uint256 bal = IERC20(toks[i]).balanceOf(address(acct));
            if (bal == 0) continue;
            (bool ok,) = _execPlain(toks[i], abi.encodeCall(IERC20.transfer, (alice, bal)));
            if (!ok) return false;
        }
        return true;
    }

    function _grant() internal {
        // Every token the unwind call tree may move: the USDC repay approval, the WETH swap
        // approval, and the performance-fee transfers in USDC / WETH / AERO.
        TokenLimit[] memory limits = new TokenLimit[](3);
        limits[0] = TokenLimit(address(usdc), KEEPER_USDC_BUDGET);
        limits[1] = TokenLimit(address(weth), KEEPER_WETH_BUDGET);
        limits[2] = TokenLimit(address(aero), KEEPER_AERO_BUDGET);
        Permission memory p = Permission({
            target: address(router),
            selector: StrategyRouter.unwind.selector,
            maxValuePerPeriod: 0,
            tokenLimits: limits,
            period: 1 days,
            expiry: uint40(block.timestamp + 365 days),
            // The router MUST act back on the account; a grant on a token would not, and the
            // default is false precisely so that a token grant can never escalate.
            allowCallback: true
        });
        vm.prank(alice);
        acct.grant(keeper, p);
    }

    function grantKeeper() external {
        _grant();
    }

    /// ANYBODY can send tokens to a peripheral. This is the action that would have caught
    /// B-CRIT-1: a router that treats a donation as fatal is a one-base-unit permanent denial of
    /// service on an immutable contract. After this runs, every other action must still work.
    function donate(uint256 seed, uint256 amount) external {
        g_calls++;
        address[4] memory peripherals =
            [address(router), address(aaveVenue), address(lpVenue), address(swapAdapter)];
        MockERC20[4] memory toks = [usdc, weth, cbbtc, aero];
        address to = peripherals[seed % 4];
        MockERC20 t = toks[(seed / 4) % 4];
        amount = bound(amount, 1, 1_000e6);
        t.mint(to, amount);
        g_donated[to][address(t)] += amount;
        g_donations++;
    }
}
