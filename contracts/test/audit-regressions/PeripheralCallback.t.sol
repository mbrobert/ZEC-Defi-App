// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "../Fixture.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {Call, IOilskinAccount, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {ICollateralRegistry} from "../../src/interfaces/ICollateralRegistry.sol";
import {IMorphoBlue} from "../../src/interfaces/IMorphoBlue.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {CrossAccountProbe, DepthProbe, HostileToken, LateCaller, RogueVenue} from "./AuditMocks.sol";
import {RelayPeripheral} from "../mocks/TestPeripherals.sol";

/// @notice Harvested from wave-1 lens A (`test/poc/PeripheralCallback.t.sol`), expectations flipped
///         to the FIXED behaviour with the attack setups kept intact.
///
///   A-HIGH-2  the registry owner could point an asset at a contract of their choosing in ONE
///             transaction, and that contract became the active peripheral on every account that
///             called the router. Replacing a venue is timelocked and announced now (D4), and the
///             residual is stated plainly in the report: a timelocked owner is still an owner.
///   A-LOW-4   `execNestedPeripheral` nesting was bounded only by gas (40 levels demonstrated).
///   Controls: the window is per root call, per account, and non-transitive — all still true.
contract PeripheralCallbackRegressionTest is Fixture {
    address thief = makeAddr("thief");
    RelayPeripheral relay;
    RelayPeripheral relay2;

    function setUp() public override {
        super.setUp();
        relay = new RelayPeripheral();
        relay2 = new RelayPeripheral();
        usdc.mint(address(acct), 1_000_000e6);
        cbbtc.mint(address(acct), 10e8);
        weth.mint(address(acct), 100e18);
    }

    // =====================================================================
    // Controls that must keep holding.
    // =====================================================================

    function test_FIX_B1_windowIsStillPerRootCallInsideOneExecBatch() public {
        LateCaller late = new LateCaller();
        late.remember(address(acct));

        Call[] memory batch = new Call[](2);
        batch[0] = _callP(address(late), abi.encodeWithSignature("noop()"));
        Call[] memory inner = _one(_call(address(late), abi.encodeWithSignature("callBackNow()")));
        batch[1] = _callP(address(relay), abi.encodeCall(RelayPeripheral.run, (inner)));

        vm.prank(alice);
        acct.execBatch(batch);
        assertFalse(late.lateOk(), "a peripheral from an earlier batch call must not act later");
        assertEq(bytes4(late.lateRevert()), OilskinAccount.NotActivePeripheral.selector);
    }

    function test_FIX_B2_crossAccountIsolationInOneTransaction() public {
        OilskinAccount bobAcct = OilskinAccount(payable(factory.createAccount(bob)));
        usdc.mint(address(bobAcct), 1_000e6);
        CrossAccountProbe probe = new CrossAccountProbe();
        probe.setOther(address(bobAcct));

        vm.prank(alice);
        acct.execWithCallback(address(probe), 0, abi.encodeWithSignature("tryOther()"));
        assertFalse(probe.crossOk(), "peripheral rights must not cross accounts");
        assertEq(bytes4(probe.crossRevert()), OilskinAccount.NotActivePeripheral.selector);
    }

    // =====================================================================
    // FIX A-LOW-4. Nesting is bounded. The PoC drove 40 self-directed levels; the account now
    // refuses past MAX_PERIPHERAL_DEPTH (the real composition, router → venue, is two).
    // =====================================================================
    function test_FIX_B3_nestingDepthIsBounded() public {
        uint256 cap = acct.MAX_PERIPHERAL_DEPTH();
        DepthProbe probe = new DepthProbe();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.PeripheralDepthExceeded.selector, cap)
        );
        acct.execWithCallback(address(probe), 0, abi.encodeWithSignature("dive(uint256)", uint256(40)));

        // Depth inside the bound still works: nothing legitimate is broken.
        vm.prank(alice);
        acct.execWithCallback(address(probe), 0, abi.encodeWithSignature("dive(uint256)", cap - 1));
        assertEq(probe.reached(), cap - 1);
    }

    /// A nested peripheral is still the ACTIVE peripheral's deliberate choice — but the only way to
    /// reach that state is through a call the OWNER opted in to.
    function test_FIX_B3b_aPlainCallCannotStartANestingChain() public {
        HostileToken host = new HostileToken();
        host.mint(address(acct), 1e18);
        Call[] memory loot = _one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 1_000e6))));
        host.arm(loot);
        // The relay is reached by a PLAIN call, so it has no door to nest through.
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.exec(
            address(relay),
            0,
            abi.encodeCall(
                RelayPeripheral.runNested,
                (address(host), 0, abi.encodeCall(IERC20.transfer, (alice, 1)))
            )
        );
        assertEq(usdc.balanceOf(thief), 0);
    }

    // =====================================================================
    // FIX A-HIGH-2 / D4. Swapping a venue under live users takes a timelock and two announced
    // transactions. Inside the delay every user account is untouched, and an off-chain watcher can
    // read the pending change and act on it.
    // =====================================================================
    function test_FIX_B4_registryOwnerCannotSwapAVenueInOneTransaction() public {
        RogueVenue rogue = new RogueVenue(address(usdc), thief);

        // The one-transaction path is gone: `register` refuses a known asset outright.
        vm.prank(registryOwner);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.AssetAlreadyRegistered.selector, address(cbbtc))
        );
        registry.register(address(cbbtc), address(rogue), makeAddr("feed"), true, "");

        // The only path is propose → wait → accept, and the proposal is a public event.
        vm.prank(registryOwner);
        registry.proposeVenue(address(cbbtc), address(rogue), makeAddr("feed"));
        assertEq(registry.pendingVenue(address(cbbtc)).venue, address(rogue), "visible to a watcher");
        assertEq(registry.venueOf(address(cbbtc)), address(aaveVenue), "and not yet in force");

        // Meanwhile the user's unwind still runs against the REAL venue.
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.repayAmount = 1;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 1 hours;
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(usdc.balanceOf(thief), 0, "nothing was redirected inside the delay");

        // The user's window to act: revoke the keeper, exit, or both.
        vm.prank(alice);
        acct.revokeAll();
        vm.prank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, 1_000_000e6)));
        assertEq(usdc.balanceOf(alice), 1_000_000e6, "the owner exits during the delay");
    }

    /// FIX A-MED-3. The exit path no longer follows a venue that reports itself DISABLED, even
    /// though the ASSET flag is still bypassed on exit.
    function test_FIX_B4b_exitRefusesADisabledVenueButNotADisabledAsset() public {
        cbbtc.mint(address(acct), 1e8);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 1e8)));
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "delisted");

        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.repayAmount = 0;
        u.withdrawAmount = type(uint256).max;
        u.deadline = block.timestamp + 1 hours;
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(cbbtc.balanceOf(address(acct)), 10e8 + 1e8, "a disabled ASSET still exits");

        // A disabled VENUE is a different thing: that is code we will not delegate to. A Morpho
        // venue built over no markets (the Sepolia shape) is one.
        MorphoBlueVenue off = new MorphoBlueVenue(
            IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), new bytes32[](0)
        );
        vm.prank(registryOwner);
        registry.register(address(aero), address(off), address(0), false, "no morpho market for this asset");
        u.collateralAsset = address(aero);
        u.withdrawAmount = 0;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.VenueDisabled.selector, address(off)));
        acct.execWithCallback(address(router), 0, data);
    }

    // =====================================================================
    // FIX B5. The web's exact protection grant (target = router, selector = unwind, USDC budget)
    // against a venue the registry owner has proposed but not yet accepted.
    // =====================================================================
    function test_FIX_B5_theShippedKeeperGrantCannotBeRedirectedInsideTheDelay() public {
        vm.startPrank(alice);
        acct.exec(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (address(aave), 10e8)));
        acct.exec(
            address(aave),
            0,
            abi.encodeWithSignature(
                "supply(address,uint256,address,uint16)", address(cbbtc), uint256(10e8), address(acct), uint16(0)
            )
        );
        vm.stopPrank();
        assertEq(aave.collateralOf(address(acct), address(cbbtc)), 10e8);

        RogueAaveVenue rogue = new RogueAaveVenue(address(aave), address(cbbtc), thief);
        vm.prank(registryOwner);
        registry.proposeVenue(address(cbbtc), address(rogue), makeAddr("feed"));

        TokenLimit[] memory lims = new TokenLimit[](1);
        lims[0] = TokenLimit(address(usdc), 1);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, lims, 0));

        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.repayAmount = 0;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 1 hours;

        vm.prank(keeper);
        acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        assertEq(cbbtc.balanceOf(thief), 0, "the pending venue has no authority yet");
        assertEq(aave.collateralOf(address(acct), address(cbbtc)), 10e8, "collateral intact");
    }

    // =====================================================================
    // FIX B6 / B7. Owner doors stay owner-only; peripheral-to-peripheral reentrancy is bounded.
    // =====================================================================
    function test_FIX_B6_peripheralStillCannotReachOwnerDoors() public {
        bytes[4] memory payloads = [
            abi.encodeWithSignature("revokeAll()"),
            abi.encodeWithSignature("revoke(address,address,bytes4)", keeper, address(router), bytes4(0x11223344)),
            abi.encodeWithSignature("exec(address,uint256,bytes)", address(usdc), 0, ""),
            abi.encodeWithSignature("execBatch((address,uint256,bytes,bool)[])", new Call[](0))
        ];
        for (uint256 i = 0; i < 4; i++) {
            Call[] memory inner = _one(_call(address(acct), payloads[i]));
            vm.prank(alice);
            vm.expectRevert(OilskinAccount.NotOwner.selector);
            acct.execWithCallback(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (inner)));
        }
        Call[] memory k = _one(
            _call(
                address(acct),
                abi.encodeWithSignature("execAsKeeper((address,uint256,bytes,bool)[])", new Call[](0))
            )
        );
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.Reentrancy.selector);
        acct.execWithCallback(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (k)));
    }

    function test_FIX_B7_peripheralReentrancyIsBoundedAndDocumented() public {
        ReenterCounter a = new ReenterCounter();
        ReenterCounter b = new ReenterCounter();
        a.setPartner(address(b));
        b.setPartner(address(0));
        vm.prank(alice);
        acct.execWithCallback(address(a), 0, abi.encodeWithSignature("go()"));
        // Still reachable — the account's lock guards its own doors, not a venue's state — but the
        // depth is bounded, and Peripheral.sol now says plainly that a stateful venue must carry
        // its own guard. Today's venues are stateless.
        assertEq(a.depth(), 2);
        assertLe(a.depth(), acct.MAX_PERIPHERAL_DEPTH());
        assertEq(acct.MAX_PERIPHERAL_DEPTH(), 8);
    }

    /// FIX: a call a PERIPHERAL asks the account to make may not ask for callback rights.
    function test_FIX_B8_peripheralCallsCannotRequestCallbackRights() public {
        Call[] memory inner = _one(_callP(address(relay2), abi.encodeWithSignature("noop()")));
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.CallbackNotPermitted.selector);
        acct.execWithCallback(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (inner)));
    }
}

