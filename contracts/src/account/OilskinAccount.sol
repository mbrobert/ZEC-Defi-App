// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {Call, IOilskinAccount, Permission, TokenLimit} from "../interfaces/IOilskinAccount.sol";

/// @title OilskinAccount — EIP-1167 clone per user; the user's wallet is the immutable owner.
///
/// @notice See IOilskinAccount for the four rules. Implementation notes:
///   • All per-call context (reentrancy lock, actor, active peripheral, root grant) lives in
///     TRANSIENT storage (EIP-1153) so nothing about a call survives the transaction.
///   • Revert data from any failed call is bubbled untouched so keepers and the UI see the real
///     venue / engine error, never a wrapper.
///   • The implementation contract is bricked at construction (`owner = address(1)`); only clones
///     initialise, and only through the factory that deployed them, exactly once.
///   • Keeper budgets are enforced from CALLDATA (the amounts the account is asked to transfer /
///     approve), never from balance snapshots — a rebasing token (cbZEC B20) cannot fool them, and
///     the account never reads a balance across an external call.
contract OilskinAccount is IOilskinAccount, IERC721Receiver, IERC1155Receiver {
    // ---------------------------------------------------------------- immutables

    /// @notice The factory that clones and initialises accounts.
    address public immutable FACTORY;
    /// @notice Canonical Permit2 — its `approve` / `transferFrom` are counted as token operations.
    address public immutable PERMIT2;

    // ------------------------------------------------------------------- storage

    /// @inheritdoc IOilskinAccount
    address public override owner;
    /// @inheritdoc IOilskinAccount
    uint256 public override grantEpoch;

    struct GrantData {
        uint256 maxValuePerPeriod;
        uint256 valueSpent;
        uint256 epoch;
        uint40 period;
        uint40 expiry;
        uint40 periodStart;
        address[] tokens;
        mapping(address => uint256) tokenLimit;
        mapping(address => uint256) tokenSpent;
    }

    mapping(bytes32 => GrantData) internal _grants;

    // ---------------------------------------------------------- transient slots

    // Transient (EIP-1153) slots — labelled hashes so they cannot collide with the storage layout.
    uint256 private constant T_LOCK = uint256(keccak256("oilskin.account.transient.lock")) - 1;
    uint256 private constant T_ACTOR = uint256(keccak256("oilskin.account.transient.actor")) - 1;
    uint256 private constant T_ACTIVE = uint256(keccak256("oilskin.account.transient.active")) - 1;
    uint256 private constant T_ROOT = uint256(keccak256("oilskin.account.transient.root")) - 1;

    // ------------------------------------------------------------------ limits

    /// @notice Hard cap on token budgets per grant — bounds the period-roll loop.
    uint256 public constant MAX_TOKEN_LIMITS = 8;

    // ERC-20 / Permit2 selectors the budget logic recognises as token operations.
    bytes4 private constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant SEL_INCREASE_ALLOWANCE =
        bytes4(keccak256("increaseAllowance(address,uint256)"));
    bytes4 private constant SEL_TRANSFER_FROM =
        bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant SEL_PERMIT2_APPROVE =
        bytes4(keccak256("approve(address,address,uint160,uint48)"));
    bytes4 private constant SEL_PERMIT2_TRANSFER_FROM =
        bytes4(keccak256("transferFrom(address,address,uint160,address)"));

    // ------------------------------------------------------------------ events

    event Initialized(address indexed owner);
    /// @notice Every call that left the account. `actor` is who instructed it: the owner, a keeper,
    ///         or the active peripheral.
    event Executed(address indexed actor, address indexed target, uint256 value, bytes4 selector);
    event Granted(
        address indexed keeper,
        address indexed target,
        bytes4 indexed selector,
        uint40 expiry,
        uint40 period,
        uint256 maxValuePerPeriod
    );
    event Revoked(address indexed keeper, address indexed target, bytes4 indexed selector);
    event AllGrantsRevoked(uint256 epoch);
    /// @notice A keeper call tree consumed budget. `token == address(0)` is ETH value.
    event KeeperSpend(address indexed keeper, address indexed token, uint256 amount);

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotFactory();
    error AlreadyInitialized();
    error ZeroOwner();
    error Reentrancy();
    error NotActivePeripheral();
    error NotGranted(address keeper, address target, bytes4 selector);
    error InvalidPermission();
    error ValueBudgetExceeded(uint256 wanted, uint256 remaining);
    error TokenNotBudgeted(address token);
    error TokenBudgetExceeded(address token, uint256 wanted, uint256 remaining);

    // -------------------------------------------------------------- construction

    constructor(address factory, address permit2) {
        FACTORY = factory;
        PERMIT2 = permit2;
        owner = address(1); // brick the implementation; clones start at owner == 0
    }

    /// @notice One-time initialiser called by the factory. `initialCalls` run as the owner in the
    ///         same transaction (the factory only forwards them when `msg.sender == owner_`).
    /// @dev Invariant: an account is initialised exactly once and only by FACTORY.
    function initialize(address owner_, Call[] calldata initialCalls)
        external
        payable
        returns (bytes[] memory results)
    {
        if (msg.sender != FACTORY) revert NotFactory();
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        emit Initialized(owner_);
        if (initialCalls.length != 0) {
            _lock();
            _tstore(T_ACTOR, 0);
            results = _runRootCalls(initialCalls, owner_, false);
            _unlock();
        }
    }

    // ------------------------------------------------------------- owner surface

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: only the owner can call; the target becomes the active peripheral for the
    ///      duration of the call; revert data is bubbled.
    function exec(address target, uint256 value, bytes calldata data)
        external
        payable
        override
        returns (bytes memory result)
    {
        if (msg.sender != owner) revert NotOwner();
        _lock();
        _tstore(T_ACTOR, 0);
        result = _callAsRoot(target, value, data, msg.sender);
        _unlock();
    }

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: only the owner; each call's target is the active peripheral while it runs.
    function execBatch(Call[] calldata calls)
        external
        payable
        override
        returns (bytes[] memory results)
    {
        if (msg.sender != owner) revert NotOwner();
        _lock();
        _tstore(T_ACTOR, 0);
        results = _runRootCalls(calls, msg.sender, false);
        _unlock();
    }

    // ------------------------------------------------------------ keeper surface

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: every call must match an active grant for `msg.sender`; ETH value and token
    ///      operations in the WHOLE call tree of call i are charged to grant i's budgets; nothing
    ///      outside a budget can move.
    function execAsKeeper(Call[] calldata calls) external override returns (bytes[] memory results) {
        _lock();
        _tstore(T_ACTOR, uint256(uint160(msg.sender)));
        results = _runRootCalls(calls, msg.sender, true);
        _tstore(T_ACTOR, 0);
        _unlock();
    }

    // -------------------------------------------------------- peripheral surface

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: only the currently active peripheral, only while an exec is in flight; the
    ///      targets called here get NO callback rights; keeper budgets apply if a keeper is the actor.
    function execFromPeripheral(Call[] calldata calls)
        external
        override
        returns (bytes[] memory results)
    {
        _requireActivePeripheral();
        bool keeper = _tload(T_ACTOR) != 0;
        bytes32 root = bytes32(_tload(T_ROOT));
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            if (keeper) _charge(root, c.target, c.value, c.data);
            results[i] = _rawCall(c.target, c.value, c.data);
            emit Executed(msg.sender, c.target, c.value, _selector(c.data));
        }
    }

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: only the active peripheral; `peripheral` becomes the active peripheral for the
    ///      nested call and the caller is restored afterwards (a bounded, explicit delegation of
    ///      callback rights — how the router composes venues).
    function execNestedPeripheral(address peripheral, uint256 value, bytes calldata data)
        external
        override
        returns (bytes memory result)
    {
        _requireActivePeripheral();
        bool keeper = _tload(T_ACTOR) != 0;
        if (keeper) _charge(bytes32(_tload(T_ROOT)), peripheral, value, data);
        address previous = msg.sender;
        _tstore(T_ACTIVE, uint256(uint160(peripheral)));
        result = _rawCall(peripheral, value, data);
        _tstore(T_ACTIVE, uint256(uint160(previous)));
        emit Executed(msg.sender, peripheral, value, _selector(data));
    }

    // ------------------------------------------------------------------ grants

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: owner-only; overwrites any existing grant for the same (keeper, target,
    ///      selector) and resets its spend; a token budget must be listed to be spendable.
    function grant(address keeper, Permission calldata p) external override {
        if (msg.sender != owner) revert NotOwner();
        if (
            keeper == address(0) || p.target == address(0) || p.period == 0
                || p.expiry <= block.timestamp || p.tokenLimits.length > MAX_TOKEN_LIMITS
        ) revert InvalidPermission();

        bytes32 key = _grantKey(keeper, p.target, p.selector);
        GrantData storage g = _grants[key];
        // Clear the previous token list so a re-grant cannot inherit a stale budget.
        for (uint256 i = 0; i < g.tokens.length; i++) {
            delete g.tokenLimit[g.tokens[i]];
            delete g.tokenSpent[g.tokens[i]];
        }
        delete g.tokens;

        g.maxValuePerPeriod = p.maxValuePerPeriod;
        g.valueSpent = 0;
        g.epoch = grantEpoch;
        g.period = p.period;
        g.expiry = p.expiry;
        g.periodStart = uint40(block.timestamp);
        for (uint256 i = 0; i < p.tokenLimits.length; i++) {
            TokenLimit calldata tl = p.tokenLimits[i];
            if (tl.token == address(0) || g.tokenLimit[tl.token] != 0) revert InvalidPermission();
            g.tokens.push(tl.token);
            g.tokenLimit[tl.token] = tl.amountPerPeriod;
        }
        emit Granted(keeper, p.target, p.selector, p.expiry, p.period, p.maxValuePerPeriod);
    }

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: owner-only; the grant is dead immediately.
    function revoke(address keeper, address target, bytes4 selector) external override {
        if (msg.sender != owner) revert NotOwner();
        GrantData storage g = _grants[_grantKey(keeper, target, selector)];
        g.expiry = 0;
        emit Revoked(keeper, target, selector);
    }

    /// @inheritdoc IOilskinAccount
    /// @dev Invariant: owner-only; every grant issued before this call is dead (epoch bump) — the
    ///      one-transaction kill switch for a compromised keeper key.
    function revokeAll() external override {
        if (msg.sender != owner) revert NotOwner();
        grantEpoch += 1;
        emit AllGrantsRevoked(grantEpoch);
    }

    // ------------------------------------------------------------------- views

    /// @inheritdoc IOilskinAccount
    function grantOf(address keeper, address target, bytes4 selector)
        external
        view
        override
        returns (
            bool active,
            uint256 maxValuePerPeriod,
            uint256 valueSpent,
            uint40 period,
            uint40 expiry,
            uint40 periodStart
        )
    {
        GrantData storage g = _grants[_grantKey(keeper, target, selector)];
        active = _isActive(g);
        return (active, g.maxValuePerPeriod, g.valueSpent, g.period, g.expiry, g.periodStart);
    }

    /// @inheritdoc IOilskinAccount
    function tokenBudgetOf(address keeper, address target, bytes4 selector, address token)
        external
        view
        override
        returns (uint256 amountPerPeriod, uint256 spent)
    {
        GrantData storage g = _grants[_grantKey(keeper, target, selector)];
        return (g.tokenLimit[token], g.tokenSpent[token]);
    }

    /// @inheritdoc IOilskinAccount
    function grantTokens(address keeper, address target, bytes4 selector)
        external
        view
        override
        returns (address[] memory)
    {
        return _grants[_grantKey(keeper, target, selector)].tokens;
    }

    // --------------------------------------------------------------- receivers

    /// @notice Plain ETH is always accepted (no guard: a payment must never revert).
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC721Receiver).interfaceId
            || id == type(IERC1155Receiver).interfaceId;
    }

    // ---------------------------------------------------------------- internal

    function _runRootCalls(Call[] calldata calls, address actor, bool keeper)
        internal
        returns (bytes[] memory results)
    {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            if (keeper) {
                bytes32 key = _grantKey(actor, c.target, _selector(c.data));
                GrantData storage g = _grants[key];
                if (!_isActive(g)) revert NotGranted(actor, c.target, _selector(c.data));
                _tstore(T_ROOT, uint256(key));
                _charge(key, c.target, c.value, c.data);
            }
            results[i] = _callAsRoot(c.target, c.value, c.data, actor);
        }
        if (keeper) _tstore(T_ROOT, 0);
    }

    function _callAsRoot(address target, uint256 value, bytes calldata data, address actor)
        internal
        returns (bytes memory result)
    {
        _tstore(T_ACTIVE, uint256(uint160(target)));
        result = _rawCall(target, value, data);
        _tstore(T_ACTIVE, 0);
        emit Executed(actor, target, value, _selector(data));
    }

    function _rawCall(address target, uint256 value, bytes calldata data)
        internal
        returns (bytes memory result)
    {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    /// @dev Charge ETH value and any recognised token operation in `data` to the root grant.
    function _charge(bytes32 root, address target, uint256 value, bytes calldata data) internal {
        GrantData storage g = _grants[root];
        _rollPeriod(g);
        address keeper = address(uint160(_tload(T_ACTOR)));
        if (value != 0) {
            uint256 remaining = g.maxValuePerPeriod - _min(g.valueSpent, g.maxValuePerPeriod);
            if (value > remaining) revert ValueBudgetExceeded(value, remaining);
            g.valueSpent += value;
            emit KeeperSpend(keeper, address(0), value);
        }
        (address token, uint256 amount) = _decodeTokenOp(target, data);
        if (token != address(0)) {
            uint256 limit = g.tokenLimit[token];
            if (limit == 0) revert TokenNotBudgeted(token);
            uint256 remaining = limit - _min(g.tokenSpent[token], limit);
            if (amount > remaining) revert TokenBudgetExceeded(token, amount, remaining);
            g.tokenSpent[token] += amount;
            emit KeeperSpend(keeper, token, amount);
        }
    }

    /// @dev Recognise a token operation. Returns (token, amount) or (0, 0) when `data` is not one.
    ///      Malformed calldata for a recognised selector reverts (abi.decode) — fail closed.
    function _decodeTokenOp(address target, bytes calldata data)
        internal
        view
        returns (address token, uint256 amount)
    {
        if (data.length < 4) return (address(0), 0);
        bytes4 sel = bytes4(data[:4]);
        if (target == PERMIT2) {
            if (sel == SEL_PERMIT2_APPROVE) {
                (address t,, uint160 a,) = abi.decode(data[4:], (address, address, uint160, uint48));
                return (t, uint256(a));
            }
            if (sel == SEL_PERMIT2_TRANSFER_FROM) {
                (,, uint160 a, address t) = abi.decode(data[4:], (address, address, uint160, address));
                return (t, uint256(a));
            }
            return (address(0), 0);
        }
        if (sel == SEL_TRANSFER || sel == SEL_APPROVE || sel == SEL_INCREASE_ALLOWANCE) {
            (, uint256 a) = abi.decode(data[4:], (address, uint256));
            return (target, a);
        }
        if (sel == SEL_TRANSFER_FROM) {
            (,, uint256 a) = abi.decode(data[4:], (address, address, uint256));
            return (target, a);
        }
        return (address(0), 0);
    }

    function _rollPeriod(GrantData storage g) internal {
        if (block.timestamp >= uint256(g.periodStart) + uint256(g.period)) {
            g.periodStart = uint40(block.timestamp);
            g.valueSpent = 0;
            for (uint256 i = 0; i < g.tokens.length; i++) {
                g.tokenSpent[g.tokens[i]] = 0;
            }
        }
    }

    function _isActive(GrantData storage g) internal view returns (bool) {
        return g.expiry != 0 && block.timestamp < g.expiry && g.epoch == grantEpoch;
    }

    function _requireActivePeripheral() internal view {
        if (_tload(T_LOCK) == 0) revert NotActivePeripheral();
        if (_tload(T_ACTIVE) != uint256(uint160(msg.sender))) revert NotActivePeripheral();
    }

    function _lock() internal {
        if (_tload(T_LOCK) != 0) revert Reentrancy();
        _tstore(T_LOCK, 1);
    }

    function _unlock() internal {
        _tstore(T_LOCK, 0);
    }

    function _grantKey(address keeper, address target, bytes4 selector)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(keeper, target, selector));
    }

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        return data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _tstore(uint256 slot, uint256 value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(uint256 slot) internal view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
