// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {IOilskinAccount} from "../interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {LoanDust} from "../libraries/LoanDust.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IPermit2} from "../interfaces/IPermit2.sol";
import {CollateralRegistry} from "../registry/CollateralRegistry.sol";

/// @title StrategyRouter — stateless "supply → borrow → (swap) → LP" and its mirror, executed BY the
///        caller's OilskinAccount.
///
/// @notice The account calls the router (`account.execWithCallback(router, openLeveragedLp(...))`, or
///         the factory's `createAccountAndExec` for a first-time user); the router then instructs the
///         account through the venues, so every position is the account's and the router never holds
///         anything: its balance of every token it touches is UNCHANGED across every call. It has no
///         storage, no owner, no fee. Every hop carries a deadline and a floor: Permit2 deadline, the
///         pool price band on the LP deposit/close, a quote-derived slippage floor on each swap, and
///         the entry health-factor floor after any borrow (enforced by the venue itself, so no entry
///         point can skip it). The LP pool must contain USDC in v1 (the borrowed USDC goes in
///         single-sided, which the engine mints as a ONE-SIDED range below the price without swapping
///         — measured 2026-09-10, `ISnuggleVault` FACT 4 — so no swap is needed on open); a non-USDC pool token is swapped
///         back to USDC on unwind.
///
/// @dev **The non-holder property is a DELTA, not an absolute.** Anyone can send tokens to any
///      address, and this contract is immutable with no rescue: asserting `balanceOf(this) == 0`
///      would let one base unit of USDC, from anybody, permanently disable every open and every
///      unwind for every user — including the keeper's only protective grant. So each entry point
///      snapshots its balance of every token it will touch and requires it UNCHANGED at exit. A
///      donation is inert; a token that actually stuck to the router still reverts.
contract StrategyRouter is Peripheral {
    CollateralRegistry public immutable REGISTRY;
    /// @notice The engine venue (`SnuggleLpVenue`) and the swap adapter its pools' non-USDC legs go
    ///         through (`AerodromeSwapAdapter`, the verified SwapRouter).
    ILpVenue public immutable LP_VENUE;
    ISwapAdapter public immutable SWAP;
    /// @notice The direct Slipstream venue (`SlipstreamLpVenue`, the cbZEC/USDC pool on the second
    ///         deployment — `CBZEC-PATH-2026-09.md` option 1, decided 2026-09-10) and the pool-direct
    ///         adapter its leg swaps through, because the SwapRouter cannot reach that pool.
    ///         `address(0)` on a deployment without them (Base Sepolia). A pool id is looked up on the
    ///         engine venue first, then here; an unwind's ids are resolved the same way, by which
    ///         venue says the calling account owns the first of them.
    ILpVenue public immutable LP_VENUE_DIRECT;
    ISwapAdapter public immutable SWAP_DIRECT;
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

    /// @notice The "borrow and hold" shape: collateral in, USDC out, nothing deployed.
    struct BorrowOnlyParams {
        address collateralAsset;
        /// @dev 0 = borrow against collateral already supplied by this account.
        uint256 collateralAmount;
        Permit2Pull permit;
        /// @dev USDC to borrow. Must be > 0. Lands in the account.
        uint256 borrowAmount;
        uint256 deadline;
    }

    /// @notice The caller's swap quote for the non-USDC LP leg, scaled and bounded by the adapter.
    struct SwapQuote {
        /// @dev Input amount the quote was taken for (raw units of the non-USDC pool token).
        uint256 quotedIn;
        /// @dev USDC that quote promised for `quotedIn`.
        uint256 quotedOut;
        /// @dev Tolerance below the quoted rate; the adapter caps it (MAX_SLIPPAGE_BPS).
        uint16 maxSlippageBps;
        bytes routeData;
    }

    struct UnwindParams {
        address collateralAsset;
        /// @dev LP ids to close (all in one pool). May be empty (repay / withdraw only).
        uint256[] positionIds;
        PriceBand band;
        /// @dev Quote for swapping the non-USDC pool token proceeds to USDC. Required when the pool
        ///      has a non-USDC leg and that leg pays out; ignored otherwise.
        SwapQuote swap;
        /// @dev USDC to repay. type(uint256).max = everything the account holds up to its debt.
        ///      0 = none. A fixed amount against zero debt is a no-op, never a revert.
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
    /// @notice A borrow-only ("hold") open. Carries the same floor as every other entry point.
    event BorrowOnlyOpened(
        address indexed account,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 borrowed,
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
    /// @notice The repay leg of `unwind` reached `venue`: `repaid` USDC of the calling account's
    ///         debt there. One per venue repaid, worst health factor first. The keeper reads these
    ///         from the receipt and refuses to confirm a protective unwind that left a venue the
    ///         account still owes untouched — `LeveragedLpUnwound.repaid` is a total and cannot say
    ///         WHICH book was paid (`RISKS.md` §8, 2026-09-09).
    event VenueRepaid(address indexed account, address indexed venue, uint256 repaid);
    /// @notice The withdraw leg of `unwind` reached `venue`: `withdrawn` of the collateral asset
    ///         returned to the calling account from there. One per venue holding the account's
    ///         collateral, current pointer first — a two-book account is cleared in ONE Close
    ///         (`RISKS.md` §8 "two-book Close", option (1), decided 2026-09-10). `LeveragedLpUnwound
    ///         .withdrawn` is the sum.
    event VenueWithdrawn(address indexed account, address indexed venue, uint256 withdrawn);
    event Swept(address indexed account, address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error Expired(uint256 deadline);
    error AssetNotRegistered(address asset);
    error AssetDisabled(address asset, string note);
    error VenueDisabled(address venue);
    error ZeroBorrow();
    error PoolWithoutUsdc(bytes32 poolId);
    /// @notice Neither LP venue serves `poolId`.
    error UnknownPool(bytes32 poolId);
    /// @notice A fixed `withdrawAmount` could not be met from the venues holding the account's
    ///         collateral: `withdrawn` of `asked` came back. `max` never raises this.
    error CollateralShort(uint256 asked, uint256 withdrawn);
    /// @notice Both LP venues say the calling account owns `positionId` (the engine's and the
    ///         position manager's id counters are independent): the batch cannot be routed by
    ///         name, so it is refused instead of closing the engine's by default (wave 3, W3-LOW-1).
    error AmbiguousPositionId(uint256 positionId);
    error EntryHfTooLow(uint256 healthFactor, uint256 floor);
    error ExitHfTooLow(uint256 healthFactor, uint256 floor);
    /// @notice The router's own balance of `token` moved across the call: `before` → `current`.
    ///         Only reachable if the router actually acquired or lost a token, never by a donation.
    error RouterBalanceChanged(address token, uint256 balanceBefore, uint256 balanceAfter);
    /// @notice The swap quote implies a pool price outside the close's own price band: the caller
    ///         committed to `[min, max]` on the pool's sqrt price for the close and then quoted the
    ///         leg as if the price were elsewhere (audit wave 2, G-MED-1).
    error QuoteOutsideBand(uint256 impliedSqrtPriceX96, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96);

    constructor(
        CollateralRegistry registry,
        ILpVenue lpVenue,
        ISwapAdapter swapAdapter,
        IPermit2 permit2,
        address usdc,
        ILpVenue lpVenueDirect,
        ISwapAdapter swapAdapterDirect
    ) {
        if (
            address(registry) == address(0) || address(lpVenue) == address(0)
                || address(swapAdapter) == address(0) || address(permit2) == address(0)
                || usdc == address(0)
        ) revert ZeroAddress();
        // Both or neither: a direct venue whose leg has no adapter could open and never close.
        if ((address(lpVenueDirect) == address(0)) != (address(swapAdapterDirect) == address(0))) revert ZeroAddress();
        REGISTRY = registry;
        LP_VENUE = lpVenue;
        SWAP = swapAdapter;
        PERMIT2 = permit2;
        USDC = usdc;
        LP_VENUE_DIRECT = lpVenueDirect;
        SWAP_DIRECT = swapAdapterDirect;
    }

    // ------------------------------------------------------------------ open

    /// @notice Permit2 pull → venue.supply → venue.borrow(USDC) → lpVenue.open, all as the account.
    /// @dev Invariant: the asset is enabled in the registry and its venue is enabled; after the
    ///      borrow the account's health factor is ≥ the registry's entry floor (the VENUE enforces
    ///      it, this is the second, named check); the LP id is minted to the account; the router's
    ///      own balance of every token involved is unchanged.
    function openLeveragedLp(OpenParams calldata p)
        external
        returns (uint256 positionId, uint256 healthFactor)
    {
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        if (p.borrowAmount == 0) revert ZeroBorrow();
        ICollateralVenue venue = _entryVenueFor(p.collateralAsset);
        (ILpVenue lp, address t0, address t1) = _lpVenueForPool(p.poolId);
        if (t0 != USDC && t1 != USDC) revert PoolWithoutUsdc(p.poolId);

        address account = msg.sender;
        uint256 beforeCollateral = _balance(p.collateralAsset);
        uint256 beforeUsdc = _balance(USDC);
        uint256 beforeT0 = _balance(t0);
        uint256 beforeT1 = _balance(t1);

        healthFactor = _supplyAndBorrow(venue, account, p.collateralAsset, p.collateralAmount, p.permit, p.borrowAmount);

        LpOpenParams memory lpParams = LpOpenParams({
            poolId: p.poolId,
            amount0: t0 == USDC ? p.borrowAmount : 0,
            amount1: t1 == USDC ? p.borrowAmount : 0,
            rangeWidthBps: p.rangeWidthBps,
            rebalanceDelay: p.rebalanceDelay,
            autoCompound: p.autoCompound,
            band: p.band,
            deadline: p.deadline
        });
        positionId = abi.decode(_nested(address(lp), abi.encodeCall(ILpVenue.open, (lpParams))), (uint256));

        _assertUnchanged(p.collateralAsset, beforeCollateral);
        _assertUnchanged(USDC, beforeUsdc);
        _assertUnchanged(t0, beforeT0);
        _assertUnchanged(t1, beforeT1);
        emit LeveragedLpOpened(
            account, p.collateralAsset, p.collateralAmount, p.borrowAmount, p.poolId, positionId, healthFactor
        );
    }

    /// @notice Permit2 pull → venue.supply → venue.borrow(USDC), and stop. The "hold" shape: the
    ///         borrowed USDC lands in the account and is not deployed.
    /// @dev Invariant: identical entry conditions to `openLeveragedLp` — registry-enabled asset,
    ///      enabled venue, deadline, and the entry health-factor floor after the borrow. It exists
    ///      so no product flow ever has a reason to hand-build a supply/borrow batch that skips
    ///      those checks.
    function openBorrowOnly(BorrowOnlyParams calldata p) external returns (uint256 healthFactor) {
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        if (p.borrowAmount == 0) revert ZeroBorrow();
        ICollateralVenue venue = _entryVenueFor(p.collateralAsset);

        address account = msg.sender;
        uint256 beforeCollateral = _balance(p.collateralAsset);
        uint256 beforeUsdc = _balance(USDC);

        healthFactor = _supplyAndBorrow(venue, account, p.collateralAsset, p.collateralAmount, p.permit, p.borrowAmount);

        _assertUnchanged(p.collateralAsset, beforeCollateral);
        _assertUnchanged(USDC, beforeUsdc);
        emit BorrowOnlyOpened(account, p.collateralAsset, p.collateralAmount, p.borrowAmount, healthFactor);
    }

    // ---------------------------------------------------------------- unwind

    /// @notice The mirror: lpVenue.closeMany → swap non-USDC proceeds to USDC → venue.repay on
    ///         EVERY venue the account still owes, worst health factor first → venue.withdraw from
    ///         EVERY venue holding the account's collateral, current pointer first, each gated by
    ///         its own exit floor (one `VenueWithdrawn` each), all as the account. Works for DISABLED assets (exits
    ///         are never gated on the asset flag) but not through a DISABLED venue, which is a
    ///         different thing: a venue that reports itself off is code we will not delegate to,
    ///         and the owner's raw `exec` to the protocol still works when it happens.
    /// @dev Invariant: an un-closable id is skipped, never blocking — at index 0 like anywhere else;
    ///      a swap of a non-USDC leg is bounded by the caller's quote and the adapter's cap; the
    ///      repay reaches every venue named for the asset that the account owes USDC on, the book
    ///      with the lowest health factor first, and a fixed repay against zero debt is a no-op,
    ///      not a revert; after a collateral withdraw with ANY debt outstanding EACH withdrawn-from
    ///      venue's global health factor is ≥ the entry floor; `withdrawAmount = max` returns
    ///      everything from every venue, a fixed amount is a TOTAL taken in venue order and reverts
    ///      `CollateralShort` if the venues cannot meet it; the ids may be the engine venue's or the
    ///      direct venue's, never both in one call; the router's balance of every token it touched
    ///      is unchanged.
    function unwind(UnwindParams calldata p)
        external
        returns (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn, uint256 healthFactor)
    {
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        address account = msg.sender;
        // Every venue the registry has ever named for this asset, current pointer first. The REPAY
        // leg visits all of them the account owes (`_repayAcross`); the WITHDRAW leg visits all of
        // them holding the account's collateral (`_withdrawAcross`); the refusal through a venue
        // that is off is decided on the first one holding the account's position — as before.
        address[] memory venues = _exitVenues(p.collateralAsset);
        ICollateralVenue venue = _exitVenueFor(venues, p.collateralAsset, account);

        uint256 beforeCollateral = _balance(p.collateralAsset);
        uint256 beforeUsdc = _balance(USDC);

        uint256 closed;
        uint256 failedCount;
        if (p.positionIds.length != 0) {
            (usdcFromLp, closed, failedCount) = _closeAndSettle(p);
        }

        if (p.repayAmount != 0) repaid = _repayAcross(venues, account, p.repayAmount);

        if (p.withdrawAmount != 0) {
            withdrawn = _withdrawAcross(venues, venue, p.collateralAsset, account, p.withdrawAmount);
        }

        // Reported: the account's WORST health factor across every venue named for the asset — the
        // number the keeper's ladder runs on — not just the venue withdrawn from.
        healthFactor = _worstHealthFactor(venues, account);

        _assertUnchanged(p.collateralAsset, beforeCollateral);
        _assertUnchanged(USDC, beforeUsdc);
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

    function _supplyAndBorrow(
        ICollateralVenue venue,
        address account,
        address collateralAsset,
        uint256 collateralAmount,
        Permit2Pull calldata permit,
        uint256 borrowAmount
    ) internal returns (uint256 healthFactor) {
        if (collateralAmount != 0) {
            if (permit.signature.length != 0) _pull(account, collateralAsset, collateralAmount, permit);
            _nested(address(venue), abi.encodeCall(ICollateralVenue.supply, (collateralAsset, collateralAmount)));
            // The debt goes against the collateral the user just chose — on an isolated-market
            // venue the alternative put it wherever the headroom was biggest, and the review
            // screen's liquidation price then named the wrong asset (audit wave 2, M-MED-1).
            _nested(address(venue), abi.encodeCall(ICollateralVenue.borrowAgainst, (collateralAsset, USDC, borrowAmount)));
        } else {
            // Borrow against whatever is already here: the venue picks the market.
            _nested(address(venue), abi.encodeCall(ICollateralVenue.borrow, (USDC, borrowAmount)));
        }
        // The venue itself refuses a borrow that breaks the floor; this re-reads it so the router's
        // own named error is what a caller sees when the router is the one composing the call.
        healthFactor = venue.healthFactor(account);
        uint256 floor = REGISTRY.entryHfFloorWad();
        if (healthFactor < floor) revert EntryHfTooLow(healthFactor, floor);
    }

    /// @dev Close the ids, swap any non-USDC proceeds, and report what closed. Separated so the
    ///      pool tokens' balance snapshots live in one frame.
    function _closeAndSettle(UnwindParams calldata p)
        internal
        returns (uint256 usdcFromLp, uint256 closed, uint256 failedCount)
    {
        // A stale id at index 0 no longer decides the batch's pool: the venue reports it in `failed`
        // like any other. Use the first id this account actually owns — the same rule the venue
        // uses, so the tokens the router swaps are always the tokens the venue paid out.
        // The venue is the one that says the account owns that id (`ownedPool`): a position staked
        // in a Slipstream gauge is the gauge's on the NFT's books and the account's on the gauge's.
        (ILpVenue lp, ISwapAdapter adapter, bytes32 poolId) = _lpVenueForIds(p.positionIds, msg.sender);
        if (poolId == bytes32(0)) return (0, 0, p.positionIds.length);

        (address t0, address t1,) = lp.poolTokens(poolId);
        uint256 beforeT0 = _balance(t0);
        uint256 beforeT1 = _balance(t1);

        (uint256 out0, uint256 out1,, uint256[] memory failed) = abi.decode(
            _nested(address(lp), abi.encodeCall(ILpVenue.closeMany, (p.positionIds, p.band))),
            (uint256, uint256, uint256, uint256[])
        );
        failedCount = failed.length;
        closed = p.positionIds.length - failedCount;
        usdcFromLp = _toUsdc(adapter, t0, out0, p, true) + _toUsdc(adapter, t1, out1, p, false);

        _assertUnchanged(t0, beforeT0);
        _assertUnchanged(t1, beforeT1);
    }

    function _pull(
        address account,
        address collateralAsset,
        uint256 collateralAmount,
        Permit2Pull calldata pp
    ) internal {
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: collateralAsset, amount: collateralAmount}),
            nonce: pp.nonce,
            deadline: pp.deadline
        });
        IPermit2.SignatureTransferDetails memory details =
            IPermit2.SignatureTransferDetails({to: account, requestedAmount: collateralAmount});
        address signer = IOilskinAccount(account).owner();
        _exec(
            address(PERMIT2),
            abi.encodeCall(IPermit2.permitTransferFrom, (permit, details, signer, pp.signature))
        );
    }

    function _toUsdc(ISwapAdapter adapter, address token, uint256 amount, UnwindParams calldata p, bool tokenIsToken0)
        internal
        returns (uint256)
    {
        if (amount == 0) return 0;
        if (token == USDC) return amount;
        _requireQuoteInBand(tokenIsToken0, p.swap, p.band);
        return abi.decode(
            _nested(
                address(adapter),
                abi.encodeCall(
                    ISwapAdapter.swap,
                    (
                        token,
                        USDC,
                        amount,
                        p.swap.quotedIn,
                        p.swap.quotedOut,
                        p.swap.maxSlippageBps,
                        p.deadline,
                        p.swap.routeData
                    )
                )
            ),
            (uint256)
        );
    }

    uint256 private constant Q192 = 2 ** 192;

    /// @dev The quote must agree with the band. The adapter's floor is RELATIVE to the caller's
    ///      quote, so a dishonest quote drives the floor wherever it likes (`quotedIn = amountIn ×
    ///      quotedOut × 0.95` makes it one base unit). But the same caller has already committed
    ///      to a price band for the close — `[minSqrtPriceX96, maxSqrtPriceX96]` on the pool's own
    ///      sqrt price, checked against `slot0()` at execution and bounded at MAX_BAND_BPS — so the
    ///      price the quote implies must sit inside it. A dishonest quote and an honest band cannot
    ///      coexist; an honest quote taken from the same live price always passes (audit wave 2,
    ///      G-MED-1). Pool price = token1 per token0 in raw units = (sqrtP / 2^96)²; the quote is
    ///      `quotedOut` USDC for `quotedIn` of the other token. A zero quote is the adapter's
    ///      `ZeroQuote`, not this check's.
    function _requireQuoteInBand(bool tokenInIsToken0, SwapQuote calldata q, PriceBand calldata band)
        internal
        pure
    {
        if (q.quotedIn == 0 || q.quotedOut == 0) return;
        (uint256 num, uint256 den) = tokenInIsToken0 ? (q.quotedOut, q.quotedIn) : (q.quotedIn, q.quotedOut);
        // sqrt(num / den) × 2^96 = sqrt(num × 2^192 / den); an absurd ratio overflows and reverts.
        uint256 impliedSqrt = Math.sqrt(Math.mulDiv(num, Q192, den));
        if (impliedSqrt < band.minSqrtPriceX96 || impliedSqrt > band.maxSqrtPriceX96) {
            revert QuoteOutsideBand(impliedSqrt, band.minSqrtPriceX96, band.maxSqrtPriceX96);
        }
    }

    /// @dev The LP venue serving `poolId` and the pool's tokens: the engine venue first, then the
    ///      direct venue. A pool neither serves is refused by name.
    function _lpVenueForPool(bytes32 poolId) internal view returns (ILpVenue lp, address t0, address t1) {
        address pool;
        (t0, t1, pool) = LP_VENUE.poolTokens(poolId);
        if (pool != address(0)) return (LP_VENUE, t0, t1);
        if (address(LP_VENUE_DIRECT) != address(0)) {
            (t0, t1, pool) = LP_VENUE_DIRECT.poolTokens(poolId);
            if (pool != address(0)) return (LP_VENUE_DIRECT, t0, t1);
        }
        revert UnknownPool(poolId);
    }

    /// @dev The LP venue, its swap adapter and the pool of the first id in `ids` that `account`
    ///      owns. A stale id at index 0 no longer decides the batch's pool: the venue reports it in
    ///      `failed` like any other, and the tokens the router swaps are always the tokens the venue
    ///      paid out. The two id spaces are independent counters, so BOTH venues are asked about
    ///      the first owned id: an id both claim is refused by name (`AmbiguousPositionId`, wave 3
    ///      W3-LOW-1) rather than routed to the engine's by default — the caller then closes that
    ///      id through the venue's own `close`, where there is no ambiguity.
    function _lpVenueForIds(uint256[] calldata ids, address account)
        internal
        view
        returns (ILpVenue lp, ISwapAdapter adapter, bytes32 poolId)
    {
        bool direct = address(LP_VENUE_DIRECT) != address(0);
        for (uint256 i = 0; i < ids.length; i++) {
            (bytes32 pid, bool owned) = LP_VENUE.ownedPool(ids[i], account);
            bytes32 pidDirect;
            bool ownedDirect;
            if (direct) (pidDirect, ownedDirect) = LP_VENUE_DIRECT.ownedPool(ids[i], account);
            bool engineOwns = owned && pid != bytes32(0);
            bool directOwns = ownedDirect && pidDirect != bytes32(0);
            if (engineOwns && directOwns) revert AmbiguousPositionId(ids[i]);
            if (engineOwns) return (LP_VENUE, SWAP, pid);
            if (directOwns) return (LP_VENUE_DIRECT, SWAP_DIRECT, pidDirect);
        }
        return (LP_VENUE, SWAP, bytes32(0));
    }

    /// @dev The withdraw leg visits EVERY venue in `venues` holding the account's collateral, current
    ///      pointer first — one `VenueWithdrawn` per venue reached, each gated by that venue's own
    ///      GLOBAL health factor (it covers every reserve the venue holds; a debt under the floor on
    ///      ANOTHER venue must not trap collateral that was never behind it). Until 2026-09-11 the
    ///      leg stopped at the first venue holding anything, so an account with books on both
    ///      venues after a registry switch got one venue's collateral back per Close and the other
    ///      stayed, debt-free, where it was (`RISKS.md` §8 "two-book Close", option (1)).
    ///      `max` = everything on every venue. A fixed amount is a TOTAL: taken in venue order, at
    ///      most what each venue holds, and `CollateralShort` if the venues cannot meet it — never
    ///      silently less than asked. With nothing held anywhere the current pointer (`fallback`, the
    ///      venue `_exitVenueFor` resolved) is asked as before, so its own named refusal is what the
    ///      caller sees.
    function _withdrawAcross(
        address[] memory venues,
        ICollateralVenue fallback_,
        address asset,
        address account,
        uint256 amount
    ) internal returns (uint256 withdrawn) {
        bool all = amount == type(uint256).max;
        uint256 remaining = amount;
        uint256 visited;
        for (uint256 i = 0; i < venues.length && remaining != 0; i++) {
            uint256 held = _collateralOf(venues[i], asset, account);
            if (held == 0) continue;
            ICollateralVenue v = _requireVenueEnabled(venues[i]);
            uint256 ask = all ? type(uint256).max : (remaining < held ? remaining : held);
            uint256 got = _withdrawGated(v, asset, account, ask);
            withdrawn += got;
            if (!all) remaining = got >= remaining ? 0 : remaining - got;
            visited++;
            emit VenueWithdrawn(account, address(v), got);
        }
        if (visited == 0) {
            withdrawn = _withdrawGated(fallback_, asset, account, amount);
            emit VenueWithdrawn(account, address(fallback_), withdrawn);
        } else if (!all && remaining != 0) {
            revert CollateralShort(amount, withdrawn);
        }
    }

    function _withdrawGated(ICollateralVenue v, address asset, address account, uint256 amount)
        internal
        returns (uint256 got)
    {
        got = abi.decode(_nested(address(v), abi.encodeCall(ICollateralVenue.withdraw, (asset, amount))), (uint256));
        uint256 hfAfter = v.healthFactor(account);
        if (hfAfter != type(uint256).max) {
            uint256 floor = REGISTRY.entryHfFloorWad();
            if (hfAfter < floor) revert ExitHfTooLow(hfAfter, floor);
        }
    }

    function _collateralOf(address venue, address asset, address account) internal view returns (uint256) {
        try ICollateralVenue(venue).collateral(account, asset) returns (uint256 held) {
            return held;
        } catch {
            return 0;
        }
    }

    /// @dev Opens resolve the registry's CURRENT venue and require both the venue's and the asset's
    ///      flag. Exits follow the POSITION (audit wave 2, M-HIGH-1), see `_exitVenues`.
    function _entryVenueFor(address asset) internal view returns (ICollateralVenue) {
        CollateralRegistry.AssetConfig memory cfg = REGISTRY.config(asset);
        if (cfg.venue == address(0)) revert AssetNotRegistered(asset);
        if (!ICollateralVenue(cfg.venue).enabled()) revert VenueDisabled(cfg.venue);
        if (!cfg.enabled) revert AssetDisabled(asset, cfg.note);
        return ICollateralVenue(cfg.venue);
    }

    /// @dev Every venue the registry names for `asset`: the current pointer first, then each entry
    ///      of `previousVenues` (audit wave 2, M-HIGH-1: a switch must never strand what was opened
    ///      before it). The registry keeps that list free of the current venue and of duplicates;
    ///      both are skipped here regardless, so no venue is ever visited twice.
    function _exitVenues(address asset) internal view returns (address[] memory list) {
        CollateralRegistry.AssetConfig memory cfg = REGISTRY.config(asset);
        if (cfg.venue == address(0)) revert AssetNotRegistered(asset);
        address[] memory previous = REGISTRY.previousVenues(asset);
        list = new address[](previous.length + 1);
        list[0] = cfg.venue;
        uint256 n = 1;
        for (uint256 i = 0; i < previous.length; i++) {
            address v = previous[i];
            if (v == address(0)) continue;
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (list[j] == v) {
                    seen = true;
                    break;
                }
            }
            if (!seen) list[n++] = v;
        }
        assembly ("memory-safe") {
            mstore(list, n)
        }
    }

    /// @dev The venue an exit is refused through when it is off, and the one a withdrawal falls back
    ///      to when no venue holds the account's collateral: the first of `venues` holding anything
    ///      of the account's (debt or collateral), else the current pointer. The VENUE's own switch
    ///      is honoured on every path, entry and exit: a venue that says it is off is not code the
    ///      account should be handed to. Only the ASSET flag is bypassed on exit. Neither the REPAY
    ///      leg nor the WITHDRAW leg stops at this venue — `_repayAcross`, `_withdrawAcross`.
    function _exitVenueFor(address[] memory venues, address asset, address account)
        internal
        view
        returns (ICollateralVenue)
    {
        for (uint256 i = 0; i < venues.length; i++) {
            if (_holdsPosition(venues[i], asset, account)) return _requireVenueEnabled(venues[i]);
        }
        return _requireVenueEnabled(venues[0]);
    }

    /// @dev The repay leg visits EVERY venue in `venues` that the account still owes USDC on, worst
    ///      health factor first, until `repayAmount` (max = all the USDC the account holds) is
    ///      spent — one `VenueRepaid` per venue reached. The exit used to stop at the first venue
    ///      holding anything of the account's, so dust collateral, or a small healthy debt, on the
    ///      registry's new pointer absorbed the keeper's repay while the debt that fired the rung
    ///      rode on (`RISKS.md` §8 residual (a), closed 2026-09-09). Worst-first is the rule
    ///      `MorphoBlueVenue.repay` already applies across its markets: with USDC to spare every
    ///      book is cleared; with USDC short, the book in most trouble gets it. A venue that says
    ///      it is off reverts `VenueDisabled` here as everywhere else, and a venue whose repay
    ///      reverts reverts the whole call — never a silent skip, so the keeper's simulation names
    ///      the reason instead of a receipt hiding it.
    function _repayAcross(address[] memory venues, address account, uint256 repayAmount)
        internal
        returns (uint256 repaid)
    {
        (address[] memory owing, uint256[] memory owed, uint256 n) = _owingWorstFirst(venues, account);
        uint256 remaining = repayAmount;
        for (uint256 i = 0; i < n && remaining != 0; i++) {
            uint256 held = IERC20(USDC).balanceOf(account);
            if (held == 0) break;
            uint256 amount = owed[i] < held ? owed[i] : held;
            if (amount > remaining) amount = remaining;
            _requireVenueEnabled(owing[i]);
            uint256 got = abi.decode(
                _nested(owing[i], abi.encodeCall(ICollateralVenue.repay, (USDC, amount))), (uint256)
            );
            repaid += got;
            remaining = got >= remaining ? 0 : remaining - got;
            emit VenueRepaid(account, owing[i], got);
        }
    }

    /// @dev The venues where `account` owes USDC, ordered by health factor ascending — the book in
    ///      most trouble first; equal factors keep registry order (insertion sort, the list is a
    ///      handful of addresses). A venue whose `debt` view reverts is treated as owing nothing,
    ///      exactly as `_holdsPosition` treats it; one whose `healthFactor` reverts sorts first.
    function _owingWorstFirst(address[] memory venues, address account)
        internal
        view
        returns (address[] memory owing, uint256[] memory owed, uint256 n)
    {
        owing = new address[](venues.length);
        owed = new uint256[](venues.length);
        uint256[] memory hfs = new uint256[](venues.length);
        for (uint256 i = 0; i < venues.length; i++) {
            uint256 debt_ = _debtOf(venues[i], account);
            if (debt_ == 0) continue;
            uint256 hf = _healthFactorOf(venues[i], account);
            uint256 j = n;
            while (j > 0 && hfs[j - 1] > hf) {
                owing[j] = owing[j - 1];
                owed[j] = owed[j - 1];
                hfs[j] = hfs[j - 1];
                j--;
            }
            owing[j] = venues[i];
            owed[j] = debt_;
            hfs[j] = hf;
            n++;
        }
    }

    /// @dev The lowest health factor the account has on any venue in `venues`; max when it owes
    ///      nothing anywhere. A venue whose view reverts is skipped, as `_holdsPosition` skips it.
    function _worstHealthFactor(address[] memory venues, address account)
        internal
        view
        returns (uint256 worst)
    {
        worst = type(uint256).max;
        for (uint256 i = 0; i < venues.length; i++) {
            try ICollateralVenue(venues[i]).healthFactor(account) returns (uint256 hf) {
                if (hf < worst) worst = hf;
            } catch {}
        }
    }

    function _debtOf(address venue, address account) internal view returns (uint256) {
        try ICollateralVenue(venue).debt(account, USDC) returns (uint256 owed) {
            return owed;
        } catch {
            return 0;
        }
    }

    function _healthFactorOf(address venue, address account) internal view returns (uint256) {
        try ICollateralVenue(venue).healthFactor(account) returns (uint256 hf) {
            return hf;
        } catch {
            return 0;
        }
    }

    /// @dev Whether `venue` holds anything of `account`'s for `asset`. A venue whose views revert
    ///      is treated as holding nothing — the keeper reads `LeveragedLpUnwound.repaid` from the
    ///      receipt and refuses to call a repay that moved nothing a success. Loan-token debt at or
    ///      below `LoanDust.UNITS` is rounding, not a position (slice C, `RISKS.md` §8): a book that
    ///      holds only such a residual must not attract the withdraw leg, or a Close on a two-book
    ///      account would be sent to the venue with nothing to withdraw. The REPAY leg still visits
    ///      it (`_owingWorstFirst`), so the residual is cleared whenever USDC is available.
    function _holdsPosition(address venue, address asset, address account) internal view returns (bool) {
        try ICollateralVenue(venue).debt(account, USDC) returns (uint256 owed) {
            if (!LoanDust.isDust(owed)) return true;
        } catch {}
        try ICollateralVenue(venue).collateral(account, asset) returns (uint256 held) {
            if (held != 0) return true;
        } catch {}
        return false;
    }

    function _requireVenueEnabled(address venue) internal view returns (ICollateralVenue v) {
        v = ICollateralVenue(venue);
        if (!v.enabled()) revert VenueDisabled(venue);
    }

    function _nested(address peripheral, bytes memory data) internal returns (bytes memory) {
        return _account().execNestedPeripheral(peripheral, 0, data);
    }

    function _balance(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @dev The router is not a holder: what it had at entry it still has at exit. A pre-existing
    ///      donation is inert — see the contract-level note on why this is a delta, not a zero.
    function _assertUnchanged(address token, uint256 balanceBefore) internal view {
        uint256 current = _balance(token);
        if (current != balanceBefore) revert RouterBalanceChanged(token, balanceBefore, current);
    }
}