/// @notice Two peripherals that bounce into each other through the account (from the PoC).
contract ReenterCounter {
    address public partner;
    uint256 public depth;
    uint256 internal _live;

    function setPartner(address p) external {
        partner = p;
    }

    function go() external {
        _live++;
        if (_live > depth) depth = _live;
        if (partner != address(0) && _live < 2) {
            OilskinAccount(payable(msg.sender)).execNestedPeripheral(
                partner, 0, abi.encodeWithSignature("bounce(address)", address(this))
            );
        }
        _live--;
    }

    function bounce(address back) external {
        OilskinAccount(payable(msg.sender)).execNestedPeripheral(back, 0, abi.encodeWithSignature("go()"));
    }
}

/// @notice The rogue venue from the PoC: it exfiltrates through Aave's
///         `withdraw(address,uint256,address)`, a selector the budget parser does not recognise.
contract RogueAaveVenue {
    address public immutable POOL;
    address public immutable ASSET;
    address public immutable THIEF;

    constructor(address pool, address asset, address thief) {
        POOL = pool;
        ASSET = asset;
        THIEF = thief;
    }

    function enabled() external pure returns (bool) {
        return true;
    }

    function liquidationThresholdBps(address) external pure returns (uint256) {
        return 7800;
    }

    function maxLtvBps(address) external pure returns (uint256) {
        return 7300;
    }

    function healthFactor(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function debt(address, address) external pure returns (uint256) {
        return 0;
    }

    function collateral(address, address) external pure returns (uint256) {
        return 0;
    }

    function borrowRateRay(address) external pure returns (uint256) {
        return 0;
    }

    function supply(address, uint256) external {
        _loot();
    }

    function withdraw(address, uint256) external returns (uint256) {
        _loot();
        return 0;
    }

    function borrow(address, uint256) external {
        _loot();
    }

    function repay(address, uint256) external returns (uint256) {
        _loot();
        return 0;
    }

    function _loot() internal {
        Call[] memory c = new Call[](1);
        c[0] = Call({
            target: POOL,
            value: 0,
            data: abi.encodeWithSignature(
                "withdraw(address,uint256,address)", ASSET, type(uint256).max, THIEF
            ),
            callback: false
        });
        IOilskinAccount(msg.sender).execFromPeripheral(c);
    }
}
