// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../../src/account/OilskinAccountFactory.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAave} from "../mocks/MockAave.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {ExoticToken, HostileToken, PocPermit2} from "./AuditMocks.sol";

/// @notice Harvested from wave-1 lens A (`test/poc/GrantEscape.t.sol`), expectations flipped to the
///         FIXED behaviour with every attack setup kept intact.
///
///   A-HIGH-3  every contract the account called became the active peripheral with unbudgeted
///             authority, so a raw `exec` to a hostile token — or a grant on "1 wei of X" —
///             escalated to a full drain. Peripheral rights are OPT-IN now: `Call.callback` for the
///             owner, `Permission.allowCallback` for a keeper (never the keeper's own choice).
///   A-MED-1   the budget parser reads six selectors; four token movers it cannot read passed FREE.
///             They are REFUSED on the keeper path now (`UnbudgetableSelector`).
///   A-LOW-2   a token budget of zero read as "listed" and behaved as "absent".
///   A-INFO-2  a grant on selector 0 was a blanket permit for any call with <4 bytes of data.
contract GrantEscapeRegressionTest is Test {
    MockPermit2 permit2;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    MockERC20 usdc;
    MockERC20 cbbtc;
    MockAave aave;

    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");
    address thief = makeAddr("thief");

    function setUp() public {
        permit2 = new MockPermit2();
        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(alice)));
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cbbtc = new MockERC20("Coinbase Wrapped BTC", "cbBTC", 8);
        aave = new MockAave();
        aave.setReserve(address(cbbtc), 7300, 7800, 750, true, true, 79_593_77000000, 0.00673e27);
        aave.setReserve(address(usdc), 7500, 7800, 500, true, true, 1_00000000, 0.04828e27);
        usdc.mint(address(aave), 10_000_000e6);
        usdc.mint(address(acct), 1_000_000e6);
        cbbtc.mint(address(acct), 10e8);
    }

    // ------------------------------------------------------------- helpers

    function _call(address t, bytes memory d) internal pure returns (Call memory) {
        return Call({target: t, value: 0, data: d, callback: false});
    }

    function _callP(address t, bytes memory d) internal pure returns (Call memory) {
        return Call({target: t, value: 0, data: d, callback: true});
    }

    function _one(Call memory c) internal pure returns (Call[] memory a) {
        a = new Call[](1);
        a[0] = c;
    }

    function _perm(address target, bytes4 sel, TokenLimit[] memory lim)
        internal
        view
        returns (Permission memory p)
    {
        p.target = target;
        p.selector = sel;
        p.maxValuePerPeriod = 0;
        p.tokenLimits = lim;
        p.period = 1 days;
        p.expiry = uint40(block.timestamp + 30 days);
        p.allowCallback = false;
    }

    function _lim(address t, uint256 a) internal pure returns (TokenLimit[] memory l) {
        l = new TokenLimit[](1);
        l[0] = TokenLimit(t, a);
    }

    function _none() internal pure returns (TokenLimit[] memory l) {
        l = new TokenLimit[](0);
    }

    function _supplyCollateral(uint256 amount) internal {
        vm.startPrank(alice);
        acct.exec(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (address(aave), amount)));
        acct.exec(
            address(aave),
            0,
            abi.encodeWithSignature(
                "supply(address,uint256,address,uint16)", address(cbbtc), amount, address(acct), uint16(0)
            )
        );
        vm.stopPrank();
    }

    // =====================================================================
    // FIX A1. The narrowest imaginable grant — "move 1 wei of HOST" — used to become unbudgeted
    // control of every asset the account held. The grant does not carry callback rights now, so
    // the token is never the active peripheral and its hook has no door to walk through.
    // =====================================================================
    function test_FIX_A1_grantedTokenTargetCannotReachTheAccountAtAll() public {
        HostileToken host = new HostileToken();
        host.mint(address(acct), 1e18);
        _supplyCollateral(10e8);
        assertEq(aave.collateralOf(address(acct), address(cbbtc)), 10e8, "collateral supplied");

        vm.prank(alice);
        acct.grant(keeper, _perm(address(host), IERC20.transfer.selector, _lim(address(host), 1)));

        Call[] memory loot = _one(
            _call(
                address(aave),
                abi.encodeWithSignature(
                    "withdraw(address,uint256,address)", address(cbbtc), type(uint256).max, thief
                )
            )
        );
        host.arm(loot);

        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(host), abi.encodeCall(IERC20.transfer, (keeper, 1)))));

        assertFalse(host.fired(), "the token got no peripheral door");
        assertEq(bytes4(host.lastRevert()), OilskinAccount.NotActivePeripheral.selector);
        assertEq(cbbtc.balanceOf(thief), 0, "nothing stolen");
        assertEq(aave.collateralOf(address(acct), address(cbbtc)), 10e8, "collateral untouched");
        (, uint256 spent) = acct.tokenBudgetOf(keeper, address(host), IERC20.transfer.selector, address(host));
        assertEq(spent, 1, "exactly the 1 wei the user granted");
    }

    /// …and the keeper cannot grant ITSELF the door: the flag comes from the owner's permission.
    function test_FIX_A1b_keeperCannotSetTheCallbackFlagItself() public {
        HostileToken host = new HostileToken();
        host.mint(address(acct), 1e18);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(host), IERC20.transfer.selector, _lim(address(host), 1)));
        Call[] memory loot = _one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 1_000e6))));
        host.arm(loot);
        // The keeper asks for callback: true. The account reads the GRANT, not the call.
        vm.prank(keeper);
        acct.execAsKeeper(_one(_callP(address(host), abi.encodeCall(IERC20.transfer, (keeper, 1)))));
        assertFalse(host.fired(), "the keeper's own flag is ignored");
        assertEq(usdc.balanceOf(thief), 0);
    }

    // =====================================================================
    // FIX A2. The documented exit door — a raw owner `exec` — is a PLAIN call: a token whose code
    // the user does not control (cbZEC is a B20 precompile with an issuer-controlled
    // implementation) can no longer empty the account through it.
    // =====================================================================
    function test_FIX_A2_ownerExecOnAHostileTokenIsAPlainCall() public {
        HostileToken host = new HostileToken();
        host.mint(address(acct), 1e18);

        Call[] memory loot = new Call[](2);
        loot[0] = _call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 1_000_000e6)));
        loot[1] = _call(address(cbbtc), abi.encodeCall(IERC20.transfer, (thief, 10e8)));
        host.arm(loot);

        vm.prank(alice);
        acct.exec(address(host), 0, abi.encodeCall(IERC20.transfer, (alice, 1)));

        assertFalse(host.fired(), "the exit door hands out nothing");
        assertEq(usdc.balanceOf(thief), 0, "USDC safe");
        assertEq(cbbtc.balanceOf(thief), 0, "cbBTC safe");
        assertEq(usdc.balanceOf(address(acct)), 1_000_000e6);
        assertEq(host.balanceOf(alice), 1, "and the transfer the owner asked for still happened");
    }

    /// The opt-in still exists and still works — that is how the router composes venues.
    function test_FIX_A2b_execWithCallbackIsTheDeliberateOptIn() public {
        HostileToken host = new HostileToken();
        host.mint(address(acct), 1e18);
        Call[] memory move = _one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (alice, 5e6))));
        host.arm(move);
        vm.prank(alice);
        acct.execWithCallback(address(host), 0, abi.encodeCall(IERC20.transfer, (alice, 1)));
        assertTrue(host.fired(), "an explicit opt-in still opens the window");
        assertEq(usdc.balanceOf(alice), 5e6);
    }

    // =====================================================================
    // FIX A3 / A4 / A4b. The four token movers the budget parser cannot read are REFUSED on the
    // keeper path instead of passing free. (Refusing was chosen over budgeting: no Oilskin flow
    // asks a keeper to batch-transfer through Permit2, spend an owner signature, or call an
    // ERC-777 / ERC-677 entry point — see /tmp/fix2/done-CONTRACTS.md.)
    // =====================================================================
    function test_FIX_A3_permit2BatchTransferFromIsRefused() public {
        PocPermit2 p2 = new PocPermit2();
        OilskinAccountFactory f2 = new OilskinAccountFactory(address(p2));
        OilskinAccount a2 = OilskinAccount(payable(f2.createAccount(alice)));
        usdc.mint(address(a2), 500_000e6);

        vm.startPrank(alice);
        a2.exec(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(p2), type(uint256).max)));
        a2.exec(
            address(p2),
            0,
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)",
                address(usdc), address(a2), type(uint160).max, uint48(block.timestamp + 365 days)
            )
        );
        vm.stopPrank();

        bytes4 batchSel = bytes4(keccak256("transferFrom((address,address,uint160,address)[])"));
        vm.prank(alice);
        a2.grant(keeper, _perm(address(p2), batchSel, _none()));

        PocPermit2.AllowanceTransferDetails[] memory d = new PocPermit2.AllowanceTransferDetails[](1);
        d[0] = PocPermit2.AllowanceTransferDetails(address(a2), thief, uint160(500_000e6), address(usdc));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.UnbudgetableSelector.selector, address(p2), batchSel)
        );
        a2.execAsKeeper(_one(_call(address(p2), abi.encodeWithSelector(batchSel, d))));
        assertEq(usdc.balanceOf(thief), 0, "the batch overload moved nothing");

        // The single-argument overload the parser DOES know still fails closed on the budget.
        bytes4 singleSel = bytes4(keccak256("transferFrom(address,address,uint160,address)"));
        vm.prank(alice);
        a2.grant(keeper, _perm(address(p2), singleSel, _none()));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(OilskinAccount.TokenNotBudgeted.selector, address(usdc)));
        a2.execAsKeeper(
            _one(
                _call(
                    address(p2),
                    abi.encodeWithSignature(
                        "transferFrom(address,address,uint160,address)", address(a2), thief, uint160(1), address(usdc)
                    )
                )
            )
        );
    }

    function test_FIX_A4_exoticTransferSelectorsAreRefused() public {
        ExoticToken exo = new ExoticToken();
        exo.mint(address(acct), 1000e18);

        bytes4 sendSel = bytes4(keccak256("send(address,uint256,bytes)"));
        vm.prank(alice);
        acct.grant(keeper, _perm(address(exo), sendSel, _none()));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.UnbudgetableSelector.selector, address(exo), sendSel)
        );
        acct.execAsKeeper(_one(_call(address(exo), abi.encodeWithSelector(sendSel, thief, 400e18, ""))));

        bytes4 tacSel = bytes4(keccak256("transferAndCall(address,uint256,bytes)"));
        vm.prank(alice);
        acct.grant(keeper, _perm(address(exo), tacSel, _none()));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.UnbudgetableSelector.selector, address(exo), tacSel)
        );
        acct.execAsKeeper(_one(_call(address(exo), abi.encodeWithSelector(tacSel, thief, 300e18, ""))));

        assertEq(exo.balanceOf(thief), 0, "nothing left on an unparsable mover");
        assertEq(exo.balanceOf(address(acct)), 1000e18);
    }

    /// The one that reached OUTSIDE the account — spending an owner signature to drain the owner's
    /// WALLET — is refused too.
    function test_FIX_A4b_permitTransferFromInsideAKeeperCallIsRefused() public {
        uint256 ownerKey = 0xA11CE;
        address owner_ = vm.addr(ownerKey);
        OilskinAccount a3 = OilskinAccount(payable(factory.createAccount(owner_)));
        cbbtc.mint(owner_, 5e8);
        vm.prank(owner_);
        cbbtc.approve(address(permit2), type(uint256).max);

        uint256 deadline = block.timestamp + 20 minutes;
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: address(cbbtc), amount: 5e8}),
            nonce: 42,
            deadline: deadline
        });
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(ownerKey, permit2.hashPermit(permit, address(a3)));
        bytes memory sig = abi.encodePacked(r, s_, v);

        bytes4 sel = bytes4(
            keccak256(
                "permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)"
            )
        );
        vm.prank(owner_);
        a3.grant(keeper, _perm(address(permit2), sel, _none()));

        IPermit2.SignatureTransferDetails memory det =
            IPermit2.SignatureTransferDetails({to: thief, requestedAmount: 5e8});
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.UnbudgetableSelector.selector, address(permit2), sel)
        );
        a3.execAsKeeper(
            _one(_call(address(permit2), abi.encodeWithSelector(sel, permit, det, owner_, sig)))
        );
        assertEq(cbbtc.balanceOf(thief), 0, "the owner's wallet is untouched");
        assertEq(cbbtc.balanceOf(owner_), 5e8);

        // The OWNER can still spend their own signature — this is a keeper-path refusal only, and
        // the router's Permit2 pull on the open path runs as the owner.
        vm.prank(owner_);
        a3.exec(address(permit2), 0, abi.encodeWithSelector(sel, permit, det, owner_, sig));
        assertEq(cbbtc.balanceOf(thief), 5e8, "the owner may always spend their own signature");
    }

    // =====================================================================
    // Positive controls from the PoC that MUST keep holding.
    // =====================================================================

    function test_FIX_A5_trailingBytesStillDoNotSplitParserFromToken() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 10e6)));
        bytes memory padded = abi.encodePacked(
            abi.encodeCall(IERC20.transfer, (thief, uint256(5e6))),
            bytes32(uint256(999)),
            bytes32(uint256(999))
        );
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(usdc), padded)));
        assertEq(usdc.balanceOf(thief), 5e6);
        (, uint256 spent) = acct.tokenBudgetOf(keeper, address(usdc), IERC20.transfer.selector, address(usdc));
        assertEq(spent, 5e6, "parser charged what the token moved");

        bytes memory padded2 =
            abi.encodePacked(abi.encodeCall(IERC20.transfer, (thief, uint256(6e6))), bytes32(uint256(1)));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 6e6, 5e6)
        );
        acct.execAsKeeper(_one(_call(address(usdc), padded2)));
    }

    function test_FIX_A6b_sameGrantStillAccumulatesAcrossRootCalls() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 100e6)));
        Call[] memory calls = new Call[](3);
        calls[0] = _call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 40e6)));
        calls[1] = _call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 40e6)));
        calls[2] = _call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 40e6)));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 40e6, 20e6)
        );
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(thief), 0, "atomic: nothing moved");
    }

    // =====================================================================
    // FIX A7 / A8. A zero budget and a selector-0 grant are both refused at grant time.
    // =====================================================================
    function test_FIX_A7_zeroBudgetAndDuplicateListingAreRefused() public {
        TokenLimit[] memory l = new TokenLimit[](2);
        l[0] = TokenLimit(address(usdc), 0);
        l[1] = TokenLimit(address(usdc), 50e6);
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, l));

        // …and a plain duplicate is still refused, now that a zero cannot hide one.
        l[0] = TokenLimit(address(usdc), 1);
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, l));
    }

    function test_FIX_A8_emptyCalldataSelectorIsNotGrantable() public {
        vm.deal(address(acct), 5 ether);
        Permission memory p;
        p.target = thief;
        p.selector = bytes4(0);
        p.maxValuePerPeriod = 5 ether;
        p.tokenLimits = _none();
        p.period = 1 days;
        p.expiry = uint40(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, p);
        assertEq(thief.balance, 0);
    }

    // =====================================================================
    // FIX A-MED-2. A re-grant inside a live period no longer refills a spent budget.
    // =====================================================================
    function test_FIX_C5_regrantDoesNotRefillTheWindow() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 100e6)));
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 100e6)))));

        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 100e6)));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 1, 0)
        );
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 1)))));
        assertEq(usdc.balanceOf(thief), 100e6, "100 USDC in one 'per day' window, not 200");

        // Once the period rolls, the budget refills exactly once.
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 100e6)))));
        assertEq(usdc.balanceOf(thief), 200e6);
    }

    // =====================================================================
    // FIX A-LOW-3. `tokenBudgetOf` applies the period roll, so a client never renders an exhausted
    // budget the chain would in fact refill.
    // =====================================================================
    function test_FIX_C6_tokenBudgetOfIsNotStaleAfterThePeriodRolls() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 100e6)));
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.transfer, (thief, 100e6)))));
        (, uint256 spent) = acct.tokenBudgetOf(keeper, address(usdc), IERC20.transfer.selector, address(usdc));
        assertEq(spent, 100e6, "inside the period the view is exact");

        vm.warp(block.timestamp + 10 days);
        (, spent) = acct.tokenBudgetOf(keeper, address(usdc), IERC20.transfer.selector, address(usdc));
        assertEq(spent, 0, "after the roll the view agrees with the chain");
        (,, uint256 valueSpent,,,,) = acct.grantOf(keeper, address(usdc), IERC20.transfer.selector);
        assertEq(valueSpent, 0);
    }

    // =====================================================================
    // FIX A-LOW-5. `revoke` on a key that was never granted is a named refusal, so a watcher can
    // tell "a kill switch fired" from "nothing happened".
    // =====================================================================
    function test_FIX_C7_revokeOfNothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                OilskinAccount.NotRevocable.selector, keeper, address(0xdead), bytes4(0x12345678)
            )
        );
        acct.revoke(keeper, address(0xdead), bytes4(0x12345678));

        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, _lim(address(usdc), 1)));
        vm.expectEmit(true, true, true, false);
        emit Revoked(keeper, address(usdc), IERC20.transfer.selector);
        vm.prank(alice);
        acct.revoke(keeper, address(usdc), IERC20.transfer.selector);
    }

    event Revoked(address indexed keeper, address indexed target, bytes4 indexed selector);
}
