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

    /// @notice Per-pool exposure cap (entry-token units). 0 = unlimited.
    ///         Bounds how large a fraction of any single pool the protocol can
    ///         take, limiting price-impact/slippage and concentration risk.
    mapping(bytes32 => uint256) public maxDepositPerPool;
    /// @notice Current tracked principal deployed into each pool.
    mapping(bytes32 => uint256) public poolExposure;

    // ---------------------------------------------------------------- events

    event OperatorSet(address indexed operator, bool allowed);
    event AdapterAllowed(address indexed adapter, bool allowed);
    event TokenAllowed(address indexed token, bool allowed);
    event RewardRouterSet(address indexed router);
    event MaxDepositPerPoolSet(bytes32 indexed poolKey, uint256 cap);

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
    event PositionIncreased(uint256 indexed positionId, uint256 amount, uint256 sharesAdded);
    event PositionWithdrawn(
        uint256 indexed positionId, uint256 shareBps, address recipient, bool closed
    );
    event RewardsClaimed(uint256 indexed positionId, address recipient);
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
    error PoolExposureCapExceeded(bytes32 poolKey, uint256 attempted, uint256 cap);
    error ZcashAddressRequired();
    error InsufficientIdleBalance(address token, uint256 wanted, uint256 available);

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

    /// @notice Set the per-pool exposure cap (entry-token units, 0 = unlimited).
    function setMaxDepositPerPool(bytes32 poolKey, uint256 cap) external onlyOwner {
        maxDepositPerPool[poolKey] = cap;
        emit MaxDepositPerPoolSet(poolKey, cap);
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
        if (!allowedAdapters[adapter]) revert AdapterNotAllowed(adapter);
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert InvalidAmount();
        // Engine accepts ~0.01%..50% widths; bound delay to keep positions manageable.
        if (params.rangeWidthBps < 10 || params.rangeWidthBps > 5000) revert InvalidLpParams();
        if (params.rebalanceDelay > 30 days) revert InvalidLpParams();
        _addExposure(poolKey, amount);
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
    ///         (bridge-delivered funds idle at vault) or by the RewardRouter
    ///         (compounding claimed rewards it holds).
    function increase(uint256 positionId, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 sharesAdded)
    {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        if (amount == 0) revert InvalidAmount();

        if (msg.sender == rewardRouter) {
            IERC20(p.token).safeTransferFrom(msg.sender, address(this), amount);
        } else if (operators[msg.sender]) {
            uint256 idle = IERC20(p.token).balanceOf(address(this));
            if (amount > idle) revert InsufficientIdleBalance(p.token, amount, idle);
        } else if (msg.sender == p.owner) {
            IERC20(p.token).safeTransferFrom(msg.sender, address(this), amount);
        } else {
            revert NotOperator();
        }

        _addExposure(p.poolKey, amount);
        IERC20(p.token).forceApprove(p.adapter, amount);
        sharesAdded = ILPAdapter(p.adapter).increase(positionId, p.token, amount);
        IERC20(p.token).forceApprove(p.adapter, 0);
        p.shares += sharesAdded;

        emit PositionIncreased(positionId, amount, sharesAdded);
    }

    /// @notice Withdraw `shareBps` (1..10_000) of the position. Underlying
    ///         tokens are sent by the adapter straight to `recipient`.
    /// @dev Intentionally NOT gated by `whenNotPaused` — exit is always open.
    ///      `recipient` lets the owner direct funds to a NEAR Intents deposit
    ///      address when routing back to native ZEC.
    function withdraw(
        uint256 positionId,
        uint256 shareBps,
        address recipient,
        uint256 minOut0,
        uint256 minOut1
    )
        external
        onlyPositionOwner(positionId)
        nonReentrant
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        Position storage p = positions[positionId];
        if (!p.active) revert PositionNotActive(positionId);
        if (shareBps == 0 || shareBps > 10_000) revert InvalidShareBps();

        uint256 sharesBefore = p.shares;
        (tokens, amounts) =
            ILPAdapter(p.adapter).withdraw(positionId, shareBps, recipient, minOut0, minOut1);

        uint256 remaining = ILPAdapter(p.adapter).shares(positionId);
        p.shares = remaining;
        // Release the freed capital from this pool's exposure budget.
        uint256 freed = sharesBefore > remaining ? sharesBefore - remaining : 0;
        if (freed > 0) {
            poolExposure[p.poolKey] = poolExposure[p.poolKey] > freed
                ? poolExposure[p.poolKey] - freed
                : 0;
        }
        bool closed = remaining == 0;
        if (closed) p.active = false;

        emit PositionWithdrawn(positionId, shareBps, recipient, closed);
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

    function _addExposure(bytes32 poolKey, uint256 amount) internal {
        uint256 cap = maxDepositPerPool[poolKey];
        uint256 next = poolExposure[poolKey] + amount;
        if (cap != 0 && next > cap) revert PoolExposureCapExceeded(poolKey, next, cap);
        poolExposure[poolKey] = next;
    }

    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _positionsByOwner[owner];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
