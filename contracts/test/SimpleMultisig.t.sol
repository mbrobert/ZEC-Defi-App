// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SimpleMultisig} from "../src/testing/SimpleMultisig.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {LpParams} from "../src/interfaces/ILPAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Interim-multisig tests, including driving the REAL admin surface
///         (PositionVault owned by the multisig) — the pattern testnet
///         deployments use until the production Safe is configured.
contract SimpleMultisigTest is Test {
    SimpleMultisig safe;
    PositionVault vault;

    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");

    function setUp() public {
        address[] memory owners = new address[](3);
        (owners[0], owners[1], owners[2]) = (s1, s2, s3);
        safe = new SimpleMultisig(owners, 2); // 2-of-3
        vault = new PositionVault(address(safe));
    }

    function _adminCall(bytes memory data) internal returns (uint256 txId) {
        vm.prank(s1);
        txId = safe.submit(address(vault), 0, data);
    }

    function test_2of3_executesVaultAdmin() public {
        uint256 txId =
            _adminCall(abi.encodeCall(PositionVault.setOperator, (operator, true)));

        // 1 confirmation (proposer) — not enough.
        vm.prank(s1);
        vm.expectRevert(
            abi.encodeWithSelector(SimpleMultisig.ThresholdNotMet.selector, 1, 2)
        );
        safe.execute(txId);
        assertFalse(vault.operators(operator));

        // Second signature → executable.
        vm.prank(s2);
        safe.confirm(txId);
        vm.prank(s2);
        safe.execute(txId);
        assertTrue(vault.operators(operator));
    }

    function test_nonOwnerCannotSubmitConfirmExecute() public {
        vm.startPrank(stranger);
        vm.expectRevert(SimpleMultisig.NotOwner.selector);
        safe.submit(address(vault), 0, "");
        vm.expectRevert(SimpleMultisig.NotOwner.selector);
        safe.confirm(0);
        vm.stopPrank();
    }

    function test_doubleConfirmAndDoubleExecuteRevert() public {
        uint256 txId = _adminCall(abi.encodeCall(PositionVault.pause, ()));
        vm.prank(s1);
        vm.expectRevert(SimpleMultisig.AlreadyConfirmed.selector);
        safe.confirm(txId);

        vm.prank(s2);
        safe.confirm(txId);
        vm.prank(s3);
        safe.execute(txId);
        assertTrue(vault.paused());

        vm.prank(s3);
        vm.expectRevert(SimpleMultisig.AlreadyExecuted.selector);
        safe.execute(txId);
    }

    function test_failedInnerCallReverts() public {
        // setOperator called by non-owner target path: encode a call the vault
        // will revert (unpause while not paused).
        uint256 txId = _adminCall(abi.encodeCall(PositionVault.unpause, ()));
        vm.prank(s2);
        safe.confirm(txId);
        vm.prank(s1);
        vm.expectRevert(SimpleMultisig.ExecutionFailed.selector);
        safe.execute(txId);
    }

    function test_badThresholdRejected() public {
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (s1, s2);
        vm.expectRevert(SimpleMultisig.BadThreshold.selector);
        new SimpleMultisig(owners, 3);
        vm.expectRevert(SimpleMultisig.BadThreshold.selector);
        new SimpleMultisig(owners, 0);
    }
}

/// @notice New safety-guard tests (audit items A2 / A14).
contract GuardTest is Test {
    PositionVault vault;
    MockERC20 usdc;
    address admin = makeAddr("admin");

    function setUp() public {
        vault = new PositionVault(admin);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.startPrank(admin);
        vault.setOperator(admin, true);
        vault.setAdapterAllowed(address(0xA1), true);
        vault.setTokenAllowed(address(usdc), true);
        vm.stopPrank();
        usdc.mint(address(vault), 10e6);
    }

    function _open(LpParams memory p) internal {
        vault.openFor(
            admin, address(0xA1), bytes32("p"), address(usdc), 1e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_rejectsOutOfBoundsLpParams() public {
        vm.startPrank(admin);
        vm.expectRevert(PositionVault.InvalidLpParams.selector);
        _open(LpParams({rangeWidthBps: 5, rebalanceDelay: 1 hours, autoCompound: true}));
        vm.expectRevert(PositionVault.InvalidLpParams.selector);
        _open(LpParams({rangeWidthBps: 5001, rebalanceDelay: 1 hours, autoCompound: true}));
        vm.expectRevert(PositionVault.InvalidLpParams.selector);
        _open(LpParams({rangeWidthBps: 800, rebalanceDelay: 31 days, autoCompound: true}));
        vm.stopPrank();
    }
}
