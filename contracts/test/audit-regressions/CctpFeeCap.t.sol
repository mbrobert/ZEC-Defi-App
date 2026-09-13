// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {Call} from "../../src/interfaces/IOilskinAccount.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {CctpMessageV2} from "../mocks/MockCctpV2.sol";

/// @notice AUDIT-2026-09-13 S-2 — `closeLpAndBurn` required only that Circle's fee be BELOW the amount burned.
///         A caller could therefore authorise a fee of the whole burn less one unit: the keeper stays inside
///         the USDC budget its grant allows, the burn is a real burn, and the user receives almost nothing on
///         the other chain. The fee a burn may authorise is now capped at `MAX_CCTP_FEE_BPS` of it (1 %),
///         against Circle's own Fast Transfer minimum of 1.3 basis points on this route.
contract CctpFeeCapRegressionTest is Fixture {
    bytes32 constant SOLANA_USDC_ATA = 0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 constant HELD = 10_000e6;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(acct), HELD);
        _ownerExecPlain(address(router), abi.encodeCall(StrategyRouter.setSolanaRecipient, (SOLANA_USDC_ATA)));
    }

    function _burn(uint256 amount, uint256 maxFee) internal view returns (StrategyRouter.BurnParams memory b) {
        b.positionIds = new uint256[](0);
        b.band = _band(poolWethUsdc, 1000);
        b.swap = StrategyRouter.SwapQuote({quotedIn: 0, quotedOut: 0, maxSlippageBps: 100, routeData: ""});
        b.burnAmount = amount;
        b.maxFee = maxFee;
        b.minFinalityThreshold = 1000;
        b.deadline = block.timestamp + 10 minutes;
    }

    function test_S2_aFeeOfNearlyTheWholeBurnIsRefusedByName() public {
        uint256 amount = 1_000e6;
        uint256 cap = (amount * router.MAX_CCTP_FEE_BPS()) / 10_000;
        assertEq(cap, 10e6, "1 % of 1,000 USDC");

        // The old rule: any fee strictly below the amount was accepted.
        StrategyRouter.BurnParams memory greedy = _burn(amount, amount - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.MaxFeeTooLarge.selector, amount - 1, cap));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (greedy)));

        // One unit over the cap is refused too — the boundary is the cap, not a rounding of it.
        StrategyRouter.BurnParams memory justOver = _burn(amount, cap + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.MaxFeeTooLarge.selector, cap + 1, cap));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (justOver)));

        assertEq(usdc.balanceOf(address(acct)), HELD, "nothing was burned by either attempt");
        assertEq(cctpMessenger.burnCount(), 0);
    }

    function test_S2_theCapItselfAndCirclesOwnFeeBothPass_andTheMessageCarriesTheBoundedFee() public {
        uint256 amount = 1_000e6;
        uint256 cap = (amount * router.MAX_CCTP_FEE_BPS()) / 10_000;
        // Exactly the cap is allowed: the rule is "no more than", not "less than".
        StrategyRouter.BurnParams memory atCap = _burn(amount, cap);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (atCap)));
        (, uint256 burned) = abi.decode(ret, (uint256, uint256));
        assertEq(burned, amount);
        (, CctpMessageV2.BurnBody memory body) = CctpMessageV2.decode(cctpTransmitter.lastMessage());
        assertEq(body.maxFee, cap, "the bound reaches Circle as the message's own maxFee");

        // And Circle's real fee on this route — 1.3 basis points — is far inside it.
        uint256 circlesOwn = (amount * 13) / 100_000;
        assertLt(circlesOwn, cap);
        StrategyRouter.BurnParams memory realistic = _burn(amount, circlesOwn);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (realistic)));
        assertEq(cctpMessenger.burnCount(), 2);
    }

    function test_S2_theKeeperCannotUseItsBudgetToHandTheFeeRecipientTheWholeBurn() public {
        // The grant bounds the AMOUNT; before the cap it did not bound the split between the user and Circle.
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.closeLpAndBurn.selector, _limits1(address(usdc), 6_000e6), 0));
        StrategyRouter.BurnParams memory greedy = _burn(5_000e6, 5_000e6 - 1);
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (greedy))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(address(acct)), HELD);
        assertEq(cctpMessenger.burnCount(), 0);
    }
}
