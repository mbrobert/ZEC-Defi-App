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

    /// @notice Rewards held here on behalf of a position's owner: claimed
    ///         tokens that did not match the position's entry token (e.g. AERO
    ///         from a staked Aerodrome position) and matched amounts above the
    ///         per-tx routing cap awaiting the next route. A claim is never
    ///         reverted just because nothing matched — that would roll the
    ///         engine claim back and leave the rewards unreachable forever.
    mapping(uint256 => mapping(address => uint256)) internal heldRewards;
    /// @notice Total `heldRewards` per token — the slice of this contract's
    ///         balance that belongs to position owners and can NOT be rescued.
    mapping(address => uint256) public totalHeld;

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
    event RewardHeld(uint256 indexed positionId, address indexed token, uint256 amount);
    event UnmatchedClaimed(
        uint256 indexed positionId, address indexed token, address indexed recipient, uint256 amount
    );
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    error NotOperator();
    error NotPositionOwner();
    error WrongPreference();
    error NothingClaimed();
    error NothingHeld(uint256 positionId, address token);
    error RoutingDisabled(address token);
    error ZeroAddress();
    error RescueExceedsUserHeld(address token, uint256 requested, uint256 rescuable);

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
    ///         here for the position owner (`unmatchedOf` / `claimUnmatched`)
    ///         and surfaced via `UnmatchedReward`.
    /// @dev Never reverts after a successful claim just because nothing
    ///      matched: Aerodrome-gauge positions pay AERO only, and a revert
    ///      would roll the engine claim back — leaving the rewards unreachable
    ///      through this path forever. Returns (0, 0) in that case.
    function compound(uint256 positionId)
        external
        onlyOperator
        nonReentrant
        returns (uint256 compoundedAmount, uint256 sharesAdded)
    {
        PositionVault.Position memory p = vault.getPosition(positionId);
        (address[] memory tokens, uint256[] memory amounts) =
            vault.claimTo(positionId, address(this));

        uint256 totalClaimed;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) continue;
            totalClaimed += amounts[i];
            if (tokens[i] == p.token) {
                compoundedAmount += amounts[i];
            } else {
                _holdForOwner(positionId, tokens[i], amounts[i]);
                emit UnmatchedReward(positionId, tokens[i], amounts[i]);
            }
        }
        if (compoundedAmount == 0) {
            // A truly empty claim is a no-op worth surfacing loudly; an
            // unmatched-only claim is held for the owner and must stand.
            if (totalClaimed == 0) revert NothingClaimed();
            return (0, 0);
        }

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

        uint256 totalClaimed;
        uint256 claimedMatched;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) continue;
            totalClaimed += amounts[i];
            if (tokens[i] == p.token) {
                claimedMatched += amounts[i];
            } else {
                _holdForOwner(positionId, tokens[i], amounts[i]);
                emit UnmatchedReward(positionId, tokens[i], amounts[i]);
            }
        }

        // Route what fits under the per-tx cap and HOLD the remainder for the
        // next route — an accrual larger than the cap must never deadlock the
        // position (the claim would be rolled back atomically, forever).
        uint256 available = claimedMatched + heldRewards[positionId][p.token];
        if (available == 0) {
            if (totalClaimed == 0) revert NothingClaimed();
            return 0; // unmatched-only claim: held for the owner, must stand
        }
        uint256 cap = maxRoutePerTx[p.token];
        if (cap == 0) revert RoutingDisabled(p.token);
        routedAmount = available > cap ? cap : available;

        uint256 remainder = available - routedAmount;
        uint256 prevHeld = heldRewards[positionId][p.token];
        if (remainder != prevHeld) {
            heldRewards[positionId][p.token] = remainder;
            totalHeld[p.token] = totalHeld[p.token] + remainder - prevHeld;
            if (remainder > prevHeld) emit RewardHeld(positionId, p.token, remainder - prevHeld);
        }

        IERC20(p.token).safeTransfer(intentsDepositAddress, routedAmount);

        emit RewardsRouted(
            positionId, p.token, routedAmount, intentsDepositAddress, p.zcashAddress, quoteHash
        );
    }

    /// @notice Rewards held here for `positionId`'s owner in `token`:
    ///         unmatched claim proceeds plus matched amounts above the routing
    ///         cap awaiting the next route.
    function unmatchedOf(uint256 positionId, address token) external view returns (uint256) {
        return heldRewards[positionId][token];
    }

    /// @notice Position owner withdraws rewards held here for their position
    ///         (e.g. AERO that did not match the entry token). Owner-gated by
    ///         POSITION ownership, not contract ownership — held rewards are
    ///         the user's, reachable without any operator.
    function claimUnmatched(uint256 positionId, address token, address recipient)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (vault.getPosition(positionId).owner != msg.sender) revert NotPositionOwner();
        amount = heldRewards[positionId][token];
        if (amount == 0) revert NothingHeld(positionId, token);
        heldRewards[positionId][token] = 0;
        totalHeld[token] -= amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit UnmatchedClaimed(positionId, token, recipient, amount);
    }

    /// @dev Account claim proceeds that belong to a position's owner but
    ///      cannot be compounded/routed as-is.
    function _holdForOwner(uint256 positionId, address token, uint256 amount) internal {
        heldRewards[positionId][token] += amount;
        totalHeld[token] += amount;
    }

    /// @notice Owner can sweep tokens that arrived OUTSIDE the per-position
    ///         held-reward accounting (mistaken direct transfers). The slice
    ///         tracked in `totalHeld` belongs to position owners and is out of
    ///         the admin's reach — only `claimUnmatched` can move it.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 held = totalHeld[token];
        uint256 rescuable = bal > held ? bal - held : 0;
        if (amount > rescuable) revert RescueExceedsUserHeld(token, amount, rescuable);
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
