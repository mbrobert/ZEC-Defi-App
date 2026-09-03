// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ILPAdapter, LpParams} from "../interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../interfaces/ISnuggleVault.sol";
import {PositionHolder} from "./PositionHolder.sol";

/// @title SnuggleAdapter — thin translator to the real Snuggle/MaxFi engine.
///
/// @notice One deployment per LP engine instance (MaxFi and SnuggleFi run the
///         same SnuggleVaultUpgradeable code; two adapter deployments point at
///         their respective proxies). Translation notes, matching the REAL ABI:
///
///   • Every vault positionId owns a dedicated PositionHolder (EIP-1167
///     clone). The HOLDER is the engine-side owner of that position's
///     tokenIds, so the live tokenId set is always
///     `engine.userPositions(holder)` — resolved fresh on every withdraw,
///     consolidate, claim and view. The engine's keeper rebalance RE-KEYS
///     positions (mints a new tokenId, empties the old — verified live on
///     Base), so persisted tokenIds go stale; live resolution survives any
///     number of re-keys.
///   • The holder's entire token balances are attributable to its one
///     position: deposit refunds (the engine returns un-fitting leftovers of
///     both tokens in the deposit tx), rewards paid on close, and keeper
///     pushes all become that position's idle funds — folded into the next
///     re-deposit and included in withdrawal payouts, never swept anywhere.
///   • open/increase → `depositSingleSided` (engine pulls via transferFrom
///     from the holder). Each increase creates an additional engine tokenId
///     under the same vault positionId — the engine has no in-place increase.
///   • withdraw(shareBps) → the engine only closes whole positions, so we
///     close ALL live tokenIds, pay `recipient` its share of both pool tokens
///     (idle included), and re-deposit the remainder as one fresh position
///     with the original parameters. Configured incentive-token balances
///     (e.g. AERO — staked Aerodrome positions pay AERO on close) are
///     forwarded to `recipient` in full.
///   • claim → claimStakingRewards (staked) with harvest fallback; pool-token
///     proceeds arrive by transfer from the engine (net of its 15%
///     performance fee) and are measured by balance-diff over the holder;
///     incentive tokens are forwarded by full holder balance.
///   • inRange → engine-tracked `outOfRangeSince == 0` for every LIVE tokenId.
///   • `referral` locks per holder on its first deposit; route it to the
///     protocol treasury.
///   • token0/token1 are captured into Meta at open; the exit path never
///     re-reads the engine's pool registry, so a registry re-layout or
///     corruption cannot brick withdrawals.
contract SnuggleAdapter is ILPAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault; // our PositionVault
    ISnuggleVault public immutable engine; // MaxFi / SnuggleFi proxy
    address public immutable referral;
    address public immutable owner; // ops config (reward token list)
    /// @notice PositionHolder logic contract all per-position clones point at.
    address public immutable holderImplementation;

    uint256 public constant DEADLINE_WINDOW = 15 minutes;
    /// @notice Cap on engine positions per vault position — withdraw/claim
    ///         iterate them, so unbounded growth would gas-DoS the exit path.
    uint256 public constant MAX_ENGINE_POSITIONS = 16;
    /// @notice Remainders below this many raw token units are paid out (or
    ///         left idle on consolidate) instead of re-deposited: the engine's
    ///         CL pools revert on zero-liquidity mints, and dust re-deposits
    ///         could otherwise strand a "closed" position with a live
    ///         engine id behind it.
    uint256 public constant DUST_THRESHOLD = 1e3;

    struct Meta {
        bytes32 poolKey;
        LpParams params;
        uint256 principal; // accounting shares
        address token0; // captured at open — exit path never reads the registry
        address token1;
        bytes32 idsHash; // last observed live engine-id set (event dedupe)
    }

    /// @notice Per-position engine account (EIP-1167 PositionHolder clone).
    mapping(uint256 => address) public holderOf;
    mapping(uint256 => Meta) public metaOf;
    /// @notice Incentive tokens (e.g. AERO) swept during claims, per adapter.
    address[] public rewardTokens;

    event HolderDeployed(uint256 indexed positionId, address holder);
    event EngineTokenObserved(uint256 indexed positionId, uint256 indexed tokenId);
    event Redeposited(uint256 indexed positionId, uint256 amt0, uint256 amt1);
    event RewardTokensSet(address[] tokens);
    /// @notice An incentive token could not be forwarded (misconfigured or
    ///         reverting token contract). The balance stays on the position's
    ///         holder — recoverable once the reward token list is fixed.
    event RewardForwardSkipped(uint256 indexed positionId, address indexed token);

    error OnlyVault();
    error OnlyOwner();
    error UnknownPosition(uint256 positionId);
    error AlreadyOpen(uint256 positionId);
    error PoolInactive(bytes32 poolKey);
    error TokenNotInPool(address token, bytes32 poolKey);
    error TooManyEnginePositions(uint256 positionId);
    error SlippageExceeded(uint256 out0, uint256 out1, uint256 min0, uint256 min1);
    error DeadlineExpired(uint256 deadline);
    error ERC20CallFailed(address token);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address _vault, ISnuggleVault _engine, address _referral, address _owner) {
        vault = _vault;
        engine = _engine;
        referral = _referral;
        owner = _owner;
        holderImplementation = address(new PositionHolder());
    }

    /// @notice Owner sets the incentive tokens (e.g. AERO) watched and
    ///         forwarded on claim/withdraw.
    function setRewardTokens(address[] calldata tokens) external {
        if (msg.sender != owner) revert OnlyOwner();
        rewardTokens = tokens;
        emit RewardTokensSet(tokens);
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
        if (holderOf[positionId] != address(0)) revert AlreadyOpen(positionId);
        (address t0, address t1) = _validatePoolToken(poolKey, token);

        address holder = Clones.clone(holderImplementation);
        PositionHolder(holder).init(address(this));
        holderOf[positionId] = holder;
        emit HolderDeployed(positionId, holder);

        metaOf[positionId] = Meta({
            poolKey: poolKey,
            params: params,
            principal: 0,
            token0: t0,
            token1: t1,
            idsHash: bytes32(0)
        });
        IERC20(token).safeTransferFrom(vault, holder, amount);
        _depositSingleSided(positionId, holder, token, amount, block.timestamp + DEADLINE_WINDOW);
        return metaOf[positionId].principal;
    }

    /// @inheritdoc ILPAdapter
    function increase(uint256 positionId, address token, uint256 amount)
        external
        onlyVault
        returns (uint256)
    {
        address holder = holderOf[positionId];
        if (holder == address(0)) revert UnknownPosition(positionId);
        _validatePoolToken(metaOf[positionId].poolKey, token);
        IERC20(token).safeTransferFrom(vault, holder, amount);
        _depositSingleSided(positionId, holder, token, amount, block.timestamp + DEADLINE_WINDOW);
        return amount;
    }

    /// @dev Deposit `amount` of `token` (already sitting on the holder) into
    ///      the engine as the holder. Any refund the engine returns in the
    ///      deposit tx stays on the holder as this position's idle balance.
    function _depositSingleSided(
        uint256 positionId,
        address holder,
        address token,
        uint256 amount,
        uint256 deadline
    ) internal {
        if (_liveIds(positionId).length >= MAX_ENGINE_POSITIONS) {
            revert TooManyEnginePositions(positionId);
        }
        Meta storage m = metaOf[positionId];
        _erc20Exec(holder, token, abi.encodeCall(IERC20.approve, (address(engine), amount)));
        PositionHolder(holder).exec(
            address(engine),
            abi.encodeCall(
                ISnuggleVault.depositSingleSided,
                (
                    m.poolKey,
                    token,
                    amount,
                    m.params.rangeWidthBps,
                    m.params.rebalanceDelay,
                    true, // autoSnuggle: engine-managed repositioning is the point
                    m.params.autoCompound,
                    deadline,
                    referral
                )
            )
        );
        _erc20Exec(holder, token, abi.encodeCall(IERC20.approve, (address(engine), 0)));
        m.principal += amount;
        _observeLiveIds(positionId);
    }

    // -------------------------------------------------------------- withdraw

    /// @inheritdoc ILPAdapter
    function withdraw(
        uint256 positionId,
        uint256 shareBps,
        address recipient,
        uint256 minOut0,
        uint256 minOut1,
        uint256 deadline
    ) external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        address holder = holderOf[positionId];
        if (holder == address(0)) revert UnknownPosition(positionId);
        deadline = _effectiveDeadline(deadline);
        Meta storage m = metaOf[positionId];
        (address token0, address token1) = (m.token0, m.token1);

        // Close every LIVE engine position (survives keeper re-keys); the
        // engine pays this position's holder, close-time rewards included.
        uint256[] memory ids = _observeLiveIds(positionId);
        for (uint256 i = 0; i < ids.length; i++) {
            PositionHolder(holder).exec(
                address(engine), abi.encodeCall(ISnuggleVault.withdraw, (ids[i], false))
            );
        }

        // The holder's ENTIRE balances are this position's: close proceeds,
        // idle deposit refunds, and anything pushed between our transactions.
        uint256 got0 = IERC20(token0).balanceOf(holder);
        uint256 got1 = IERC20(token1).balanceOf(holder);

        // Pay out the requested share.
        uint256 out0 = (got0 * shareBps) / 10_000;
        uint256 out1 = (got1 * shareBps) / 10_000;
        uint256 keep0 = got0 - out0;
        uint256 keep1 = got1 - out1;
        // Below-dust remainders are paid out instead of re-deposited so a
        // rounding remainder can never leave a live engine position behind a
        // closed vault position (and never trips the engine's zero-liquidity
        // guard). Rounding favours the recipient, never the protocol.
        if (keep0 < DUST_THRESHOLD) {
            out0 = got0;
            keep0 = 0;
        }
        if (keep1 < DUST_THRESHOLD) {
            out1 = got1;
            keep1 = 0;
        }
        // Slippage floor: protects the recipient from MEV sandwiching the
        // engine close and from unexpectedly deep price impact on large exits.
        if (out0 < minOut0 || out1 < minOut1) revert SlippageExceeded(out0, out1, minOut0, minOut1);
        if (out0 > 0) _erc20Exec(holder, token0, abi.encodeCall(IERC20.transfer, (recipient, out0)));
        if (out1 > 0) _erc20Exec(holder, token1, abi.encodeCall(IERC20.transfer, (recipient, out1)));

        // Re-deposit the remainder as one fresh position. Fork-verified nuance:
        // the engine's dual deposit mints zero liquidity (and the CL pool
        // reverts) when one side is 0 — a closed position that never left its
        // single-sided range returns exactly one token. Branch accordingly.
        if (keep0 > 0 || keep1 > 0) {
            _redeposit(positionId, holder, keep0, keep1, deadline);
            m.principal = (m.principal * (10_000 - shareBps)) / 10_000;
        } else {
            m.principal = 0;
        }

        // Forward the position's full incentive-token balances (staked
        // Aerodrome positions pay AERO on close — those are the owner's).
        (tokens, amounts) =
            _payoutArraysWithRewards(positionId, holder, token0, token1, recipient, out0, out1);
    }

    // ----------------------------------------------------------- consolidate

    /// @inheritdoc ILPAdapter
    /// @dev Closes every live engine tokenId and re-deposits 100% of the
    ///      proceeds — idle refund balances folded in — as a single fresh
    ///      position with the original parameters. Pays nothing out; principal
    ///      is unchanged (only the engine-position COUNT drops). Below-dust
    ///      legs stay on the holder as idle rather than forcing a
    ///      zero-liquidity dual mint. Incentive tokens paid on close stay on
    ///      the holder, attributed to this position, until the next
    ///      claim/withdraw forwards them.
    function consolidate(uint256 positionId, uint256 deadline)
        external
        onlyVault
        returns (uint256 count)
    {
        address holder = holderOf[positionId];
        if (holder == address(0)) revert UnknownPosition(positionId);
        deadline = _effectiveDeadline(deadline);
        Meta storage m = metaOf[positionId];

        uint256[] memory ids = _observeLiveIds(positionId);
        // Nothing to collapse and no idle to fold; leave the position untouched.
        if (
            ids.length <= 1 && IERC20(m.token0).balanceOf(holder) == 0
                && IERC20(m.token1).balanceOf(holder) == 0
        ) {
            return ids.length;
        }

        for (uint256 i = 0; i < ids.length; i++) {
            PositionHolder(holder).exec(
                address(engine), abi.encodeCall(ISnuggleVault.withdraw, (ids[i], false))
            );
        }
        uint256 keep0 = IERC20(m.token0).balanceOf(holder);
        uint256 keep1 = IERC20(m.token1).balanceOf(holder);
        if (keep0 < DUST_THRESHOLD) keep0 = 0;
        if (keep1 < DUST_THRESHOLD) keep1 = 0;
        if (keep0 > 0 || keep1 > 0) {
            _redeposit(positionId, holder, keep0, keep1, deadline);
        }
        // principal (m.principal) is deliberately unchanged: consolidation moves
        // no value, it only re-shapes engine bookkeeping.
        return _liveIds(positionId).length;
    }

    /// @dev Re-deposit `keep0`/`keep1` from the holder as one fresh engine
    ///      position with the original parameters. Callers guarantee each
    ///      nonzero leg is >= DUST_THRESHOLD.
    function _redeposit(
        uint256 positionId,
        address holder,
        uint256 keep0,
        uint256 keep1,
        uint256 deadline
    ) internal {
        Meta storage m = metaOf[positionId];
        if (keep0 > 0 && keep1 > 0) {
            _erc20Exec(holder, m.token0, abi.encodeCall(IERC20.approve, (address(engine), keep0)));
            _erc20Exec(holder, m.token1, abi.encodeCall(IERC20.approve, (address(engine), keep1)));
            PositionHolder(holder).exec(
                address(engine),
                abi.encodeCall(
                    ISnuggleVault.deposit,
                    (
                        m.poolKey,
                        keep0,
                        keep1,
                        m.params.rangeWidthBps,
                        m.params.rebalanceDelay,
                        true,
                        m.params.autoCompound,
                        deadline,
                        referral
                    )
                )
            );
            _erc20Exec(holder, m.token0, abi.encodeCall(IERC20.approve, (address(engine), 0)));
            _erc20Exec(holder, m.token1, abi.encodeCall(IERC20.approve, (address(engine), 0)));
        } else {
            (address tok, uint256 amt) = keep0 > 0 ? (m.token0, keep0) : (m.token1, keep1);
            _erc20Exec(holder, tok, abi.encodeCall(IERC20.approve, (address(engine), amt)));
            PositionHolder(holder).exec(
                address(engine),
                abi.encodeCall(
                    ISnuggleVault.depositSingleSided,
                    (
                        m.poolKey,
                        tok,
                        amt,
                        m.params.rangeWidthBps,
                        m.params.rebalanceDelay,
                        true,
                        m.params.autoCompound,
                        deadline,
                        referral
                    )
                )
            );
            _erc20Exec(holder, tok, abi.encodeCall(IERC20.approve, (address(engine), 0)));
        }
        emit Redeposited(positionId, keep0, keep1);
        _observeLiveIds(positionId);
    }

    // ----------------------------------------------------------------- claim

    /// @inheritdoc ILPAdapter
    function claim(uint256 positionId, address recipient)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        address holder = holderOf[positionId];
        if (holder == address(0)) revert UnknownPosition(positionId);
        Meta storage m = metaOf[positionId];

        // Pool tokens by balance-diff — the position's idle principal (deposit
        // refunds) must NOT leak into the reward path. Incentive tokens by
        // FULL balance below: anything of theirs on the holder is rewards,
        // including amounts the engine/keeper pushed between our calls.
        uint256 before0 = IERC20(m.token0).balanceOf(holder);
        uint256 before1 = IERC20(m.token1).balanceOf(holder);

        uint256[] memory ids = _observeLiveIds(positionId);
        for (uint256 i = 0; i < ids.length; i++) {
            // Staked positions must use claimStakingRewards; unstaked use
            // harvest. Try the staking path first, fall back to harvest.
            try PositionHolder(holder).exec(
                address(engine), abi.encodeCall(ISnuggleVault.claimStakingRewards, (ids[i]))
            ) {} catch {
                PositionHolder(holder).exec(
                    address(engine), abi.encodeCall(ISnuggleVault.harvest, (ids[i]))
                );
            }
        }

        uint256 got0 = IERC20(m.token0).balanceOf(holder) - before0;
        uint256 got1 = IERC20(m.token1).balanceOf(holder) - before1;
        if (got0 > 0) _erc20Exec(holder, m.token0, abi.encodeCall(IERC20.transfer, (recipient, got0)));
        if (got1 > 0) _erc20Exec(holder, m.token1, abi.encodeCall(IERC20.transfer, (recipient, got1)));
        (tokens, amounts) =
            _payoutArraysWithRewards(positionId, holder, m.token0, m.token1, recipient, got0, got1);
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
    function idleOf(uint256 positionId) public view returns (uint256 amt0, uint256 amt1) {
        address holder = holderOf[positionId];
        if (holder == address(0)) return (0, 0);
        Meta storage m = metaOf[positionId];
        amt0 = IERC20(m.token0).balanceOf(holder);
        amt1 = IERC20(m.token1).balanceOf(holder);
    }

    /// @inheritdoc ILPAdapter
    /// @dev Resolved against LIVE engine ids, so a keeper re-key can never
    ///      make a wound-down or re-keyed position read as "in range".
    function inRange(uint256 positionId) external view returns (bool) {
        if (holderOf[positionId] == address(0)) return false;
        uint256[] memory ids = _liveIds(positionId);
        for (uint256 i = 0; i < ids.length; i++) {
            (,,,,,,,,, uint64 outOfRangeSince,,,,,,,) = engine.positions(ids[i]);
            if (outOfRangeSince != 0) return false;
        }
        return ids.length > 0;
    }

    /// @notice Number of LIVE engine positions backing `positionId`, resolved
    ///         from the engine (survives keeper re-keys).
    function tokenCount(uint256 positionId) external view returns (uint256) {
        if (holderOf[positionId] == address(0)) return 0;
        return _liveIds(positionId).length;
    }

    /// @notice Live engine tokenId at `index` for `positionId`. Kept
    ///         signature-compatible with the previous persisted-mapping getter
    ///         but always resolved from the engine.
    function tokenIdsOf(uint256 positionId, uint256 index) external view returns (uint256) {
        return _liveIds(positionId)[index];
    }

    /// @inheritdoc ILPAdapter
    function poolTokensOf(uint256 positionId) external view returns (address, address) {
        Meta storage m = metaOf[positionId];
        return (m.token0, m.token1);
    }

    // -------------------------------------------------------------- internal

    /// @dev The live engine tokenId set for a position = the engine's own view
    ///      of its holder's positions. Bounded so the exit path stays within
    ///      gas; unreachable in practice (deposits are capped and keeper
    ///      rebalances replace ids 1:1).
    function _liveIds(uint256 positionId) internal view returns (uint256[] memory ids) {
        ids = engine.userPositions(holderOf[positionId]);
        if (ids.length > MAX_ENGINE_POSITIONS) revert TooManyEnginePositions(positionId);
    }

    /// @dev Mutating flows resolve live ids through this so newly appeared ids
    ///      (engine deposits, keeper re-keys) are surfaced via
    ///      EngineTokenObserved exactly when the set changes.
    function _observeLiveIds(uint256 positionId) internal returns (uint256[] memory ids) {
        ids = _liveIds(positionId);
        bytes32 h = keccak256(abi.encodePacked(ids));
        Meta storage m = metaOf[positionId];
        if (m.idsHash != h) {
            m.idsHash = h;
            for (uint256 i = 0; i < ids.length; i++) {
                emit EngineTokenObserved(positionId, ids[i]);
            }
        }
    }

    /// @dev 0 = default window from now; anything in the past reverts so a
    ///      stale queued tx cannot close/re-mint at whatever price it lands on.
    function _effectiveDeadline(uint256 deadline) internal view returns (uint256) {
        if (deadline == 0) return block.timestamp + DEADLINE_WINDOW;
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        return deadline;
    }

    /// @dev SafeERC20-equivalent for calls executed AS the holder: bubbles
    ///      reverts (via PositionHolder.exec) and rejects a false return from
    ///      non-reverting ERC20s.
    function _erc20Exec(address holder, address token, bytes memory data) internal {
        bytes memory ret = PositionHolder(holder).exec(token, data);
        if (ret.length > 0 && !abi.decode(ret, (bool))) revert ERC20CallFailed(token);
    }

    /// @dev Builds the (tokens, amounts) return arrays — slots 0/1 are the
    ///      pool tokens with the amounts already paid — and forwards the
    ///      holder's FULL balance of every configured incentive token to
    ///      `recipient` (slots 2+).
    ///
    ///      Incentive forwarding is deliberately NON-BLOCKING: rewardTokens is
    ///      owner-set and sits on the withdraw path, so a misconfigured or
    ///      reverting token contract must not be able to brick the
    ///      always-open exit. A failed forward is skipped and surfaced via
    ///      RewardForwardSkipped; the balance stays on the holder, still
    ///      attributed to the position and recoverable once the list is
    ///      fixed. Pool-token payouts (principal) above remain strict.
    function _payoutArraysWithRewards(
        uint256 positionId,
        address holder,
        address token0,
        address token1,
        address recipient,
        uint256 out0,
        uint256 out1
    ) internal returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory watch = _watchList(token0, token1);
        tokens = watch;
        amounts = new uint256[](watch.length);
        amounts[0] = out0;
        amounts[1] = out1;
        for (uint256 i = 2; i < watch.length; i++) {
            if (watch[i].code.length == 0) {
                emit RewardForwardSkipped(positionId, watch[i]);
                continue;
            }
            try IERC20(watch[i]).balanceOf(holder) returns (uint256 bal) {
                if (bal == 0) continue;
                try PositionHolder(holder).exec(
                    watch[i], abi.encodeCall(IERC20.transfer, (recipient, bal))
                ) returns (bytes memory ret) {
                    // Accept empty returns and any nonzero word; reject a
                    // zero word (transfer() == false) without decode-reverts.
                    if (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (uint256)) != 0))
                    {
                        amounts[i] = bal;
                    } else {
                        emit RewardForwardSkipped(positionId, watch[i]);
                    }
                } catch {
                    emit RewardForwardSkipped(positionId, watch[i]);
                }
            } catch {
                emit RewardForwardSkipped(positionId, watch[i]);
            }
        }
    }

    function _validatePoolToken(bytes32 poolKey, address token)
        internal
        view
        returns (address t0, address t1)
    {
        bool active;
        (, t0, t1,,, active,,) = engine.approvedPools(poolKey);
        if (!active) revert PoolInactive(poolKey);
        if (token != t0 && token != t1) revert TokenNotInPool(token, poolKey);
    }

    /// @dev token0/token1 always occupy slots 0/1; reward tokens are appended
    ///      ONLY if distinct from the pool tokens and from each other. Without
    ///      this dedupe, a reward token that equals a pool token would appear
    ///      twice in the watch list and the second balance-diff in `claim`
    ///      would underflow (the first occurrence already transferred the gain
    ///      out), reverting every claim for that position until reconfigured.
    function _watchList(address token0, address token1)
        internal
        view
        returns (address[] memory watch)
    {
        address[] memory tmp = new address[](2 + rewardTokens.length);
        tmp[0] = token0;
        tmp[1] = token1;
        uint256 n = 2;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address rt = rewardTokens[i];
            bool seen = false;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == rt) {
                    seen = true;
                    break;
                }
            }
            if (!seen) {
                tmp[n] = rt;
                n++;
            }
        }
        watch = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            watch[i] = tmp[i];
        }
    }
}
