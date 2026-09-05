// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../src/account/OilskinAccountFactory.sol";
import {Call, IOilskinAccount, Permission, TokenLimit} from "../src/interfaces/IOilskinAccount.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockB20} from "./mocks/MockB20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {
    EthSink,
    HookToken,
    ReentrantTarget,
    RelayPeripheral,
    TestERC1155,
    TestERC721
} from "./mocks/TestPeripherals.sol";

contract AccountTest is Test {
    MockPermit2 permit2;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    MockERC20 usdc;
    MockERC20 weth;
    RelayPeripheral relay;
    RelayPeripheral relay2;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    function setUp() public {
        permit2 = new MockPermit2();
        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(alice)));
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        relay = new RelayPeripheral();
        relay2 = new RelayPeripheral();
        usdc.mint(address(acct), 1_000_000e6);
        weth.mint(address(acct), 100e18);
        vm.deal(address(acct), 10 ether);
    }

    // ------------------------------------------------------------- helpers

    function _call(address target, bytes memory data) internal pure returns (Call memory) {
        return Call({target: target, value: 0, data: data});
    }

    function _transfer(address token, address to, uint256 amount) internal pure returns (Call memory) {
        return _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _one(Call memory c) internal pure returns (Call[] memory arr) {
        arr = new Call[](1);
        arr[0] = c;
    }

    function _perm(address target, bytes4 sel, address token, uint256 limit, uint256 maxValue)
        internal
        view
        returns (Permission memory p)
    {
        p.target = target;
        p.selector = sel;
        p.maxValuePerPeriod = maxValue;
        p.period = 1 days;
        p.expiry = uint40(block.timestamp + 30 days);
        if (token != address(0)) {
            p.tokenLimits = new TokenLimit[](1);
            p.tokenLimits[0] = TokenLimit(token, limit);
        }
    }

    function _grantTransfer(address token, uint256 limit) internal {
        vm.prank(alice);
        acct.grant(keeper, _perm(token, IERC20.transfer.selector, token, limit, 0));
    }

    // ------------------------------------------------------------- factory

    function test_factory_predictsAndDeploysSameAddress() public view {
        assertEq(factory.accountOf(alice), address(acct));
        assertTrue(factory.isDeployed(alice));
        assertFalse(factory.isDeployed(bob));
        assertEq(acct.owner(), alice);
        assertEq(acct.FACTORY(), address(factory));
        assertEq(acct.PERMIT2(), address(permit2));
    }

    function test_factory_createIsIdempotentAndEmitsOnce() public {
        address predicted = factory.accountOf(bob);
        vm.expectEmit(true, true, false, false);
        emit OilskinAccountFactory.AccountCreated(bob, predicted);
        address a1 = factory.createAccount(bob);
        address a2 = factory.createAccount(bob); // no revert, no second deployment
        assertEq(a1, predicted);
        assertEq(a2, a1);
        assertEq(OilskinAccount(payable(a1)).owner(), bob);
    }

    function test_factory_anyoneMayCreateButOnlyForNamedOwner() public {
        vm.prank(bob);
        address a = factory.createAccount(alice);
        assertEq(a, address(acct));
        assertEq(OilskinAccount(payable(a)).owner(), alice);
    }

    function test_factory_zeroOwnerReverts() public {
        vm.expectRevert(OilskinAccountFactory.ZeroOwner.selector);
        factory.createAccount(address(0));
    }

    function test_factory_implementationIsBricked() public {
        OilskinAccount impl = OilskinAccount(payable(factory.IMPLEMENTATION()));
        assertEq(impl.owner(), address(1));
        Call[] memory none;
        vm.prank(address(factory));
        vm.expectRevert(OilskinAccount.AlreadyInitialized.selector);
        impl.initialize(alice, none);
    }

    function test_factory_createAccountAndExec_runsAsOwnerInOneTx() public {
        address predicted = factory.accountOf(bob);
        usdc.mint(predicted, 500e6);
        Call[] memory calls = _one(_transfer(address(usdc), bob, 200e6));
        vm.prank(bob);
        (address a, bytes[] memory results) = factory.createAccountAndExec(calls);
        assertEq(a, predicted);
        assertEq(results.length, 1);
        assertEq(usdc.balanceOf(bob), 200e6);
        assertEq(usdc.balanceOf(predicted), 300e6);
    }

    function test_factory_createAccountAndExec_forwardsValue() public {
        EthSink sink = new EthSink();
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(sink), value: 1 ether, data: ""});
        vm.deal(bob, 2 ether);
        vm.prank(bob);
        factory.createAccountAndExec{value: 1.5 ether}(calls);
        assertEq(sink.received(), 1 ether);
        assertEq(factory.accountOf(bob).balance, 0.5 ether);
    }

    function test_factory_createAccountAndExec_revertsIfExists() public {
        Call[] memory none;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccountFactory.AccountExists.selector, address(acct))
        );
        factory.createAccountAndExec(none);
    }

    function test_initialize_onlyFactoryAndOnce() public {
        Call[] memory none;
        vm.expectRevert(OilskinAccount.NotFactory.selector);
        acct.initialize(bob, none);
        vm.prank(address(factory));
        vm.expectRevert(OilskinAccount.AlreadyInitialized.selector);
        acct.initialize(bob, none);
    }

    // ---------------------------------------------------------------- owner

    function test_exec_ownerOnly() public {
        vm.prank(bob);
        vm.expectRevert(OilskinAccount.NotOwner.selector);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1)));
        vm.prank(keeper);
        vm.expectRevert(OilskinAccount.NotOwner.selector);
        acct.execBatch(_one(_transfer(address(usdc), bob, 1)));
    }

    function test_exec_movesTokensAndReturnsData() public {
        vm.prank(alice);
        bytes memory ret = acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (bob, 5e6)));
        assertTrue(abi.decode(ret, (bool)));
        assertEq(usdc.balanceOf(bob), 5e6);
    }

    function test_exec_bubblesRevertData() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC20InsufficientBalance(address,uint256,uint256)", address(acct), 1_000_000e6, 2_000_000e6
            )
        );
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (bob, 2_000_000e6)));
    }

    function test_exec_sendsValueAndReceivesEth() public {
        EthSink sink = new EthSink();
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        acct.exec{value: 1 ether}(address(sink), 3 ether, "");
        assertEq(sink.received(), 3 ether);
        assertEq(address(acct).balance, 8 ether);
        (bool ok,) = address(acct).call{value: 1 wei}("");
        assertTrue(ok);
    }

    function test_execBatch_runsInOrderAndReturnsAll() public {
        Call[] memory calls = new Call[](3);
        calls[0] = _transfer(address(usdc), bob, 1e6);
        calls[1] = _transfer(address(weth), bob, 1e18);
        calls[2] = _call(address(relay), abi.encodeCall(RelayPeripheral.noop, ()));
        vm.prank(alice);
        bytes[] memory results = acct.execBatch(calls);
        assertEq(results.length, 3);
        assertEq(abi.decode(results[2], (uint256)), 42);
        assertEq(usdc.balanceOf(bob), 1e6);
        assertEq(weth.balanceOf(bob), 1e18);
    }

    function test_execBatch_isAtomic() public {
        Call[] memory calls = new Call[](2);
        calls[0] = _transfer(address(usdc), bob, 1e6);
        calls[1] = _transfer(address(usdc), bob, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert();
        acct.execBatch(calls);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_exec_emitsExecuted() public {
        vm.expectEmit(true, true, false, true);
        emit OilskinAccount.Executed(alice, address(usdc), 0, IERC20.transfer.selector);
        vm.prank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1)));
    }

    // ------------------------------------------------------------ receivers

    function test_receivers_erc721AndErc1155() public {
        TestERC721 nft = new TestERC721();
        nft.safeMint(address(acct), 7);
        assertEq(nft.ownerOf(7), address(acct));
        TestERC1155 multi = new TestERC1155();
        multi.mint(address(acct), 1, 10);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amts = new uint256[](2);
        (ids[0], ids[1], amts[0], amts[1]) = (2, 3, 4, 5);
        multi.mintBatch(address(acct), ids, amts);
        assertEq(multi.balanceOf(address(acct), 1), 10);
        assertEq(multi.balanceOf(address(acct), 3), 5);
        assertTrue(acct.supportsInterface(0x01ffc9a7));
        assertTrue(acct.supportsInterface(0x150b7a02));
        assertTrue(acct.supportsInterface(0x4e2312e0));
        assertFalse(acct.supportsInterface(0xffffffff));
    }

    // ------------------------------------------------------------ reentrancy

    function test_reentrancy_ownerDoorsShutWhileExecuting() public {
        ReentrantTarget t = new ReentrantTarget();
        ReentrantTarget.Door[3] memory doors =
            [ReentrantTarget.Door.Exec, ReentrantTarget.Door.ExecBatch, ReentrantTarget.Door.ExecAsKeeper];
        for (uint256 i = 0; i < 3; i++) {
            t.arm(address(acct), doors[i]);
            vm.prank(alice);
            acct.exec(address(t), 0, abi.encodeCall(ReentrantTarget.hit, ()));
            assertFalse(t.reentered(), "re-entered");
            // exec / execBatch fail on NotOwner (msg.sender is the target); keeper on Reentrancy.
            bytes4 got = bytes4(t.lastRevert());
            assertTrue(
                got == OilskinAccount.NotOwner.selector || got == OilskinAccount.Reentrancy.selector,
                "unexpected revert"
            );
        }
    }

    function test_reentrancy_keeperDoorShutEvenForGrantedKeeperTarget() public {
        // Grant the reentrant target itself as a keeper root; it still cannot nest execAsKeeper.
        ReentrantTarget t = new ReentrantTarget();
        t.arm(address(acct), ReentrantTarget.Door.ExecAsKeeper);
        vm.prank(alice);
        acct.grant(address(t), _perm(address(t), ReentrantTarget.hit.selector, address(0), 0, 0));
        vm.prank(alice);
        acct.exec(address(t), 0, abi.encodeCall(ReentrantTarget.hit, ()));
        assertFalse(t.reentered());
        assertEq(bytes4(t.lastRevert()), OilskinAccount.Reentrancy.selector);
    }

    function test_reentrancy_activeTargetMayCallBack() public {
        ReentrantTarget t = new ReentrantTarget();
        t.arm(address(acct), ReentrantTarget.Door.ExecFromPeripheral);
        vm.prank(alice);
        acct.exec(address(t), 0, abi.encodeCall(ReentrantTarget.hit, ()));
        assertTrue(t.reentered(), "active peripheral must be able to call back");
    }

    function test_hookToken_cannotImpersonatePeripheral() public {
        HookToken hook = new HookToken();
        hook.arm(address(acct));
        // The relay is the active peripheral; it asks the account to call hook.transfer, whose hook
        // tries execFromPeripheral. The hook is NOT the active peripheral → refused (the hook
        // asserts this itself; a failure would revert the whole call).
        Call[] memory inner = _one(_transfer(address(hook), bob, 1));
        vm.prank(alice);
        acct.exec(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (inner)));
    }

    // ----------------------------------------------------------- peripherals

    function test_peripheral_onlyWhileActive() public {
        Call[] memory inner = _one(_transfer(address(usdc), bob, 1e6));
        vm.prank(address(relay)); // the relay outside any exec: not active
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.execFromPeripheral(inner);
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.execFromPeripheral(inner); // even the owner is not a peripheral
    }

    function test_peripheral_activeTargetActsAsAccount() public {
        Call[] memory inner = new Call[](2);
        inner[0] = _transfer(address(usdc), bob, 1e6);
        inner[1] = _call(address(relay2), abi.encodeCall(RelayPeripheral.noop, ()));
        vm.prank(alice);
        bytes memory ret = acct.exec(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (inner)));
        bytes[] memory results = abi.decode(ret, (bytes[]));
        assertEq(abi.decode(results[1], (uint256)), 42);
        assertEq(usdc.balanceOf(bob), 1e6);
    }

    function test_peripheral_innerTargetsGetNoCallbackRights() public {
        // relay (active) asks the account to call relay2.run(...) as a plain call; relay2 is not
        // active, so its callback is refused and the revert bubbles.
        Call[] memory deep = _one(_transfer(address(usdc), bob, 1e6));
        Call[] memory inner = _one(_call(address(relay2), abi.encodeCall(RelayPeripheral.run, (deep))));
        vm.prank(alice);
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.exec(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (inner)));
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_peripheral_nestedDelegationWorksAndRestores() public {
        Call[] memory deep = _one(_transfer(address(usdc), bob, 1e6));
        // relay → nested(relay2.run(deep)) → relay2 is active → works; then relay is active again.
        Call[] memory afterwards = _one(_transfer(address(weth), bob, 1e18));
        bytes memory nestedData = abi.encodeCall(RelayPeripheral.run, (deep));
        Call[] memory outer = new Call[](0);
        vm.startPrank(alice);
        acct.exec(address(relay), 0, abi.encodeCall(RelayPeripheral.runNested, (address(relay2), 0, nestedData)));
        // Prove restoration: in one exec, relay does nested then a plain run.
        bytes[] memory none = new bytes[](0);
        none;
        outer;
        acct.exec(address(relay), 0, abi.encodeCall(RelayPeripheral.run, (afterwards)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), 1e6);
        assertEq(weth.balanceOf(bob), 1e18);
    }

    function test_peripheral_nestedOnlyByActive() public {
        vm.prank(bob);
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.execNestedPeripheral(address(relay), 0, "");
    }

    // ---------------------------------------------------------------- grants

    function test_grant_ownerOnlyAndValidated() public {
        Permission memory p = _perm(address(usdc), IERC20.transfer.selector, address(usdc), 1, 0);
        vm.prank(bob);
        vm.expectRevert(OilskinAccount.NotOwner.selector);
        acct.grant(keeper, p);

        vm.startPrank(alice);
        Permission memory bad = p;
        bad.period = 0;
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, bad);

        bad = p;
        bad.expiry = uint40(block.timestamp);
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, bad);

        bad = p;
        bad.tokenLimits = new TokenLimit[](2);
        bad.tokenLimits[0] = TokenLimit(address(usdc), 1);
        bad.tokenLimits[1] = TokenLimit(address(usdc), 2); // duplicate
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, bad);

        bad = p;
        bad.tokenLimits = new TokenLimit[](1);
        bad.tokenLimits[0] = TokenLimit(address(0), 1);
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, bad);

        bad = p;
        bad.tokenLimits = new TokenLimit[](9);
        for (uint256 i = 0; i < 9; i++) {
            bad.tokenLimits[i] = TokenLimit(address(uint160(i + 1)), 1);
        }
        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(keeper, bad);

        vm.expectRevert(OilskinAccount.InvalidPermission.selector);
        acct.grant(address(0), p);

        vm.expectRevert(OilskinAccount.NotOwner.selector);
        vm.stopPrank();
        vm.prank(bob);
        acct.revoke(keeper, address(usdc), IERC20.transfer.selector);
        vm.prank(bob);
        vm.expectRevert(OilskinAccount.NotOwner.selector);
        acct.revokeAll();
    }

    function test_keeper_notGrantedReverts() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OilskinAccount.NotGranted.selector, keeper, address(usdc), IERC20.transfer.selector
            )
        );
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
    }

    function test_keeper_grantedWithinBudgetWorks() public {
        _grantTransfer(address(usdc), 100e6);
        vm.expectEmit(true, true, false, true);
        emit OilskinAccount.KeeperSpend(keeper, address(usdc), 60e6);
        vm.prank(keeper);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 60e6)));
        assertEq(usdc.balanceOf(keeper), 60e6);
        (uint256 limit, uint256 spent) =
            acct.tokenBudgetOf(keeper, address(usdc), IERC20.transfer.selector, address(usdc));
        assertEq(limit, 100e6);
        assertEq(spent, 60e6);
    }

    function test_keeper_budgetExceededReverts() public {
        _grantTransfer(address(usdc), 100e6);
        vm.startPrank(keeper);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 60e6)));
        vm.expectRevert(
            abi.encodeWithSelector(
                OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 41e6, 40e6
            )
        );
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 41e6)));
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 40e6)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(keeper), 100e6);
    }

    function test_keeper_periodResetsBudget() public {
        _grantTransfer(address(usdc), 100e6);
        vm.startPrank(keeper);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 100e6)));
        vm.expectRevert();
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
        vm.warp(block.timestamp + 1 days);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 100e6)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(keeper), 200e6);
    }

    function test_keeper_expiryAndRevoke() public {
        _grantTransfer(address(usdc), 100e6);
        vm.warp(block.timestamp + 30 days);
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));

        vm.warp(block.timestamp - 30 days);
        vm.prank(alice);
        acct.revoke(keeper, address(usdc), IERC20.transfer.selector);
        (bool active,,,,,) = acct.grantOf(keeper, address(usdc), IERC20.transfer.selector);
        assertFalse(active);
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
    }

    function test_keeper_revokeAllKillsEveryGrant() public {
        _grantTransfer(address(usdc), 100e6);
        _grantTransfer(address(weth), 1e18);
        vm.prank(alice);
        acct.revokeAll();
        assertEq(acct.grantEpoch(), 1);
        vm.startPrank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
        vm.expectRevert();
        acct.execAsKeeper(_one(_transfer(address(weth), keeper, 1)));
        vm.stopPrank();
        // A grant issued after the bump works again.
        _grantTransfer(address(usdc), 100e6);
        vm.prank(keeper);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
    }

    function test_keeper_regrantResetsSpendAndTokens() public {
        _grantTransfer(address(usdc), 100e6);
        vm.prank(keeper);
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 100e6)));
        // re-grant with weth budget only: usdc no longer budgeted
        vm.prank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.transfer.selector, address(weth), 1e18, 0));
        address[] memory toks = acct.grantTokens(keeper, address(usdc), IERC20.transfer.selector);
        assertEq(toks.length, 1);
        assertEq(toks[0], address(weth));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenNotBudgeted.selector, address(usdc))
        );
        acct.execAsKeeper(_one(_transfer(address(usdc), keeper, 1)));
    }

    function test_keeper_unbudgetedTokenCannotMove() public {
        // Grant transfer on WETH with a USDC budget: WETH itself is not budgeted.
        vm.prank(alice);
        acct.grant(keeper, _perm(address(weth), IERC20.transfer.selector, address(usdc), 1e6, 0));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenNotBudgeted.selector, address(weth))
        );
        acct.execAsKeeper(_one(_transfer(address(weth), keeper, 1)));
    }

    function test_keeper_valueBudget() public {
        EthSink sink = new EthSink();
        vm.prank(alice);
        acct.grant(keeper, _perm(address(sink), bytes4(0), address(0), 0, 1 ether));
        Call[] memory c = new Call[](1);
        c[0] = Call({target: address(sink), value: 0.6 ether, data: ""});
        vm.startPrank(keeper);
        acct.execAsKeeper(c);
        c[0].value = 0.5 ether;
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.ValueBudgetExceeded.selector, 0.5 ether, 0.4 ether)
        );
        acct.execAsKeeper(c);
        c[0].value = 0.4 ether;
        acct.execAsKeeper(c);
        vm.stopPrank();
        assertEq(sink.received(), 1 ether);
    }

    function test_keeper_allTokenOpSelectorsCounted() public {
        vm.startPrank(alice);
        acct.grant(keeper, _perm(address(usdc), IERC20.approve.selector, address(usdc), 10e6, 0));
        acct.grant(
            keeper,
            _perm(address(usdc), bytes4(keccak256("increaseAllowance(address,uint256)")), address(usdc), 10e6, 0)
        );
        acct.grant(keeper, _perm(address(usdc), IERC20.transferFrom.selector, address(usdc), 10e6, 0));
        acct.grant(
            keeper,
            _perm(address(permit2), bytes4(keccak256("approve(address,address,uint160,uint48)")), address(usdc), 10e6, 0)
        );
        acct.grant(
            keeper,
            _perm(address(permit2), bytes4(keccak256("transferFrom(address,address,uint160,address)")), address(usdc), 10e6, 0)
        );
        vm.stopPrank();

        vm.startPrank(keeper);
        // approve within budget then over
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.approve, (bob, 10e6)))));
        vm.expectRevert();
        acct.execAsKeeper(_one(_call(address(usdc), abi.encodeCall(IERC20.approve, (bob, 1)))));
        // increaseAllowance over budget
        vm.expectRevert();
        acct.execAsKeeper(
            _one(_call(address(usdc), abi.encodeWithSignature("increaseAllowance(address,uint256)", bob, 11e6)))
        );
        // transferFrom over budget
        vm.expectRevert();
        acct.execAsKeeper(
            _one(_call(address(usdc), abi.encodeCall(IERC20.transferFrom, (address(acct), bob, 11e6))))
        );
        // permit2 approve over budget
        vm.expectRevert();
        acct.execAsKeeper(
            _one(
                _call(
                    address(permit2),
                    abi.encodeWithSignature(
                        "approve(address,address,uint160,uint48)", address(usdc), bob, uint160(11e6), uint48(block.timestamp + 1)
                    )
                )
            )
        );
        // permit2 approve within budget works and is counted
        acct.execAsKeeper(
            _one(
                _call(
                    address(permit2),
                    abi.encodeWithSignature(
                        "approve(address,address,uint160,uint48)", address(usdc), bob, uint160(10e6), uint48(block.timestamp + 1)
                    )
                )
            )
        );
        // permit2 transferFrom over budget
        vm.expectRevert();
        acct.execAsKeeper(
            _one(
                _call(
                    address(permit2),
                    abi.encodeWithSignature(
                        "transferFrom(address,address,uint160,address)", address(acct), bob, uint160(11e6), address(usdc)
                    )
                )
            )
        );
        vm.stopPrank();
    }

    function test_keeper_innerTokenOpsThroughPeripheralAreCounted() public {
        // Grant the relay's run() as a keeper root with a 50 USDC budget; the relay then asks the
        // account to transfer 60 → must revert on the INNER op.
        vm.prank(alice);
        acct.grant(keeper, _perm(address(relay), RelayPeripheral.run.selector, address(usdc), 50e6, 0));
        Call[] memory inner = _one(_transfer(address(usdc), keeper, 60e6));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 60e6, 50e6)
        );
        acct.execAsKeeper(_one(_call(address(relay), abi.encodeCall(RelayPeripheral.run, (inner)))));

        inner = _one(_transfer(address(usdc), keeper, 50e6));
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(relay), abi.encodeCall(RelayPeripheral.run, (inner)))));
        assertEq(usdc.balanceOf(keeper), 50e6);
        // Any further inner op in this period fails.
        inner = _one(_transfer(address(usdc), keeper, 1));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_call(address(relay), abi.encodeCall(RelayPeripheral.run, (inner)))));
    }

    function test_keeper_nestedPeripheralOpsAreCounted() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(relay), RelayPeripheral.runNested.selector, address(weth), 1e18, 0));
        Call[] memory deep = _one(_transfer(address(weth), keeper, 2e18));
        bytes memory nested = abi.encodeCall(RelayPeripheral.run, (deep));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(weth), 2e18, 1e18)
        );
        acct.execAsKeeper(
            _one(_call(address(relay), abi.encodeCall(RelayPeripheral.runNested, (address(relay2), 0, nested))))
        );
    }

    function test_keeper_innerValueCountedAgainstRootValueBudget() public {
        EthSink sink = new EthSink();
        vm.prank(alice);
        acct.grant(keeper, _perm(address(relay), RelayPeripheral.run.selector, address(0), 0, 1 ether));
        Call[] memory inner = new Call[](1);
        inner[0] = Call({target: address(sink), value: 2 ether, data: ""});
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(OilskinAccount.ValueBudgetExceeded.selector, 2 ether, 1 ether)
        );
        acct.execAsKeeper(_one(_call(address(relay), abi.encodeCall(RelayPeripheral.run, (inner)))));
    }

    function test_keeper_cannotUsePeripheralDoorsDirectly() public {
        _grantTransfer(address(usdc), 100e6);
        vm.startPrank(keeper);
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.execFromPeripheral(_one(_transfer(address(usdc), keeper, 1)));
        vm.expectRevert(OilskinAccount.NotActivePeripheral.selector);
        acct.execNestedPeripheral(address(relay), 0, "");
        vm.stopPrank();
    }

    function test_keeper_malformedTokenCalldataFailsClosed() public {
        _grantTransfer(address(usdc), 100e6);
        // transfer selector with truncated arguments: abi.decode reverts → nothing executes.
        Call[] memory c = _one(_call(address(usdc), abi.encodePacked(IERC20.transfer.selector, bob)));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(c);
    }

    function test_keeper_batchChargesEachRootSeparately() public {
        _grantTransfer(address(usdc), 100e6);
        _grantTransfer(address(weth), 1e18);
        Call[] memory calls = new Call[](2);
        calls[0] = _transfer(address(usdc), keeper, 100e6);
        calls[1] = _transfer(address(weth), keeper, 1e18);
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(keeper), 100e6);
        assertEq(weth.balanceOf(keeper), 1e18);
    }

    // ------------------------------------------------------------ B20 / rebase

    function test_b20_transfersAreByAmountNeverByCachedBalance() public {
        MockB20 zec = new MockB20();
        zec.mint(address(acct), 100e8);
        vm.prank(alice);
        acct.exec(address(zec), 0, abi.encodeCall(IERC20.transfer, (bob, 10e8)));
        zec.setMultiplier(2e18); // issuer rebases 2×
        assertEq(zec.balanceOf(address(acct)), 180e8);
        assertEq(zec.balanceOf(bob), 20e8);
        vm.prank(alice);
        acct.exec(address(zec), 0, abi.encodeCall(IERC20.transfer, (bob, 180e8)));
        assertEq(zec.balanceOf(address(acct)), 0);
        assertEq(zec.balanceOf(bob), 200e8);
    }

    function test_b20_keeperBudgetIsCalldataNotBalance() public {
        MockB20 zec = new MockB20();
        zec.mint(address(acct), 100e8);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(zec), IERC20.transfer.selector, address(zec), 50e8, 0));
        zec.setMultiplier(5e17); // balance halves to 50; budget is still 50 in amount terms
        vm.prank(keeper);
        acct.execAsKeeper(_one(_transfer(address(zec), keeper, 50e8)));
        assertEq(zec.balanceOf(keeper), 50e8);
        assertEq(zec.balanceOf(address(acct)), 0);
    }

    function test_b20_blockedTransferFailsClosed() public {
        MockB20 zec = new MockB20();
        zec.mint(address(acct), 100e8);
        zec.setBlocked(bob, true);
        Call[] memory calls = new Call[](2);
        calls[0] = _transfer(address(usdc), bob, 1e6);
        calls[1] = _transfer(address(zec), bob, 1e8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockB20.Blocked.selector, bob));
        acct.execBatch(calls);
        assertEq(usdc.balanceOf(bob), 0, "batch must be atomic");
        assertEq(zec.balanceOf(address(acct)), 100e8);
    }

    // ------------------------------------------------------------------ fuzz

    /// Keeper spend over a random sequence never exceeds the budget within a period, and the
    /// account's outflow to the keeper equals the recorded spend exactly.
    function testFuzz_keeperNeverExceedsBudget(uint256 limit, uint256[8] memory amounts) public {
        limit = bound(limit, 1, 500_000e6);
        _grantTransfer(address(usdc), limit);
        uint256 spent;
        for (uint256 i = 0; i < 8; i++) {
            uint256 a = bound(amounts[i], 0, limit);
            vm.prank(keeper);
            if (spent + a > limit) {
                vm.expectRevert();
                acct.execAsKeeper(_one(_transfer(address(usdc), keeper, a)));
            } else {
                acct.execAsKeeper(_one(_transfer(address(usdc), keeper, a)));
                spent += a;
            }
        }
        assertEq(usdc.balanceOf(keeper), spent);
        (, uint256 recorded) =
            acct.tokenBudgetOf(keeper, address(usdc), IERC20.transfer.selector, address(usdc));
        assertEq(recorded, spent);
        assertLe(spent, limit);
    }

    /// The owner can always move any amount it holds, whatever grants exist.
    function testFuzz_ownerAlwaysExits(uint256 amount) public {
        amount = bound(amount, 0, usdc.balanceOf(address(acct)));
        _grantTransfer(address(usdc), 1);
        vm.prank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, amount)));
        assertEq(usdc.balanceOf(alice), amount);
    }
}
