// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Parameters the LP engine (MaxFi / SnuggleFi) accepts at deposit time.
/// @dev rangeWidthBps: total range width in basis points (150 = 1.5%). The
///      engine takes uint24; we carry uint24 end-to-end.
///      rebalanceDelay: seconds the engine waits out-of-range before
///      auto-repositioning (engine stores uint64).
struct LpParams {
    uint24 rangeWidthBps;
    uint64 rebalanceDelay;
    bool autoCompound;
}

/// @title ILPAdapter — thin, engine-specific translator owned by the vault.
/// @notice Adapters own the underlying engine positions keyed by the vault's
///         positionId. They never hold idle user funds between transactions
///         and only accept calls from the PositionVault.
/// @dev `poolKey` is the engine's bytes32 pool registry id (see
///      ISnuggleVault.approvedPools), not a pool address.
interface ILPAdapter {
    /// @notice Open a new LP position in `poolKey` funded with `amount` of `token`.
    /// @return shares Adapter-scale accounting shares (principal-based).
    function open(
        uint256 positionId,
        bytes32 poolKey,
        address token,
        uint256 amount,
        LpParams calldata params
    ) external returns (uint256 shares);

    /// @notice Add funds to an existing position (compound / upgrade top-up).
    function increase(uint256 positionId, address token, uint256 amount)
        external
        returns (uint256 sharesAdded);

    /// @notice Collapse a position's accumulated engine positions into one,
    ///         paying nothing out. Each increase/compound mints a new engine
    ///         position (the engine has no in-place increase); left unbounded
    ///         they hit the adapter's per-position cap and further
    ///         increases/compounds revert. Consolidation restores headroom
    ///         without touching principal or user funds. Idle refund balances
    ///         held for the position are folded into the re-deposit.
    /// @param deadline Engine deadline for the re-deposit leg (0 = adapter
    ///        default window from now). A stale queued tx reverts instead of
    ///        re-minting at whatever price it lands on.
    /// @return count Engine positions remaining after consolidation (0 or 1).
    function consolidate(uint256 positionId, uint256 deadline) external returns (uint256 count);

    /// @notice Number of underlying engine positions backing `positionId`.
    ///         Lets the operator consolidate before hitting the cap.
    function tokenCount(uint256 positionId) external view returns (uint256);

    /// @notice Remove `shareBps` (1..10_000) of the position; tokens go to `recipient`.
    /// @dev The engine only supports full closes; partial withdrawals close the
    ///      whole position, pay out the share, and re-deposit the remainder.
    ///      Idle refund balances held for the position are included in the
    ///      payout accounting, and configured incentive-token balances (e.g.
    ///      AERO paid by the engine on close) are forwarded to `recipient`.
    /// @param minOut0 Minimum token0 the recipient must receive (slippage floor).
    /// @param minOut1 Minimum token1 the recipient must receive (slippage floor).
    ///        Pass 0 for no floor. Protects against MEV sandwiching the
    ///        close/re-deposit and against unexpectedly deep price impact.
    /// @param deadline Latest acceptable execution time, also passed to the
    ///        engine on the re-deposit leg (0 = adapter default window).
    /// @return tokens Slots 0/1 are the pool's token0/token1; any further
    ///         entries are forwarded incentive tokens.
    /// @return amounts Amounts paid to `recipient` per `tokens` entry.
    function withdraw(
        uint256 positionId,
        uint256 shareBps,
        address recipient,
        uint256 minOut0,
        uint256 minOut1,
        uint256 deadline
    ) external returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice The pool's canonical (token0, token1) for a position — lets the
    ///         UI/agent map minOut0/minOut1 to the right assets.
    function poolTokensOf(uint256 positionId) external view returns (address, address);

    /// @notice Collect accrued fees/rewards; tokens go to `recipient`.
    function claim(uint256 positionId, address recipient)
        external
        returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Accrued-but-unclaimed rewards. The engine exposes no pending
    ///         views, so adapters return empty arrays; the agent estimates
    ///         accrual off-chain and learns exact amounts at claim time.
    function pendingRewards(uint256 positionId)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Current accounting shares of a position (0 when fully withdrawn).
    function shares(uint256 positionId) external view returns (uint256);

    /// @notice Idle pool-token balances attributable to `positionId` that sit
    ///         outside the engine: deposit refunds (the engine returns
    ///         un-fitting leftovers in the deposit tx) and keeper-pushed
    ///         leftovers. Folded into the next re-deposit and included in
    ///         withdrawal payouts — never swept to the protocol.
    function idleOf(uint256 positionId) external view returns (uint256 amt0, uint256 amt1);

    /// @notice Whether every underlying engine position is currently in range
    ///         (engine-tracked via outOfRangeSince).
    function inRange(uint256 positionId) external view returns (bool);
}
