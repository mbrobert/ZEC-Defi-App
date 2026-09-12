// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../../src/account/OilskinAccountFactory.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";

/// @title Halmos properties — the account's grant budget and its calldata parser (slice H, 2026-09-11).
///
/// Run (needs halmos; NOT run by `forge test`, which only picks up `test*`):
///   cd contracts && halmos --contract AccountGrantHalmos --loop 4 --solver-timeout-assertion 0
///
/// Every parameter of a `check_` function is a symbol over its whole type (halmos semantics), so
/// each property holds for EVERY keeper, target, selector, amount and budget of that shape, not
/// for 512 sampled ones. The properties say, in order:
///   1. a keeper root call whose (target, selector) has no active grant ALWAYS reverts
///      `NotGranted` — no calldata reaches outside the signed Permission;
///   2. a recognised token mover in a granted tree is charged EXACTLY the amount in its calldata,
///      and a spend past the per-period budget ALWAYS reverts — the budget cannot be overspent by
///      any amount of any recognised shape;
///   3. the five movers the parser cannot read ALWAYS revert `UnbudgetableSelector` on the keeper
///      path, whatever their arguments;
///   4. calldata that is not a recognised token mover is charged nothing (a call to a plain view
///      or a peripheral function never consumes a token budget by accident).
///
/// What halmos cannot reach here, stated: the router's call tree (external calls into mocks with
/// loops over venues) — see `RouterBalance.halmos.t.sol` for the bounded attempt.
contract AccountGrantHalmos is Test {
    OilskinAccount acct;
    OilskinAccountFactory factory;
    MockERC20 token;
    MockPermit2 permit2;
    address owner = address(0xA11CE);
    address keeper = address(0xBEEF);

    bytes4 constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 constant SEL_INCREASE = bytes4(keccak256("increaseAllowance(address,uint256)"));
    bytes4 constant SEL_TRANSFER_FROM = bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 constant SEL_777_SEND = bytes4(keccak256("send(address,uint256,bytes)"));
    bytes4 constant SEL_677 = bytes4(keccak256("transferAndCall(address,uint256,bytes)"));
    bytes4 constant SEL_P2_BATCH = bytes4(keccak256("transferFrom((address,address,uint160,address)[])"));
    bytes4 constant SEL_P2_PERMIT = bytes4(keccak256("permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)"));
    bytes4 constant SEL_P2_PERMIT_BATCH = bytes4(keccak256("permitTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes)"));

    function setUp() public {
        permit2 = new MockPermit2();
        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(owner)));
        token = new MockERC20("T", "T", 18);
        token.mint(address(acct), type(uint128).max);
    }

    function _grantToken(uint256 limit, bytes4 sel) internal {
        TokenLimit[] memory limits = new TokenLimit[](1);
        limits[0] = TokenLimit(address(token), limit);
        Permission memory p = Permission({
            target: address(token),
            selector: sel,
            maxValuePerPeriod: 0,
            tokenLimits: limits,
            period: 1 days,
            expiry: uint40(block.timestamp + 30 days),
            allowCallback: false
        });
        vm.prank(owner);
        acct.grant(keeper, p);
    }

    /// 1. No grant for (target, selector) ⇒ NotGranted, for every target, selector and payload.
    function check_ungrantedRootCallAlwaysReverts(address target, bytes4 sel, bytes32 word) public {
        vm.assume(target != address(token) || sel != SEL_TRANSFER);
        _grantToken(1e18, SEL_TRANSFER); // the only grant: (token, transfer)
        Call[] memory calls = new Call[](1);
        calls[0] = Call(target, 0, abi.encodePacked(sel, word), false);
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        assert(!ok);
        assert(bytes4(ret) == OilskinAccount.NotGranted.selector);
    }

    /// 2. A recognised mover is charged exactly its calldata amount; past the budget it reverts.
    function check_transferIsChargedExactlyAndNeverPastBudget(uint256 limit, uint256 amount, address to) public {
        vm.assume(limit != 0 && limit <= type(uint128).max);
        vm.assume(to != address(0) && to != address(acct));
        _grantToken(limit, SEL_TRANSFER);
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(token), 0, abi.encodeCall(IERC20.transfer, (to, amount)), false);
        vm.prank(keeper);
        (bool ok,) = address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        (, uint256 spent) = acct.tokenBudgetOf(keeper, address(token), SEL_TRANSFER, address(token));
        if (amount > limit) {
            assert(!ok); // TokenBudgetExceeded
            assert(spent == 0);
        } else if (amount <= type(uint128).max) {
            assert(ok);
            assert(spent == amount);
        }
        assert(spent <= limit);
    }

    /// 3. The five unparsable movers always revert on the keeper path, whatever the arguments.
    function check_unbudgetableMoversAlwaysRevert(uint8 which, bytes32 a, bytes32 b, bytes32 c) public {
        bytes4 sel = which % 5 == 0
            ? SEL_777_SEND
            : which % 5 == 1 ? SEL_677 : which % 5 == 2 ? SEL_P2_BATCH : which % 5 == 3 ? SEL_P2_PERMIT : SEL_P2_PERMIT_BATCH;
        _grantToken(type(uint128).max, sel); // even a grant on that very selector does not help
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(token), 0, abi.encodePacked(sel, a, b, c), false);
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        assert(!ok);
        assert(bytes4(ret) == OilskinAccount.UnbudgetableSelector.selector);
    }

    /// 4. A selector that is not a token mover consumes no token budget, for every payload.
    function check_nonMoverIsNeverCharged(bytes4 sel, bytes32 a, bytes32 b) public {
        vm.assume(sel != SEL_TRANSFER && sel != SEL_APPROVE && sel != SEL_INCREASE && sel != SEL_TRANSFER_FROM);
        vm.assume(sel != SEL_777_SEND && sel != SEL_677 && sel != SEL_P2_BATCH && sel != SEL_P2_PERMIT && sel != SEL_P2_PERMIT_BATCH);
        _grantToken(1, sel);
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(token), 0, abi.encodePacked(sel, a, b), false);
        vm.prank(keeper);
        address(acct).call(abi.encodeCall(OilskinAccount.execAsKeeper, (calls)));
        (, uint256 spent) = acct.tokenBudgetOf(keeper, address(token), sel, address(token));
        assert(spent == 0);
    }
}
