// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Acceptable pool price window (sqrtPriceX96) for any engine call that swaps or mints —
///         read from the pool's `slot0()` at execution and compared; outside → revert. Both bounds
///         must be non-zero AND the window's WIDTH is bounded by the venue (`MAX_BAND_BPS`): there
///         is no "no band", and `[1, type(uint160).max]` — which is "no band" wearing a band's
///         clothes — is refused (a value floor would pass while a swap is robbed; a price band does
///         not — AUDIT-FINDINGS Part 5).
struct PriceBand {
    uint160 minSqrtPriceX96;
    uint160 maxSqrtPriceX96;
}

/// @notice Parameters for a new LP position. Either amount may be zero (single-sided entry; the
///         engine swaps to ratio internally). Both non-zero = dual deposit: the engine bounces the
///         excess of the long leg and the venue folds it back in with a single-sided deposit.
struct LpOpenParams {
    bytes32 poolId;
    uint256 amount0;
    uint256 amount1;
    /// @dev TOTAL tick span in bps (1 bps = 1 tick). Bounds [150, 5000].
    uint24 rangeWidthBps;
    /// @dev Seconds out of range before the engine repositions.
    uint64 rebalanceDelay;
    bool autoCompound;
    PriceBand band;
    uint256 deadline;
}

/// @title ILpVenue — one LP engine as seen by the account, router and keeper.
///
/// @notice Mutating functions are called BY an OilskinAccount (it is `msg.sender`); the venue
///         instructs the account so the ACCOUNT is `msg.sender` to the engine and owns every id.
///         There is no venue-side position state: `positionsOf` enumerates the engine.
interface ILpVenue {
    /// @notice Open a position; returns the engine id minted to the calling account.
    function open(LpOpenParams calldata params) external returns (uint256 positionId);

    /// @notice Deposit more into the same pool with `positionId`'s parameters. The engine has no
    ///         in-place increase, so this mints a NEW id (returned) beside the old one.
    function increase(
        uint256 positionId,
        uint256 amount0,
        uint256 amount1,
        PriceBand calldata band,
        uint256 deadline
    ) external returns (uint256 newPositionId);

    /// @notice Close one id entirely: realised yield is collected first (performance fee applies to
    ///         it), then principal is withdrawn (no fee). Everything lands in the calling account.
    /// @return out0 token0 paid to the account (principal + net fees).
    /// @return out1 token1 paid to the account (principal + net fees).
    /// @return rewards reward-token paid to the account, net of fee (0 if the reward token is a pool token).
    function close(uint256 positionId, PriceBand calldata band)
        external
        returns (uint256 out0, uint256 out1, uint256 rewards);

    /// @notice Close several ids with per-id try/catch: what closes is paid; ids the engine refuses
    ///         — including the id at index 0 — are returned in `failed` and left untouched. An
    ///         un-closable id never blocks the rest, which is what makes a protective unwind survive
    ///         the engine re-keying a position between the keeper's read and its dispatch.
    function closeMany(uint256[] calldata positionIds, PriceBand calldata band)
        external
        returns (uint256 out0, uint256 out1, uint256 rewards, uint256[] memory failed);

    /// @notice Collect realised fees / rewards for `positionIds` into the calling account, net of the
    ///         performance fee. The ONLY place (with `close`) where the fee is taken.
    /// @dev Carries the same band and deadline as every other engine-touching entry point: a
    ///      compounding `harvest` inside the engine may swap, and an unbanded, undated claim can be
    ///      executed at any price at any time. Ids the account does not own, or that sit in another
    ///      pool, are REPORTED in `failed` and skipped — never a revert, at index 0 or anywhere else.
    function claim(uint256[] calldata positionIds, PriceBand calldata band, uint256 deadline)
        external
        returns (uint256 fees0, uint256 fees1, uint256 rewards, uint256[] memory failed);

    /// @notice Live engine ids owned by `account` (index enumeration until the measured end-of-list
    ///         revert; fails closed if the engine cannot be enumerated).
    function positionsOf(address account) external view returns (uint256[] memory);

    /// @notice (token0, token1, pool address) for an engine poolId.
    function poolTokens(bytes32 poolId)
        external
        view
        returns (address token0, address token1, address pool);

    /// @notice (poolId, owner) of an engine id; both zero once the id is closed or re-keyed.
    function poolOf(uint256 positionId) external view returns (bytes32 poolId, address owner);

    function performanceBps() external view returns (uint256);
    function treasury() external view returns (address);
}
