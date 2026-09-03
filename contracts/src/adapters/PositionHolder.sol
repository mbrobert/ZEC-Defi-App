// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PositionHolder — one engine account per vault position.
///
/// @notice Minimal EIP-1167 clone target. Each vault positionId gets its own
///         holder, and the holder — not the adapter — is the engine-side owner
///         of that position's tokenIds. This makes two things true by
///         construction:
///
///           1. The live engine tokenId set for a vault position is always
///              readable as `engine.userPositions(holder)`, so keeper
///              rebalances that RE-KEY the position (new tokenId minted, old
///              one emptied — verified live on Base) can never orphan it.
///           2. Every token balance sitting on the holder is attributable to
///              exactly one vault position: deposit refunds, rewards paid on
///              close, and keeper-pushed leftovers all become that position's
///              idle funds instead of unattributable dust on a shared adapter.
///
/// @dev Holds no logic beyond a gated call forwarder. The adapter is set once
///      by the deployer (the adapter itself, in the same tx as the clone) and
///      can never change. Revert data from the target is bubbled verbatim so
///      engine errors (e.g. MinimumHoldTimeNotMet) surface unchanged.
contract PositionHolder {
    /// @notice The only address allowed to execute calls through this holder.
    address public adapter;

    error AlreadyInitialized();
    error OnlyAdapter();

    /// @notice One-shot initialization; called by the adapter right after
    ///         cloning. Reverts if already initialized.
    function init(address adapter_) external {
        if (adapter != address(0)) revert AlreadyInitialized();
        adapter = adapter_;
    }

    /// @notice Execute an arbitrary call as this holder. Only the adapter may
    ///         call; revert data from the target is bubbled verbatim.
    /// @param target Contract to call (engine or ERC20 token).
    /// @param data   Calldata to forward.
    /// @return result Raw return data from the target.
    function exec(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != adapter) revert OnlyAdapter();
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) {
            // Bubble the target's revert data verbatim.
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}
