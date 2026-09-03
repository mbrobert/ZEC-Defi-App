// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILPAdapter, LpParams} from "./interfaces/ILPAdapter.sol";

/// @title PositionVault — per-user LP strategy positions on Base.
///
/// @notice Receives capital that was borrowed on Rhea Finance (NEAR) and
///         delivered to Base via NEAR Intents, then deposits it into a
///         MaxFi/SnuggleFi concentrated-liquidity position through a thin
///         protocol adapter with the exact parameters the user selected.
///
///         Design rules:
///           • The vault NEVER re-implements LP logic — adapters translate to
///             the live MaxFi/SnuggleFi contracts.
///           • Users always retain the unilateral right to withdraw their own
///             position to their own address, even when paused.
///           • The operator (off-chain agent) can open/increase positions and
///             trigger claims, but can never move user principal to an
///             arbitrary address.
contract PositionVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum RewardPreference {
        COMPOUND,
        SEND_TO_ZCASH
    }

    /// @notice Who funded an increase — surfaced on PositionIncreased so
    ///         incident response can tell operator top-ups, router compounds
    ///         and owner deposits apart.
    enum IncreaseSource {
        OPERATOR,
        ROUTER,
        OWNER
    }

    struct Position {
        address owner; // Base address controlling the position
        address adapter; // whitelisted ILPAdapter
        bytes32 poolKey; // engine pool registry key (ISnuggleVault.approvedPools)
        address token; // entry asset (USDC / cbBTC / WETH)
        uint256 shares; // adapter accounting shares
        LpParams params;
        RewardPreference rewardPref;
        string zcashAddress; // native ZEC destination for rewards (t-addr / UA)
        uint64 createdAt;
        bool active;
    }

    // ---------------------------------------------------------------- state

    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) private _positionsByOwner;

    mapping(address => bool) public operators;
    mapping(address => bool) public allowedAdapters;
    mapping(address => bool) public allowedTokens;
    address public rewardRouter;

    /// @notice Per-pool, per-entry-token exposure cap (raw token units).
    ///         0 = unlimited. Keyed by token because a pool admits multiple
    ///         entry assets (USDC / cbBTC / WETH) whose raw units do not share
    ///         a scale — a single-slot cap would be either a DoS for one token
    ///         or ineffective for the other. Bounds how large a fraction of
    ///         any single pool the protocol can take, limiting
    ///         price-impact/slippage and concentration risk.
    mapping(bytes32 => mapping(address => uint256)) public maxDepositPerPool;
    /// @notice Current tracked principal deployed into each pool, per entry token.
    mapping(bytes32 => mapping(address => uint256)) public poolExposure;

    /// @notice Last operator-initiated touch (increase/consolidate) per
    ///         position. Every engine deposit restarts the engine's 60s
    ///         minimum-hold clock and withdraw must close all of them, so
    ///         un-throttled operator deposits could hold a position's exit
    ///         clock fresh forever. See OPERATOR_TOUCH_COOLDOWN.
    mapping(uint256 => uint256) public lastOperatorTouch;

    /// @notice Minimum spacing between operator-initiated increases /
    ///         consolidations of one position. Bounds exit-delay griefing by a
    ///         compromised or over-eager operator to at most one engine-hold
    ///         window (60s) per hour. Owner- and router-initiated paths are
    ///         unaffected.
    uint256 public constant OPERATOR_TOUCH_COOLDOWN = 1 hours;
    /// @notice Operator increases must move at least principal / this — a
    ///         1-wei top-up exists only to restart the engine hold clock.
    uint256 public constant MIN_OPERATOR_INCREASE_DIVISOR = 1000;

    // ---------------------------------------------------------------- events

    event OperatorSet(address indexed operator, bool allowed);
    event AdapterAllowed(address indexed adapter, bool allowed);
    event TokenAllowed(address indexed token, bool allowed);
    event RewardRouterSet(address indexed router);
    event MaxDepositPerPoolSet(bytes32 indexed poolKey, address indexed token, uint256 cap);

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        address indexed adapter,
        bytes32 poolKey,
        address token,
        uint256 amount,
        uint256 shares,
        LpParams params,
        RewardPreference rewardPref,
        string zcashAddress
    );
    event PositionIncreased(
        uint256 indexed positionId, uint256 amount, uint256 sharesAdded, IncreaseSource source
    );
    /// @param out0 token0 paid to `recipient`.
    /// @param out1 token1 paid to `recipient`.
    /// @param rewards Sum of forwarded incentive-token units (per-token detail
    ///        is in the withdraw return data; v1 configures a single incentive
    ///        token, AERO).
    event PositionWithdrawn(
        uint256 indexed positionId,
        uint256 shareBps,
        address recipient,
        bool closed,
        uint256 out0,
        uint256 out1,
        uint256 rewards
    );
    event RewardsClaimed(uint256 indexed positionId, address recipient);
    event PositionConsolidated(uint256 indexed positionId, uint256 enginePositions);
    event RewardPreferenceSet(
        uint256 indexed positionId, RewardPreference rewardPref, string zcashAddress
    );

    // ---------------------------------------------------------------- errors

    error NotOperator();
    error NotRewardRouter();
    error NotPositionOwner();
    error AdapterNotAllowed(address adapter);
    error TokenNotAllowed(address token);
    error PositionNotActive(uint256 positionId);
    error InvalidAmount();
    error InvalidShareBps();
    error InvalidLpParams();
    error PoolExposureCapExceeded(bytes32 poolKey, address token, uint256 attempted, uint256 cap);
    error ZcashAddressRequired();
    error InsufficientIdleBalance(address token, uint256 wanted, uint256 available);
    error ZeroAddress();
    error OperatorIncreaseTooSmall(uint256 positionId, uint256 amount, uint256 minAmount);
    error OperatorCooldownActive(uint256 positionId, uint256 availableAt);

    // ------------------------------------------------------------- modifiers

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyRewardRouter() {
        if (msg.sender != rewardRouter) revert NotRewardRouter();
        _;
    }

    modifier onlyPositionOwner(uint256 positionId) {
        if (positions[positionId].owner != msg.sender) revert NotPositionOwner();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ----------------------------------------------------------------- admin

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setAdapterAllowed(address adapter, bool allowed) external onlyOwner {
        allowedAdapters[adapter] = allowed;
        emit AdapterAllowed(adapter, allowed);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setRewardRouter(address router) external onlyOwner {
        rewardRouter = router;
        emit RewardRouterSet(router);
    }

    /// @notice Set the per-pool exposure cap for one entry token (raw units of
    ///         `token`, 0 = unlimited). Caps for different entry tokens of the
    ///         same pool are independent — raw USDC/cbBTC/WETH units do not
    ///         share a scale.
    function setMaxDepositPerPool(bytes32 poolKey, address token, uint256 cap)
        external
        onlyOwner
    {
        maxDepositPerPool[poolKey][token] = cap;
        emit MaxDepositPerPoolSet(poolKey, token, cap);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------ open paths

    /// @notice Operator opens a position for `user` using capital that arrived
    ///         at the vault from the NEAR Intents bridge leg.
    /// @dev Funds must already sit at the vault (bridge `recipient` = vault).
    function openFor(
        address user,
        address adapter,
        bytes32 poolKey,
        address token,
        uint256 amount,
        LpParams calldata params,
        RewardPreference rewardPref,
        string calldata zcashAddress
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 positionId) {
        uint256 idle = IERC20(token).balanceOf(address(this));
        if (amount > idle) revert InsufficientIdleBalance(token, amount, idle);
        positionId =
            _open(user, adapter, poolKey, token, amount, params, rewardPref, zcashAddress);
    }

    /// @notice A user who already holds the entry asset on Base opens directly.
    function openSelf(
        address adapter,
        bytes32 poolKey,
        address token,
        uint256 amount,
        LpParams calldata params,
        RewardPreference rewardPref,
        string calldata zcashAddress
    ) external whenNotPaused nonReentrant returns (uint256 positionId) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        positionId =
            _open(msg.sender, adapter, poolKey, token, amount, params, rewardPref, zcashAddress);
    }

    function _open(
        address user,
        address adapter,
        bytes32 poolKey,
        address token,
        uint256 amount,
        LpParams calldata params,
        RewardPreference rewardPref,
        string calldata zcashAddress
    ) internal returns (uint256 positionId) {
        // A zero owner would create a position nobody can ever withdraw —
        // there is deliberately no owner-reassignment path.
        if (user == address(0)) revert ZeroAddress();
        if (!allowedAdapters[adapter]) revert AdapterNotAllowed(adapter);
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert InvalidAmount();
        // Engine accepts ~0.01%..50% widths; bound delay to keep positions manageable.
        if (params.rangeWidthBps < 10 || params.rangeWidthBps > 5000) revert InvalidLpParams();
        if (params.rebalanceDelay > 30 days) revert InvalidLpParams();
        _addExposure(poolKey, token, amount);
        if (rewardPref == RewardPreference.SEND_TO_ZCASH && bytes(zcashAddress).length == 0) {
            revert ZcashAddressRequired();
        }

        positionId = nextPositionId++;

        IERC20(token).forceApprove(adapter, amount);
        uint256 shares = ILPAdapter(adapter).open(positionId, poolKey, token, amount, params);
        IERC20(token).forceApprove(adapter, 0);

        positions[positionId] = Position({
            owner: user,
            adapter: adapter,
            poolKey: poolKey,
            token: token,
            shares: shares,
            params: params,
            rewardPref: rewardPref,
            zcashAddress: zcashAddress,
            createdAt: uint64(block.timestamp),
            active: true
        });
        _positionsByOwner[user].push(positionId);

        emit PositionOpened(
            positionId,
            user,
            adapter,
            poolKey,
            token,
            amount,
            shares,
            params,
            rewardPref,
            zcashAddress
        );
    }

    // ------------------------------------------------------------- lifecycle

    /// @notice Add capital to an existing position. Callable by the operator
    ///         (bridge-delivered funds idle at vault), by the RewardRouter
    ///         (compounding claimed rewards it holds), or by the owner.
    /// @dev Every engine deposit restarts the engine's 60s minimum-hold clock
    ///      and withdraw must close all engine positions, so operator-initiated
    ///      increases are throttled (min size + cooldown) to bound exit-delay
    ///      griefing. Owner and router paths are unaffected: the owner only
    ///      delays themselves, and the router moves the owner's own claimed
    ///      rewards (a zero claim reverts before reaching here).
    function increase(uint256 positionId, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 sharesAdded)
    {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        if (amount == 0) revert InvalidAmount();

        IncreaseSource source;
        if (msg.sender == rewardRouter) {
            source = IncreaseSource.ROUTER;
            IERC20(p.token).safeTransferFrom(msg.sender, address(this), amount);
        } else if (msg.sender == p.owner) {
            source = IncreaseSource.OWNER;
            IERC20(p.token).safeTransferFrom(msg.sender, address(this), amount);
        } else if (operators[msg.sender]) {
            source = IncreaseSource.OPERATOR;
            uint256 minAmount = p.shares / MIN_OPERATOR_INCREASE_DIVISOR;
            if (amount < minAmount) {
                revert OperatorIncreaseTooSmall(positionId, amount, minAmount);
            }
            _checkAndTouchOperatorCooldown(positionId);
            uint256 idle = IERC20(p.token).balanceOf(address(this));
            if (amount > idle) revert InsufficientIdleBalance(p.token, amount, idle);
        } else {
            revert NotOperator();
        }

        _addExposure(p.poolKey, p.token, amount);
        IERC20(p.token).forceApprove(p.adapter, amount);
        sharesAdded = ILPAdapter(p.adapter).increase(positionId, p.token, amount);
        IERC20(p.token).forceApprove(p.adapter, 0);
        p.shares += sharesAdded;

        emit PositionIncreased(positionId, amount, sharesAdded, source);
    }

    /// @notice Withdraw `shareBps` (1..10_000) of the position. Underlying
    ///         tokens are sent by the adapter straight to `recipient`.
    /// @dev Intentionally NOT gated by `whenNotPaused` — exit is always open.
    ///      `recipient` lets the owner direct funds to a NEAR Intents deposit
    ///      address when routing back to native ZEC.
    /// @param deadline Latest acceptable execution time (0 = adapter default
    ///        window from now). Bounds how stale a queued withdraw may be when
    ///        it lands — the close/re-deposit executes at the landing price.
    function withdraw(
        uint256 positionId,
        uint256 shareBps,
        address recipient,
        uint256 minOut0,
        uint256 minOut1,
        uint256 deadline
    )
        external
        onlyPositionOwner(positionId)
        nonReentrant
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        // WETH9 (and others) do not revert on transfer to address(0) — a
        // zeroed recipient would burn the payout.
        if (recipient == address(0)) revert ZeroAddress();
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        if (shareBps == 0 || shareBps > 10_000) revert InvalidShareBps();

        uint256 sharesBefore = p.shares;
        (tokens, amounts) = ILPAdapter(p.adapter).withdraw(
            positionId, shareBps, recipient, minOut0, minOut1, deadline
        );

        uint256 remaining = ILPAdapter(p.adapter).shares(positionId);
        p.shares = remaining;
        // Release the freed capital from this pool's exposure budget.
        uint256 freed = sharesBefore > remaining ? sharesBefore - remaining : 0;
        if (freed > 0) {
            poolExposure[p.poolKey][p.token] = poolExposure[p.poolKey][p.token] > freed
                ? poolExposure[p.poolKey][p.token] - freed
                : 0;
        }
        // Closed only when nothing remains ANYWHERE: no accounting shares, no
        // live engine positions, no idle holder balances. A rounding remainder
        // must never leave live value behind a position flagged closed.
        bool closed = remaining == 0;
        if (closed) {
            (uint256 idle0, uint256 idle1) = ILPAdapter(p.adapter).idleOf(positionId);
            closed = ILPAdapter(p.adapter).tokenCount(positionId) == 0 && idle0 == 0 && idle1 == 0;
        }
        if (closed) p.active = false;

        uint256 rewards;
        for (uint256 i = 2; i < amounts.length; i++) {
            rewards += amounts[i];
        }
        emit PositionWithdrawn(
            positionId, shareBps, recipient, closed, amounts[0], amounts[1], rewards
        );
    }

    /// @notice Collapse a position's accumulated engine positions into one.
    /// @dev Each increase/compound mints a fresh engine position; left to grow
    ///      they hit the adapter's per-position cap and further increases and
    ///      compounds revert. The operator calls this to restore headroom. It
    ///      moves no value and cannot change ownership, principal, or payout
    ///      routing — so it is safe for the semi-trusted operator to trigger and
    ///      needs no reward-router / owner gating. It DOES restart the engine's
    ///      60s minimum-hold clock on the whole position, so it shares the
    ///      operator cooldown with increase — an operator racing the owner's
    ///      withdraw can delay the exit at most once per cooldown window. Exit
    ///      stays open: even if this were never called, the owner can always
    ///      withdraw (which itself consolidates to one position).
    /// @param deadline Latest acceptable execution time (0 = adapter default
    ///        window from now), passed to the engine re-deposit.
    function consolidate(uint256 positionId, uint256 deadline)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        returns (uint256 count)
    {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        _checkAndTouchOperatorCooldown(positionId);
        count = ILPAdapter(p.adapter).consolidate(positionId, deadline);
        // Keep vault share bookkeeping in lockstep with the adapter's principal.
        p.shares = ILPAdapter(p.adapter).shares(positionId);
        emit PositionConsolidated(positionId, count);
    }

    /// @notice RewardRouter pulls accrued rewards; adapter pays the router.
    function claimTo(uint256 positionId, address recipient)
        external
        onlyRewardRouter
        whenNotPaused
        nonReentrant
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        (tokens, amounts) = ILPAdapter(p.adapter).claim(positionId, recipient);
        emit RewardsClaimed(positionId, recipient);
    }

    /// @notice Position owner claims their own accrued rewards directly to
    ///         `recipient` — matched pool tokens and incentive tokens alike —
    ///         bypassing the router and the stored reward preference.
    /// @dev Intentionally NOT gated by `whenNotPaused` and not operator-gated:
    ///      like principal withdrawal, reward access is a user right that must
    ///      survive a paused vault or a dead agent.
    function claimSelf(uint256 positionId, address recipient)
        external
        onlyPositionOwner(positionId)
        nonReentrant
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (recipient == address(0)) revert ZeroAddress();
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        (tokens, amounts) = ILPAdapter(p.adapter).claim(positionId, recipient);
        emit RewardsClaimed(positionId, recipient);
    }

    /// @notice Position owner updates what happens to rewards.
    function setRewardPreference(
        uint256 positionId,
        RewardPreference rewardPref,
        string calldata zcashAddress
    ) external onlyPositionOwner(positionId) {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        if (rewardPref == RewardPreference.SEND_TO_ZCASH && bytes(zcashAddress).length == 0) {
            revert ZcashAddressRequired();
        }
        p.rewardPref = rewardPref;
        p.zcashAddress = zcashAddress;
        emit RewardPreferenceSet(positionId, rewardPref, zcashAddress);
    }

    // ----------------------------------------------------------------- views

    function _addExposure(bytes32 poolKey, address token, uint256 amount) internal {
        uint256 cap = maxDepositPerPool[poolKey][token];
        uint256 next = poolExposure[poolKey][token] + amount;
        if (cap != 0 && next > cap) revert PoolExposureCapExceeded(poolKey, token, next, cap);
        poolExposure[poolKey][token] = next;
    }

    /// @dev Operator-initiated increase/consolidate throttle (see
    ///      OPERATOR_TOUCH_COOLDOWN). First touch of a position is free.
    function _checkAndTouchOperatorCooldown(uint256 positionId) internal {
        uint256 last = lastOperatorTouch[positionId];
        if (last != 0 && block.timestamp < last + OPERATOR_TOUCH_COOLDOWN) {
            revert OperatorCooldownActive(positionId, last + OPERATOR_TOUCH_COOLDOWN);
        }
        lastOperatorTouch[positionId] = block.timestamp;
    }

    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _positionsByOwner[owner];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
