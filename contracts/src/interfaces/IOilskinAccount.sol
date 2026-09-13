// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One external call the account makes on someone's behalf.
/// @dev `callback` is the PERIPHERAL OPT-IN. When false (the default, and what a plain transfer or
///      pool call should always use) the target is called with NO rights over the account: it cannot
///      call `execFromPeripheral` / `execNestedPeripheral` back. When true the target becomes the
///      active peripheral for the duration of the call — the router and the venues need this to make
///      the ACCOUNT the `msg.sender` at Aave / the LP engine. Only the OWNER may set it on
///      `exec` / `execBatch`; on the keeper path it comes from the grant (`Permission.allowCallback`),
///      never from the keeper.
struct Call {
    address target;
    uint256 value;
    bytes data;
    bool callback;
}

/// @notice Per-token spend budget inside a keeper grant (raw token units per period).
struct TokenLimit {
    address token;
    uint256 amountPerPeriod;
}

/// @notice What an owner lets a keeper do. One permission = one (target, selector) root call the
///         keeper may invoke, plus the budgets that bound the direct token operations that call tree
///         performs.
/// @dev `tokenLimits` is an array (the spec's singular `tokenSpendLimit` generalised): an unwind
///      approves both the debt token and the collateral token in one call tree, so one root grant
///      needs more than one token budget. A token that is not listed cannot be moved at all, and a
///      listed budget of zero is rejected at grant time (it reads as "listed" but behaves as absent).
struct Permission {
    address target;
    bytes4 selector;
    /// @dev ETH (wei) the call tree may send per period. 0 = no ETH may leave.
    uint256 maxValuePerPeriod;
    TokenLimit[] tokenLimits;
    /// @dev Budget window in seconds. Must be > 0.
    uint40 period;
    /// @dev Unix time after which the grant is dead. Must be in the future at grant time.
    uint40 expiry;
    /// @dev Whether `target` becomes the active peripheral while the keeper's root call runs.
    ///      FALSE for a grant on a token or a pool; TRUE only for a composing target such as
    ///      StrategyRouter, which must instruct the account back. The keeper cannot set this.
    bool allowCallback;
}

/// @title IOilskinAccount — the user's smart account. Owner = the user's wallet, immutable after init.
///
/// @notice Execution model (the whole security story is these four rules):
///   1. `exec` / `execBatch` are OWNER-ONLY plain CALLs. The owner can do anything from their own
///      account at any time — that is the exit guarantee.
///   2. A call grants the target NO rights over the account unless the caller sets `Call.callback`.
///      With it set, that target — and only it — may instruct the account via `execFromPeripheral` /
///      `execNestedPeripheral` while its call is running. This is how the router and the venues make
///      the ACCOUNT the `msg.sender` to Aave / the LP engine / Permit2 without ever holding funds.
///      Rights are not transitive: contracts the peripheral asks the account to call (tokens, pools)
///      get none, and nesting depth is bounded.
///   3. A keeper may only invoke a (target, selector) the owner granted, and the grant decides
///      whether that target gets peripheral rights. ETH value and the DIRECT token operations the
///      call tree performs — `transfer` / `approve` / `increaseAllowance` / `transferFrom` on the
///      token itself, and Permit2 `approve` / single `transferFrom` — are charged against the
///      grant's per-period budgets; a token with no budget cannot be moved that way. Token movers
///      the budget cannot parse (Permit2 batch `transferFrom` and `permitTransferFrom`, ERC-777
///      `send`, ERC-677 `transferAndCall`) are REFUSED outright on the keeper path rather than
///      passing free. What is NOT bounded is value moved by a protocol the call tree talks to
///      (an Aave `withdraw`, an engine withdrawal): the grant's target, and any peripheral it nests
///      into, are trusted code — which is why `allowCallback` exists and defaults to false.
///      Grants expire and can be revoked one at a time or all at once.
///   4. The account never caches a token balance across an external call, holds no admin, cannot be
///      upgraded, and has no fee logic. Peripherals are chosen per call; nothing is trusted forever.
interface IOilskinAccount {
    function owner() external view returns (address);

    /// @notice The keeper currently acting through this account, or the zero address when the call
    ///         tree was started by the owner. Transient: meaningful only DURING an `exec*` call,
    ///         which is exactly when a peripheral needs it to tell an owner's action from a
    ///         keeper's. Reads zero outside a call.
    function keeperActor() external view returns (address);

    function exec(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory result);

    /// @notice `exec`, but the target becomes the active peripheral (rule 2). Owner-only.
    function execWithCallback(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory result);

    function execBatch(Call[] calldata calls) external payable returns (bytes[] memory results);

    function execAsKeeper(Call[] calldata calls) external returns (bytes[] memory results);

    function execFromPeripheral(Call[] calldata calls) external returns (bytes[] memory results);

    function execNestedPeripheral(address peripheral, uint256 value, bytes calldata data)
        external
        returns (bytes memory result);

    function grant(address keeper, Permission calldata permission) external;

    function revoke(address keeper, address target, bytes4 selector) external;

    function revokeAll() external;

    function grantEpoch() external view returns (uint256);

    function grantOf(address keeper, address target, bytes4 selector)
        external
        view
        returns (
            bool active,
            uint256 maxValuePerPeriod,
            uint256 valueSpent,
            uint40 period,
            uint40 expiry,
            uint40 periodStart,
            bool allowCallback
        );

    /// @notice Budget and spend for one token of one grant. `spent` accounts for a period that has
    ///         already rolled, so it never over-reports what the chain would refuse.
    function tokenBudgetOf(address keeper, address target, bytes4 selector, address token)
        external
        view
        returns (uint256 amountPerPeriod, uint256 spent);

    function grantTokens(address keeper, address target, bytes4 selector)
        external
        view
        returns (address[] memory tokens);
}
