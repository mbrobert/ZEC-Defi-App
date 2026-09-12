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
import {IMorphoBlue, MarketParams} from "../../src/interfaces/IMorphoBlue.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {SnuggleLpVenue} from "../../src/venues/SnuggleLpVenue.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AerodromeSwapAdapter} from "../../src/swap/AerodromeSwapAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAave} from "../mocks/MockAave.sol";
import {MockMorpho} from "../mocks/MockMorpho.sol";
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
    MockMorpho immutable morpho;
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
    /// Two-book repay (2026-09-10). After the owner's `unwind(repay max)` with enough USDC to cover
    /// every book, a venue the registry names for cbBTC — the current pointer or a `previousVenues`
    /// entry — still owed USDC, or the call reverted without a name (empty data, `Panic`, a bare
    /// reason string). Set only by `repayAcrossProbe`, checked by `invariant_repayReachesEveryBook`.
    bool public g_repayAcrossFailed;
    uint256 public g_repayAcrossProbes;
    /// Probes that started with USDC owed on BOTH venues — the state the property is about.
    uint256 public g_twoBookProbes;
    uint256 public g_repayAcrossNamedReverts;
    bytes4 public g_lastRepayAcrossSelector;
    /// Opens that landed on Morpho: reachable only after `switchVenue(true)`.
    uint256 public g_morphoOpens;
    /// Slice D (2026-09-10, `RISKS.md` §8 "two-book Close") recorded the strand; slice F
    /// (2026-09-11) fixed it. The web's Close is ONE `unwind(ids, repay max, withdraw max)`. On an
    /// account with collateral on BOTH venues the withdraw leg now visits every venue holding the
    /// account's collateral: `singleCloseProbe` counts the two-book runs and the runs that STILL
    /// stranded collateral, and `invariant_singleCloseClearsEveryBook` asserts the latter is zero.
    /// `g_singleCloseUnexpected` is set when a two-book close, funded to cover every book, reverted.
    uint256 public g_singleCloseProbes;
    uint256 public g_singleCloseTwoBook;
    uint256 public g_singleCloseStranded;
    bool public g_singleCloseUnexpected;
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
        morpho = MockMorpho(address(morphoVenue_.MORPHO()));
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

    /// Owner supplies cbBTC and borrows USDC within the venue's LTV, on Aave (the venue refuses
    /// `AssetNotOffered` while the registry points elsewhere — the existing behaviour).
    function supplyAndBorrow(uint256 amount, uint256 ltvBps) external {
        g_calls++;
        _open(address(aaveVenue), amount, ltvBps);
    }

    /// Owner supplies cbBTC and borrows USDC on WHATEVER venue the registry names for cbBTC right
    /// now: Aave in the production wiring, Morpho only once `switchVenue(true)` has done the
    /// test-only propose → warp → accept in this handler (never in Deploy.s.sol). Opening on the
    /// new pointer while the Aave book is still open is what puts USDC debt on two books — the
    /// state the worst-first repay (`RISKS.md` §8 residual (a)) exists for and that no action
    /// could reach before 2026-09-10.
    function supplyAndBorrowOnCurrentVenue(uint256 amount, uint256 ltvBps) external {
        g_calls++;
        _open(registry.venueOf(address(cbbtc)), amount, ltvBps);
    }

    function _open(address venue, uint256 amount, uint256 ltvBps) internal {
        amount = bound(amount, 0.01e8, 2e8);
        // Both venues enforce the registry's 1.55 entry floor: Aave LT 7800 → LTV ≤ 5032 bps,
        // Morpho LLTV 8600 → ≤ 5548; 5000 clears both.
        ltvBps = bound(ltvBps, 1000, 5000);
        cbbtc.mint(address(acct), amount);
        _exec(venue, abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), amount)));
        // The Morpho oracle in the fixture is seeded from the same price, so one figure sizes both.
        uint256 usd = (amount * aave.getAssetPrice(address(cbbtc))) / 1e8; // E8
        uint256 borrow = (usd * ltvBps) / 10_000 / 100; // USDC 6 dec
        if (borrow == 0) return;
        if (venue == address(morphoVenue)) {
            // The router's opens use `borrowAgainst` so the debt lands in cbBTC's market (M-MED-1).
            (bool ok,) = _exec(
                venue, abi.encodeCall(ICollateralVenue.borrowAgainst, (address(cbbtc), address(usdc), borrow))
            );
            if (ok) g_morphoOpens++;
        } else {
            _exec(venue, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), borrow)));
        }
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

    /// Slice D: the web's single Close on a two-book account, under a snapshot (see the ghosts).
    function singleCloseProbe() external {
        g_calls++;
        g_singleCloseProbes++;
        uint256 snap = vm.snapshotState();
        (bool twoBook, bool ok, bool stranded) = _singleClose();
        vm.revertToState(snap);
        if (!twoBook) return;
        g_singleCloseTwoBook++;
        if (!ok) g_singleCloseUnexpected = true;
        if (ok && stranded) g_singleCloseStranded++;
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

    /// Slice 2 (2026-09-10) — the property `invariant_repayReachesEveryBook` checks. Under a
    /// snapshot: fund the account with enough USDC to cover EVERY book it owes on for cbBTC, run
    /// the owner's `unwind(repay max)` (no ids, no withdraw), and require that no venue the
    /// registry names for cbBTC — the current pointer and every `previousVenues` entry — still
    /// owes USDC. A revert is tolerated only when it carries a NAME: a custom-error selector, not
    /// empty data, not `Panic`, not a bare reason string — so a silent no-op, a truncated loop or
    /// a mock's "insufficient allowance" can never pass as "nothing to do".
    function repayAcrossProbe() external {
        g_calls++;
        g_repayAcrossProbes++;
        // Ghosts are written AFTER the snapshot is reverted, or the revert would erase them and
        // the invariant would be vacuous.
        uint256 snap = vm.snapshotState();
        (bool twoBook, bool failed, bool namedRevert, bytes4 sel) = _repayAcross();
        vm.revertToState(snap);
        if (twoBook) g_twoBookProbes++;
        if (failed) g_repayAcrossFailed = true;
        if (namedRevert) {
            g_repayAcrossNamedReverts++;
            g_lastRepayAcrossSelector = sel;
        }
    }

    function _repayAcross() internal returns (bool twoBook, bool failed, bool namedRevert, bytes4 sel) {
        uint256 owedAave = aaveVenue.debt(address(acct), address(usdc));
        uint256 owedMorpho = morphoVenue.debt(address(acct), address(usdc));
        twoBook = owedAave != 0 && owedMorpho != 0;
        uint256 total = owedAave + owedMorpho;
        if (total == 0) return (twoBook, false, false, bytes4(0));
        uint256 need = total + total / 100 + 1;
        uint256 held = usdc.balanceOf(address(acct));
        if (held < need) usdc.mint(address(acct), need - held);
        StrategyRouter.UnwindParams memory u = StrategyRouter.UnwindParams({
            collateralAsset: address(cbbtc),
            positionIds: new uint256[](0),
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
        (bool ok, bytes memory ret) = _exec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        if (!ok) {
            bool named;
            (sel, named) = _revertName(ret);
            return (twoBook, !named, named, sel);
        }
        address[] memory venues = _venuesFor(address(cbbtc));
        for (uint256 i = 0; i < venues.length; i++) {
            if (ICollateralVenue(venues[i]).debt(address(acct), address(usdc)) != 0) failed = true;
        }
    }

    /// Exactly what `web/lib/plan.ts encodeUnwindWrite` sends: ids, repay max, withdraw max, in one
    /// call — funded with enough USDC to cover every book, as the dashboard asks the user to be.
    function _singleClose() internal returns (bool twoBook, bool ok, bool stranded) {
        uint256 onAave = aaveVenue.collateral(address(acct), address(cbbtc));
        uint256 onMorpho = morphoVenue.collateral(address(acct), address(cbbtc));
        twoBook = onAave != 0 && onMorpho != 0;
        if (!twoBook) return (false, true, false);
        uint256 debt = _totalDebt();
        uint256 held = usdc.balanceOf(address(acct));
        if (debt > held) usdc.mint(address(acct), debt - held);
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
            withdrawAmount: type(uint256).max,
            deadline: block.timestamp + 1
        });
        (ok,) = _exec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        if (!ok) return (true, false, false);
        // Debt cleared everywhere (the repay leg reaches every book) but collateral left on a
        // venue the withdraw leg did not visit: that would be the strand slice D recorded.
        stranded = _totalDebt() == 0 && _totalCollateral() != 0;
    }

    function _routerExit() internal returns (bool) {
        uint256 debtBefore = _totalDebt();
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
        uint256 debtAfter = _totalDebt();
        // The repay must have reached the debt on EVERY book: whatever the account holds AFTER is
        // only what was left once every venue was cleared. Debt remaining on any venue next to
        // idle USDC means the router repaid a venue that holds nothing of this account's, or
        // stopped at the first book.
        if (debtAfter != 0 && usdc.balanceOf(address(acct)) != 0) return false;
        if (debtBefore != 0 && heldBefore != 0 && debtAfter == debtBefore) return false;
        if (debtAfter == 0) {
            // The withdraw leg visits every venue holding the account's collateral (2026-09-11), so
            // ONE `unwind(withdraw max)` must return it all, however many books there were.
            u.positionIds = new uint256[](0);
            u.repayAmount = 0;
            u.withdrawAmount = type(uint256).max;
            if (_totalCollateral() != 0) {
                (ok,) = _exec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
                if (!ok) return false;
            }
            if (_totalCollateral() != 0) return false;
        }
        return true;
    }

    function _totalDebt() internal view returns (uint256) {
        return aaveVenue.debt(address(acct), address(usdc)) + morphoVenue.debt(address(acct), address(usdc));
    }

    function _totalCollateral() internal view returns (uint256) {
        return aaveVenue.collateral(address(acct), address(cbbtc))
            + morphoVenue.collateral(address(acct), address(cbbtc));
    }

    /// Every venue the registry names for `asset`: the current pointer first, then the history —
    /// the same list `StrategyRouter._exitVenues` walks.
    function _venuesFor(address asset) internal view returns (address[] memory venues) {
        address[] memory prev = registry.previousVenues(asset);
        venues = new address[](prev.length + 1);
        venues[0] = registry.venueOf(asset);
        for (uint256 i = 0; i < prev.length; i++) {
            venues[i + 1] = prev[i];
        }
    }

    bytes4 internal constant ERROR_STRING_SELECTOR = 0x08c379a0; // Error(string)
    bytes4 internal constant PANIC_SELECTOR = 0x4e487b71; // Panic(uint256)

    /// A revert "by name" is a custom error: four bytes of selector that are not `Error(string)`,
    /// not `Panic(uint256)` and not zero. Empty data is the shape of a bare `revert()`, an
    /// out-of-gas and a proxy miss, and is never a name.
    function _revertName(bytes memory ret) internal pure returns (bytes4 sel, bool named) {
        if (ret.length < 4) return (bytes4(0), false);
        assembly ("memory-safe") {
            sel := mload(add(ret, 32))
        }
        named = sel != bytes4(0) && sel != ERROR_STRING_SELECTOR && sel != PANIC_SELECTOR;
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
        // 2b. The Morpho book, raw at Morpho (2026-09-10, once the handler could open there): repay
        //     by SHARES when the account holds enough USDC (Morpho's rounding cannot leave a wei of
        //     debt that way), else whatever it holds; withdraw the collateral once nothing is owed.
        if (!_rawExitMorpho()) return false;
        address[3] memory toks = [address(usdc), address(cbbtc), address(weth)];
        for (uint256 i = 0; i < 3; i++) {
            uint256 bal = IERC20(toks[i]).balanceOf(address(acct));
            if (bal == 0) continue;
            (bool ok,) = _execPlain(toks[i], abi.encodeCall(IERC20.transfer, (alice, bal)));
            if (!ok) return false;
        }
        return true;
    }

    function _rawExitMorpho() internal returns (bool) {
        bytes32 mid = morphoVenue.marketIdOf(address(cbbtc));
        MarketParams memory mp = morphoVenue.marketParamsOf(address(cbbtc));
        (, uint128 bShares, uint128 coll) = morpho.position(mid, address(acct));
        if (bShares != 0) {
            uint256 owedM = morphoVenue.debt(address(acct), address(usdc));
            uint256 heldM = usdc.balanceOf(address(acct));
            if (heldM != 0) {
                bytes memory repayData = heldM >= owedM
                    ? abi.encodeCall(IMorphoBlue.repay, (mp, 0, bShares, address(acct), ""))
                    : abi.encodeCall(IMorphoBlue.repay, (mp, heldM, 0, address(acct), ""));
                Call[] memory calls = new Call[](3);
                calls[0] = Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(morpho), heldM)), false);
                calls[1] = Call(address(morpho), 0, repayData, false);
                calls[2] = Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(morpho), 0)), false);
                vm.prank(alice);
                (bool ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execBatch, (calls)));
                if (!ok) return false;
            }
            (, bShares, coll) = morpho.position(mid, address(acct));
        }
        if (bShares == 0 && coll != 0) {
            (bool ok,) = _execPlain(
                address(morpho),
                abi.encodeCall(IMorphoBlue.withdrawCollateral, (mp, coll, address(acct), address(acct)))
            );
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
        address[5] memory peripherals =
            [address(router), address(aaveVenue), address(lpVenue), address(swapAdapter), address(morphoVenue)];
        MockERC20[4] memory toks = [usdc, weth, cbbtc, aero];
        address to = peripherals[seed % 5];
        MockERC20 t = toks[(seed / 5) % 4];
        amount = bound(amount, 1, 1_000e6);
        t.mint(to, amount);
        g_donated[to][address(t)] += amount;
        g_donations++;
    }
}
