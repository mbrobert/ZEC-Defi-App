// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title RewardRouter — claims LP rewards and executes the user's preference.
///
/// @notice Two paths:
///           • COMPOUND — matching-token rewards are re-deposited into the LP
///             position via the vault (increases shares).
///           • SEND_TO_ZCASH — matching-token rewards are transferred to a
///             NEAR Intents 1-Click deposit address; the intent converts and
///             delivers native ZEC to the user's Zcash wallet.
///
/// @dev Trust note (documented in docs/RISKS.md): the contract cannot verify
///      on-chain that a 1-Click deposit address corresponds to a quote whose
///      recipient is the position's stored Zcash address. Mitigations:
///        • only the operator can route, and only for positions whose owner
///          selected SEND_TO_ZCASH;
///        • the position's zcashAddress and the agent-computed quote hash are
///          emitted for out-of-band auditability;
///        • per-token per-tx routing caps limit blast radius;
///        • reward flows only — principal never passes through this contract.
contract RewardRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    PositionVault public immutable vault;

    mapping(address => bool) public operators;
    /// @notice Max amount of `token` routable to an intents address per tx (0 = disabled).
    mapping(address => uint256) public maxRoutePerTx;

    event OperatorSet(address indexed operator, bool allowed);
    event MaxRoutePerTxSet(address indexed token, uint256 amount);
    event Compounded(
        uint256 indexed positionId, address indexed token, uint256 amount, uint256 sharesAdded
    );
    event RewardsRouted(
        uint256 indexed positionId,
        address indexed token,
        uint256 amount,
        address indexed intentsDepositAddress,
        string zcashAddress,
        bytes32 quoteHash
    );
    event UnmatchedReward(uint256 indexed positionId, address indexed token, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    error NotOperator();
    error WrongPreference();
    error NothingClaimed();
    error RouteCapExceeded(address token, uint256 amount, uint256 cap);
    error RoutingDisabled(address token);
    error ZeroAddress();

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    constructor(address initialOwner, PositionVault _vault) Ownable(initialOwner) {
        vault = _vault;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setMaxRoutePerTx(address token, uint256 amount) external onlyOwner {
        maxRoutePerTx[token] = amount;
        emit MaxRoutePerTxSet(token, amount);
    }

    /// @notice Claim rewards for `positionId` and compound the matching token
    ///         back into the position. Non-matching reward tokens are held
    ///         here and surfaced via `UnmatchedReward` for a later sweep/swap.
    function compound(uint256 positionId)
        external
        onlyOperator
        nonReentrant
        returns (uint256 compoundedAmount, uint256 sharesAdded)
    {
        PositionVault.Position memory p = vault.getPosition(positionId);
        (address[] memory tokens, uint256[] memory amounts) =
            vault.claimTo(positionId, address(this));

        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) continue;
            if (tokens[i] == p.token) {
                compoundedAmount += amounts[i];
            } else {
                emit UnmatchedReward(positionId, tokens[i], amounts[i]);
            }
        }
        if (compoundedAmount == 0) revert NothingClaimed();

        IERC20(p.token).forceApprove(address(vault), compoundedAmount);
        sharesAdded = vault.increase(positionId, compoundedAmount);
        IERC20(p.token).forceApprove(address(vault), 0);

        emit Compounded(positionId, p.token, compoundedAmount, sharesAdded);
    }

    /// @notice Claim rewards and send the matching token to a NEAR Intents
    ///         1-Click deposit address for conversion + delivery as native ZEC.
    /// @param intentsDepositAddress Deposit address returned by the 1-Click
    ///        quote whose recipient is the position's Zcash address.
    /// @param quoteHash keccak256 over the canonical quote fields (computed by
    ///        the agent) binding this route to an auditable off-chain quote.
    function routeToZcash(uint256 positionId, address intentsDepositAddress, bytes32 quoteHash)
        external
        onlyOperator
        nonReentrant
        returns (uint256 routedAmount)
    {
        if (intentsDepositAddress == address(0)) revert ZeroAddress();
        PositionVault.Position memory p = vault.getPosition(positionId);
        if (p.rewardPref != PositionVault.RewardPreference.SEND_TO_ZCASH) {
            revert WrongPreference();
        }

        (address[] memory tokens, uint256[] memory amounts) =
            vault.claimTo(positionId, address(this));

        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) continue;
            if (tokens[i] == p.token) {
                routedAmount += amounts[i];
            } else {
                emit UnmatchedReward(positionId, tokens[i], amounts[i]);
            }
        }
        if (routedAmount == 0) revert NothingClaimed();

        uint256 cap = maxRoutePerTx[p.token];
        if (cap == 0) revert RoutingDisabled(p.token);
        if (routedAmount > cap) revert RouteCapExceeded(p.token, routedAmount, cap);

        IERC20(p.token).safeTransfer(intentsDepositAddress, routedAmount);

        emit RewardsRouted(
            positionId, p.token, routedAmount, intentsDepositAddress, p.zcashAddress, quoteHash
        );
    }

    /// @notice Owner can sweep stuck non-matching reward tokens (e.g. to swap
    ///         and redistribute). Never holds user principal.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
