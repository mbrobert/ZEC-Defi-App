// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ILpVenue, LpOpenParams} from "../../src/interfaces/ILpVenue.sol";
import {ISlipstreamNpm} from "../../src/interfaces/ISlipstream.sol";
import {SlipstreamLpVenue} from "../../src/venues/SlipstreamLpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";

/// @notice Audit wave 3, W3-MED-2 (`docs/AUDIT-2026-09-11.md`): anyone could make the direct venue's
///         `positionsOf` revert for an account by sending it Slipstream NFTs. ERC-721 transfers are
///         permissionless, `positionsOf` counted `NPM.balanceOf(account)` — every Slipstream token
///         the account holds, any pool — against `MAX_ENUMERATION` BEFORE filtering by pool, and
///         reverted `TooManyPositions`. The keeper reads `positionsOf` before every protective
///         dispatch and fails closed on a revert, so 512 dust tokens (a few dollars of Base gas)
///         switched the keeper's protection off for that account; the dashboard showed "positions
///         unreadable". The engine venue has no such door: engine ids are minted to the depositor.
///
///         Fixed: the gauge's staked list — the account's own deposits, which nobody else can
///         pad — is always returned in full; unstaked tokens are scanned through a window of
///         `MAX_ENUMERATION` and filtered by pool; `unstakedOverflow(account)` says how many tokens
///         the window did not reach, and the keeper and the dashboard name it instead of failing.
contract DirectVenueEnumerationTest is Fixture {
    address griefer = makeAddr("griefer");

    function _open(uint256 a0) internal returns (uint256 id) {
        usdc.mint(address(acct), a0);
        bytes memory ret = _ownerExec(
            address(directVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_ID_DIRECT, a0, 0, poolCbzecUsdc)))
        );
        id = abi.decode(ret, (uint256));
    }

    /// The griefer mints dust positions in the pool and transfers them to the account.
    function _pad(uint256 n) internal {
        usdc.mint(griefer, n * 2e6);
        cbzec.mint(griefer, n * 1e6);
        vm.startPrank(griefer);
        usdc.approve(address(npmCbzec), type(uint256).max);
        cbzec.approve(address(npmCbzec), type(uint256).max);
        for (uint256 i = 0; i < n; i++) {
            (uint256 id,,,) = npmCbzec.mint(
                ISlipstreamNpm.MintParams({
                    token0: address(usdc),
                    token1: address(cbzec),
                    tickSpacing: 200,
                    tickLower: -24_000,
                    tickUpper: -22_800,
                    amount0Desired: 2e6,
                    amount1Desired: 1e6,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: griefer,
                    deadline: block.timestamp + 1,
                    sqrtPriceX96: 0
                })
            );
            npmCbzec.transferFrom(griefer, address(acct), id);
        }
        vm.stopPrank();
    }

    /// The account's own staked position stays visible however many tokens a stranger sends it;
    /// the router's protective unwind still closes it; the overflow is named, not hidden.
    function test_W3_MED_2_aStrangersNftsCannotHideTheAccountsStakedPosition() public {
        uint256 mine = _open(10_000e6);
        assertTrue(gaugeCbzec.stakedContains(address(acct), mine));
        _pad(directVenue.MAX_ENUMERATION() + 5);
        assertEq(npmCbzec.balanceOf(address(acct)), directVenue.MAX_ENUMERATION() + 5, "padded past the window");

        uint256[] memory ids = directVenue.positionsOf(address(acct));
        assertGt(ids.length, 0, "positionsOf answers");
        assertEq(ids[0], mine, "the staked position leads the list");
        assertEq(ids.length, 1 + directVenue.MAX_ENUMERATION(), "the staked id plus the unstaked window");
        (uint256 held, uint256 scanned) = directVenue.unstakedOverflow(address(acct));
        assertEq(held, directVenue.MAX_ENUMERATION() + 5);
        assertEq(scanned, directVenue.MAX_ENUMERATION());

        // The keeper's protective close of the staked id goes through as before.
        uint256[] memory one = new uint256[](1);
        one[0] = mine;
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.closeMany, (one, _band(poolCbzecUsdc, 1000))));
        (uint256 out0,,, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 0);
        assertGt(out0, 0);
        assertFalse(gaugeCbzec.stakedContains(address(acct), mine));
    }

    /// Without a stranger's tokens nothing changes: no overflow, the whole list.
    function test_W3_MED_2_noOverflowWithoutPadding() public {
        uint256 mine = _open(10_000e6);
        _pad(3);
        uint256[] memory ids = directVenue.positionsOf(address(acct));
        assertEq(ids.length, 4);
        assertEq(ids[0], mine);
        (uint256 held, uint256 scanned) = directVenue.unstakedOverflow(address(acct));
        assertEq(held, 3);
        assertEq(scanned, 3);
    }

    /// The account's OWN staked list is the one bound that still refuses: it cannot be padded by a
    /// third party (the gauge stakes for `msg.sender`), so exceeding it is the account's own doing.
    function test_W3_MED_2_theAccountsOwnStakedListStillHasACap() public {
        uint256 cap = directVenue.MAX_ENUMERATION();
        // Pretend the gauge lists cap + 1 staked ids for the account.
        uint256[] memory many = new uint256[](cap + 1);
        for (uint256 i = 0; i < many.length; i++) {
            many[i] = i + 1;
        }
        vm.mockCall(address(gaugeCbzec), abi.encodeCall(gaugeCbzec.stakedValues, (address(acct))), abi.encode(many));
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.TooManyPositions.selector, cap));
        directVenue.positionsOf(address(acct));
    }
}
