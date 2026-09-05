// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {IOilskinAccount} from "../interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IPermit2} from "../interfaces/IPermit2.sol";
import {CollateralRegistry} from "../registry/CollateralRegistry.sol";

/// @title StrategyRouter — stateless "supply → borrow → (swap) → LP" and its mirror, executed BY the
///        caller's OilskinAccount.
///
/// @notice The account calls the router (`account.exec(router, openLeveragedLp(...))`, or the factory's
///         `createAccountAndExec` for a first-time user); the router then instructs the account
///         through the venues, so every position is the account's and the router is never a holder
///         of anything: `balanceOf(router) == 0` before, during and after every call. It has no
///         storage, no owner, no fee. Every hop carries a deadline and a floor: Permit2 deadline,
///         the pool price band on the LP deposit/close, minOut on each swap, and the registry's
///         entry health-factor floor after the borrow. The LP pool must contain USDC in v1 (the
///         engine's single-sided deposit swaps to ratio internally, so no swap is needed on open);
///         a non-USDC pool token is swapped back to USDC on unwind.
contract StrategyRouter is Peripheral {
    CollateralRegistry public immutable REGISTRY;
    ILpVenue public immutable LP_VENUE;
    ISwapAdapter public immutable SWAP;
    IPermit2 public immutable PERMIT2;
    /// @notice The debt asset (USDC on Base).
    address public immutable USDC;

    struct Permit2Pull {
        uint256 nonce;
        uint256 deadline;
        /// @dev Empty = no pull: the account already holds `collateralAmount`.
        bytes signature;
    }

    struct OpenParams {
        address collateralAsset;
        /// @dev 0 = borrow against collateral already supplied by this account.
        uint256 collateralAmount;
        Permit2Pull permit;
        /// @dev USDC to borrow and deploy. Must be > 0.
        uint256 borrowAmount;
        bytes32 poolId;
        uint24 rangeWidthBps;
        uint64 rebalanceDelay;
        bool autoCompound;
        PriceBand band;
        uint256 deadline;
    }

    struct UnwindParams {
        address collateralAsset;
        /// @dev LP ids to close (all in one pool). May be empty (repay / withdraw only).
        uint256[] positionIds;
        PriceBand band;
        /// @dev minOut for swapping the non-USDC pool token proceeds to USDC (adapter route data).
        uint256 swapMinOut;
        bytes swapRouteData;
        /// @dev USDC to repay. type(uint256).max = everything the account holds up to its debt. 0 = none.
        uint256 repayAmount;
        /// @dev Collateral to withdraw to the account. type(uint256).max = all. 0 = none.
        uint256 withdrawAmount;
        uint256 deadline;
    }

    event LeveragedLpOpened(
        address indexed account,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 borrowed,
        bytes32 indexed poolId,
        uint256 positionId,
        uint256 healthFactor
    );
    event LeveragedLpUnwound(
        address indexed account,
        address indexed collateralAsset,
        uint256 closedCount,
        uint256 failedCount,
        uint256 usdcFromLp,
        uint256 repaid,
        uint256 withdrawn,
        uint256 healthFactor
    );
    event Swept(address indexed account, address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error Expired(uint256 deadline);
    error AssetNotRegistered(address asset);
    error AssetDisabled(address asset, string note);
    error VenueDisabled(address venue);
    error ZeroBorrow();
    error PoolWithoutUsdc(bytes32 poolId);
    error EntryHfTooLow(uint256 healthFactor, uint256 floor);
    error ExitHfTooLow(uint256 healthFactor, uint256 floor);
    error RouterHoldsBalance(address token, uint256 amount);

    constructor(
        CollateralRegistry registry,
        ILpVenue lpVenue,
        ISwapAdapter swapAdapter,
        IPermit2 permit2,
        address usdc
    ) {
        if (
            address(registry) == address(0) || address(lpVenue) == address(0)
                || address(swapAdapter) == address(0) || address(permit2) == address(0)
                || usdc == address(0)
        ) revert ZeroAddress();
        REGISTRY = registry;
        LP_VENUE = lpVenue;
        SWAP = swapAdapter;
        PERMIT2 = permit2;
        USDC = usdc;
    }

    // ------------------------------------------------------------------ open

    /// @notice Permit2 pull → venue.supply → venue.borrow(USDC) → lpVenue.open, all as the account.
    /// @dev Invariant: the asset is enabled in the registry and its venue is enabled; after the borrow
    ///      the account's health factor is ≥ the registry's entry floor (else revert); the LP id is
    ///      minted to the account; the router's own balance of every token involved is unchanged (0).
    function openLeveragedLp(OpenParams calldata p)
        external
        returns (uint256 positionId, uint256 healthFactor)
    {
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        if (p.borrowAmount == 0) revert ZeroBorrow();
        ICollateralVenue venue = _venueFor(p.collateralAsset, true);
        (address t0, address t1,) = LP_VENUE.poolTokens(p.poolId);
        if (t0 != USDC && t1 != USDC) revert PoolWithoutUsdc(p.poolId);

        address account = msg.sender;
        if (p.collateralAmount != 0) {
            if (p.permit.signature.length != 0) _pull(account, p);
            _nested(address(venue), abi.encodeCall(ICollateralVenue.supply, (p.collateralAsset, p.collateralAmount)));
        }
        _nested(address(venue), abi.encodeCall(ICollateralVenue.borrow, (USDC, p.borrowAmount)));

        healthFactor = venue.healthFactor(account);
        uint256 floor = REGISTRY.entryHfFloorWad();
        if (healthFactor < floor) revert EntryHfTooLow(healthFactor, floor);

        LpOpenParams memory lp = LpOpenParams({
            poolId: p.poolId,
            amount0: t0 == USDC ? p.borrowAmount : 0,
            amount1: t1 == USDC ? p.borrowAmount : 0,
            rangeWidthBps: p.rangeWidthBps,
            rebalanceDelay: p.rebalanceDelay,
            autoCompound: p.autoCompound,
            band: p.band,
            deadline: p.deadline
        });
        positionId = abi.decode(_nested(address(LP_VENUE), abi.encodeCall(ILpVenue.open, (lp))), (uint256));

        _assertHoldsNothing(p.collateralAsset);
        _assertHoldsNothing(USDC);
        emit LeveragedLpOpened(
            account, p.collateralAsset, p.collateralAmount, p.borrowAmount, p.poolId, positionId, healthFactor
        );
    }

    // ---------------------------------------------------------------- unwind

    /// @notice The mirror: lpVenue.closeMany → swap non-USDC proceeds to USDC → venue.repay →
    ///         venue.withdraw, all as the account. Works for DISABLED assets (exits are never gated).
    /// @dev Invariant: an un-closable id is skipped, never blocking; a swap of a non-USDC leg requires
    ///      `swapMinOut > 0`; after a collateral withdraw with debt outstanding the health factor is
    ///      ≥ the entry floor; the router holds nothing afterwards.
    function unwind(UnwindParams calldata p)
        external
        returns (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn, uint256 healthFactor)
    {
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        ICollateralVenue venue = _venueFor(p.collateralAsset, false);
        address account = msg.sender;

        uint256 closed;
        uint256 failedCount;
        if (p.positionIds.length != 0) {
            (bytes32 poolId,) = LP_VENUE.poolOf(p.positionIds[0]);
            (address t0, address t1,) = LP_VENUE.poolTokens(poolId);
            (uint256 out0, uint256 out1,, uint256[] memory failed) = abi.decode(
                _nested(address(LP_VENUE), abi.encodeCall(ILpVenue.closeMany, (p.positionIds, p.band))),
                (uint256, uint256, uint256, uint256[])
            );
            failedCount = failed.length;
            closed = p.positionIds.length - failedCount;
            usdcFromLp += _toUsdc(t0, out0, p);
            usdcFromLp += _toUsdc(t1, out1, p);
        }

        if (p.repayAmount != 0) {
            uint256 amount = p.repayAmount;
            if (amount == type(uint256).max) {
                uint256 owed = venue.debt(account, USDC);
                uint256 held = IERC20(USDC).balanceOf(account);
                amount = owed < held ? owed : held;
            }
            if (amount != 0) {
                repaid = abi.decode(
                    _nested(address(venue), abi.encodeCall(ICollateralVenue.repay, (USDC, amount))),
                    (uint256)
                );
            }
        }

        if (p.withdrawAmount != 0) {
            withdrawn = abi.decode(
                _nested(
                    address(venue),
                    abi.encodeCall(ICollateralVenue.withdraw, (p.collateralAsset, p.withdrawAmount))
                ),
                (uint256)
            );
        }

        healthFactor = venue.healthFactor(account);
        if (p.withdrawAmount != 0 && venue.debt(account, USDC) != 0) {
            uint256 floor = REGISTRY.entryHfFloorWad();
            if (healthFactor < floor) revert ExitHfTooLow(healthFactor, floor);
        }

        _assertHoldsNothing(p.collateralAsset);
        _assertHoldsNothing(USDC);
        emit LeveragedLpUnwound(
            account, p.collateralAsset, closed, failedCount, usdcFromLp, repaid, withdrawn, healthFactor
        );
    }

    /// @notice Send the account's whole balance of each token to the account's OWNER (earnings to
    ///         the wallet). Only the account can invoke it, only its owner can receive.
    /// @dev Invariant: destination is `IOilskinAccount(msg.sender).owner()`, nothing else.
    function sweep(address[] calldata tokens) external {
        address account = msg.sender;
        address to = IOilskinAccount(account).owner();
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 amount = IERC20(tokens[i]).balanceOf(account);
            if (amount == 0) continue;
            _exec(tokens[i], abi.encodeCall(IERC20.transfer, (to, amount)));
            emit Swept(account, tokens[i], to, amount);
        }
    }

    // -------------------------------------------------------------- internal

    function _pull(address account, OpenParams calldata p) internal {
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: p.collateralAsset, amount: p.collateralAmount}),
            nonce: p.permit.nonce,
            deadline: p.permit.deadline
        });
        IPermit2.SignatureTransferDetails memory details =
            IPermit2.SignatureTransferDetails({to: account, requestedAmount: p.collateralAmount});
        address signer = IOilskinAccount(account).owner();
        _exec(
            address(PERMIT2),
            abi.encodeCall(IPermit2.permitTransferFrom, (permit, details, signer, p.permit.signature))
        );
    }

    function _toUsdc(address token, uint256 amount, UnwindParams calldata p)
        internal
        returns (uint256)
    {
        if (amount == 0) return 0;
        if (token == USDC) return amount;
        return abi.decode(
            _nested(
                address(SWAP),
                abi.encodeCall(
                    ISwapAdapter.swap,
                    (token, USDC, amount, p.swapMinOut, p.deadline, p.swapRouteData)
                )
            ),
            (uint256)
        );
    }

    function _venueFor(address asset, bool requireEnabled) internal view returns (ICollateralVenue) {
        CollateralRegistry.AssetConfig memory cfg = REGISTRY.config(asset);
        if (cfg.venue == address(0)) revert AssetNotRegistered(asset);
        if (requireEnabled) {
            if (!cfg.enabled) revert AssetDisabled(asset, cfg.note);
            if (!ICollateralVenue(cfg.venue).enabled()) revert VenueDisabled(cfg.venue);
        }
        return ICollateralVenue(cfg.venue);
    }

    function _nested(address peripheral, bytes memory data) internal returns (bytes memory) {
        return _account().execNestedPeripheral(peripheral, 0, data);
    }

    /// @dev The router is not a holder. Cheap to prove at the end of every call.
    function _assertHoldsNothing(address token) internal view {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) revert RouterHoldsBalance(token, bal);
    }
}
