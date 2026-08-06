// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILPAdapter, LpParams} from "../interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../interfaces/ISnuggleVault.sol";

/// @title SnuggleAdapter — thin translator to the real Snuggle/MaxFi engine.
///
/// @notice One deployment per LP engine instance (MaxFi and SnuggleFi run the
///         same SnuggleVaultUpgradeable code; two adapter deployments point at
///         their respective proxies). Translation notes, matching the REAL ABI:
///
///   • open/increase → `depositSingleSided` (engine pulls via transferFrom).
///     Each increase creates an additional engine tokenId under the same
///     vault positionId — the engine has no in-place increase.
///   • withdraw(shareBps) → the engine only closes whole positions, so we
///     close ALL tokenIds, pay `recipient` its share of both pool tokens by
///     balance-diff, and re-deposit the remainder dual-sided as one fresh
///     position with the original parameters.
///   • claim → claimStakingRewards (staked) with harvest fallback; proceeds
///     arrive by transfer from the engine (net of its 15% performance fee),
///     measured by balance-diff over token0/token1 + configured rewardTokens.
///   • inRange → engine-tracked `outOfRangeSince == 0` for every tokenId.
///   • `referral` is set once per adapter (engine locks referrer on first
///     deposit); route it to the protocol treasury.
contract SnuggleAdapter is ILPAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault; // our PositionVault
    ISnuggleVault public immutable engine; // MaxFi / SnuggleFi proxy
    address public immutable referral;
    address public immutable owner; // ops config (reward token list)

    uint256 public constant DEADLINE_WINDOW = 15 minutes;
    /// @notice Cap on engine positions per vault position — withdraw/claim
    ///         iterate them, so unbounded growth would gas-DoS the exit path.
    uint256 public constant MAX_ENGINE_POSITIONS = 16;

    struct Meta {
        bytes32 poolKey;
        LpParams params;
        uint256 principal; // accounting shares
    }

    mapping(uint256 => uint256[]) public tokenIdsOf; // vault positionId → engine tokenIds
    mapping(uint256 => Meta) public metaOf;
    /// @notice Incentive tokens (e.g. AERO) swept during claims, per adapter.
    address[] public rewardTokens;

    error OnlyVault();
    error OnlyOwner();
    error UnknownPosition(uint256 positionId);
    error AlreadyOpen(uint256 positionId);
    error PoolInactive(bytes32 poolKey);
    error TokenNotInPool(address token, bytes32 poolKey);
    error TooManyEnginePositions(uint256 positionId);
    error SlippageExceeded(uint256 out0, uint256 out1, uint256 min0, uint256 min1);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address _vault, ISnuggleVault _engine, address _referral, address _owner) {
        vault = _vault;
        engine = _engine;
        referral = _referral;
        owner = _owner;
    }

    function setRewardTokens(address[] calldata tokens) external {
        if (msg.sender != owner) revert OnlyOwner();
        rewardTokens = tokens;
    }

    // ------------------------------------------------------------------ open

    /// @inheritdoc ILPAdapter
    function open(
        uint256 positionId,
        bytes32 poolKey,
        address token,
        uint256 amount,
        LpParams calldata params
    ) external onlyVault returns (uint256) {
        if (tokenIdsOf[positionId].length != 0) revert AlreadyOpen(positionId);
        _validatePoolToken(poolKey, token);

        metaOf[positionId] =
            Meta({poolKey: poolKey, params: params, principal: 0});
        _depositSingleSided(positionId, token, amount);
        return metaOf[positionId].principal;
    }

    /// @inheritdoc ILPAdapter
    function increase(uint256 positionId, address token, uint256 amount)
        external
        onlyVault
        returns (uint256)
    {
        if (tokenIdsOf[positionId].length == 0) revert UnknownPosition(positionId);
        _validatePoolToken(metaOf[positionId].poolKey, token);
        _depositSingleSided(positionId, token, amount);
        return amount;
    }

    function _depositSingleSided(uint256 positionId, address token, uint256 amount) internal {
        if (tokenIdsOf[positionId].length >= MAX_ENGINE_POSITIONS) {
            revert TooManyEnginePositions(positionId);
        }
        Meta storage m = metaOf[positionId];
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        IERC20(token).forceApprove(address(engine), amount);
        uint256 tokenId = engine.depositSingleSided(
            m.poolKey,
            token,
            amount,
            m.params.rangeWidthBps,
            m.params.rebalanceDelay,
            true, // autoSnuggle: engine-managed repositioning is the point
            m.params.autoCompound,
            block.timestamp + DEADLINE_WINDOW,
            referral
        );
        IERC20(token).forceApprove(address(engine), 0);
        tokenIdsOf[positionId].push(tokenId);
        m.principal += amount;
    }

    // -------------------------------------------------------------- withdraw

    /// @inheritdoc ILPAdapter
    function withdraw(
        uint256 positionId,
        uint256 shareBps,
        address recipient,
        uint256 minOut0,
        uint256 minOut1
    ) external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        uint256[] storage ids = tokenIdsOf[positionId];
        if (ids.length == 0) revert UnknownPosition(positionId);
        Meta storage m = metaOf[positionId];
        (address token0, address token1) = _poolTokens(m.poolKey);

        // Close everything; engine pays this adapter.
        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));
        for (uint256 i = 0; i < ids.length; i++) {
            engine.withdraw(ids[i], false);
        }
        delete tokenIdsOf[positionId];
        uint256 got0 = IERC20(token0).balanceOf(address(this)) - bal0Before;
        uint256 got1 = IERC20(token1).balanceOf(address(this)) - bal1Before;

        // Pay out the requested share.
        uint256 out0 = (got0 * shareBps) / 10_000;
        uint256 out1 = (got1 * shareBps) / 10_000;
        // Slippage floor: protects the recipient from MEV sandwiching the
        // engine close and from unexpectedly deep price impact on large exits.
        if (out0 < minOut0 || out1 < minOut1) revert SlippageExceeded(out0, out1, minOut0, minOut1);
        if (out0 > 0) IERC20(token0).safeTransfer(recipient, out0);
        if (out1 > 0) IERC20(token1).safeTransfer(recipient, out1);

        // Re-deposit the remainder as one fresh position. Fork-verified nuance:
        // the engine's dual deposit mints zero liquidity (and the CL pool
        // reverts) when one side is 0 — a closed position that never left its
        // single-sided range returns exactly one token. Branch accordingly.
        uint256 keep0 = got0 - out0;
        uint256 keep1 = got1 - out1;
        if (keep0 > 0 && keep1 > 0) {
            IERC20(token0).forceApprove(address(engine), keep0);
            IERC20(token1).forceApprove(address(engine), keep1);
            uint256 newId = engine.deposit(
                m.poolKey,
                keep0,
                keep1,
                m.params.rangeWidthBps,
                m.params.rebalanceDelay,
                true,
                m.params.autoCompound,
                block.timestamp + DEADLINE_WINDOW,
                referral
            );
            IERC20(token0).forceApprove(address(engine), 0);
            IERC20(token1).forceApprove(address(engine), 0);
            tokenIdsOf[positionId].push(newId);
        } else if (keep0 > 0 || keep1 > 0) {
            (address tok, uint256 amt) = keep0 > 0 ? (token0, keep0) : (token1, keep1);
            IERC20(tok).forceApprove(address(engine), amt);
            uint256 newId = engine.depositSingleSided(
                m.poolKey,
                tok,
                amt,
                m.params.rangeWidthBps,
                m.params.rebalanceDelay,
                true,
                m.params.autoCompound,
                block.timestamp + DEADLINE_WINDOW,
                referral
            );
            IERC20(tok).forceApprove(address(engine), 0);
            tokenIdsOf[positionId].push(newId);
        }

        m.principal = (m.principal * (10_000 - shareBps)) / 10_000;

        tokens = new address[](2);
        amounts = new uint256[](2);
        (tokens[0], tokens[1], amounts[0], amounts[1]) = (token0, token1, out0, out1);
    }

    // ----------------------------------------------------------------- claim

    /// @inheritdoc ILPAdapter
    function claim(uint256 positionId, address recipient)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256[] storage ids = tokenIdsOf[positionId];
        if (ids.length == 0) revert UnknownPosition(positionId);
        (address token0, address token1) = _poolTokens(metaOf[positionId].poolKey);

        address[] memory watch = _watchList(token0, token1);
        uint256[] memory before = new uint256[](watch.length);
        for (uint256 i = 0; i < watch.length; i++) {
            before[i] = IERC20(watch[i]).balanceOf(address(this));
        }

        for (uint256 i = 0; i < ids.length; i++) {
            // Staked positions must use claimStakingRewards; unstaked use
            // harvest. Try the staking path first, fall back to harvest.
            try engine.claimStakingRewards(ids[i]) returns (uint256) {}
            catch {
                engine.harvest(ids[i]);
            }
        }

        tokens = watch;
        amounts = new uint256[](watch.length);
        for (uint256 i = 0; i < watch.length; i++) {
            uint256 gained = IERC20(watch[i]).balanceOf(address(this)) - before[i];
            amounts[i] = gained;
            if (gained > 0) IERC20(watch[i]).safeTransfer(recipient, gained);
        }
    }

    // ----------------------------------------------------------------- views

    /// @inheritdoc ILPAdapter
    function pendingRewards(uint256)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        // The engine exposes no pending-fee views (only lifetime cumulative
        // counters). Off-chain estimation feeds the claim decision instead.
        return (new address[](0), new uint256[](0));
    }

    /// @inheritdoc ILPAdapter
    function shares(uint256 positionId) external view returns (uint256) {
        return metaOf[positionId].principal;
    }

    /// @inheritdoc ILPAdapter
    function inRange(uint256 positionId) external view returns (bool) {
        uint256[] storage ids = tokenIdsOf[positionId];
        for (uint256 i = 0; i < ids.length; i++) {
            (,,,,,,,,, uint64 outOfRangeSince,,,,,,,) = engine.positions(ids[i]);
            if (outOfRangeSince != 0) return false;
        }
        return ids.length > 0;
    }

    function tokenCount(uint256 positionId) external view returns (uint256) {
        return tokenIdsOf[positionId].length;
    }

    /// @inheritdoc ILPAdapter
    function poolTokensOf(uint256 positionId) external view returns (address, address) {
        return _poolTokens(metaOf[positionId].poolKey);
    }

    // -------------------------------------------------------------- internal

    function _poolTokens(bytes32 poolKey) internal view returns (address t0, address t1) {
        (, t0, t1,,,,,) = engine.approvedPools(poolKey);
    }

    function _validatePoolToken(bytes32 poolKey, address token) internal view {
        (, address t0, address t1,,, bool active,,) = engine.approvedPools(poolKey);
        if (!active) revert PoolInactive(poolKey);
        if (token != t0 && token != t1) revert TokenNotInPool(token, poolKey);
    }

    function _watchList(address token0, address token1)
        internal
        view
        returns (address[] memory watch)
    {
        watch = new address[](2 + rewardTokens.length);
        watch[0] = token0;
        watch[1] = token1;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            watch[2 + i] = rewardTokens[i];
        }
    }
}
