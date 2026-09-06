// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../interfaces/ISnuggleVault.sol";
import {IAerodromeCLPool} from "../interfaces/IAerodromeCLPool.sol";

/// @title SnuggleLpVenue — ILpVenue over the live MaxFi/Snuggle engine, positions owned by the account.
///
/// @notice Stateless and admin-free: every parameter is an immutable, every position is an engine id
///         owned by the calling account, every token movement is instructed back into that account.
///         Carries the fixes that survived the audit:
///           • C-2  index enumeration of `userPositions(address,uint256)` until the end-of-list revert.
///                  A canary probe at a far index must FAIL (an engine that answers every index is
///                  not a bounded list), and the terminating revert must be exactly `Panic(0x32)` —
///                  the only shape an array-bounds read inside a generated getter produces. A bare
///                  `revert()`, an out-of-gas or a proxy miss therefore fails CLOSED instead of
///                  truncating the list into "owns fewer positions" or "owns nothing".
///           • refund folding after EVERY engine deposit (the dual-deposit bounce is re-deposited
///                  single-sided in the same transaction; leftovers below a decimals-aware dust floor
///                  stay in the user's account — nothing is ever swept anywhere else).
///           • per-id try/catch close (`closeMany`) paying what closed — at EVERY index including the
///                  first, so an id the engine re-keyed between the keeper's read and its dispatch is
///                  reported in `failed` rather than reverting the whole protective unwind. `claim`
///                  behaves the same way and carries a price band and a deadline like every other
///                  engine-touching entry point.
///           • price band from the pool's `slot0()` on every deposit and close, failing closed when
///                  the pool cannot be read.
///           • width bounds [150, 5000] total tick span, enforced here; and a bound on the price
///                  BAND's own width, so `[1, uint160.max]` — "no band" wearing a band's clothes —
///                  is refused.
///           • ONE fee chokepoint: `claim` and `close` collect realised yield first and take
///                  `performanceBps` of it; principal is withdrawn afterwards and never touched.
///                  `performanceBps` is immutable and capped by MAX_PERFORMANCE_BPS at construction,
///                  and the cap is a real bound on what the user pays: a pool whose two tokens are
///                  the SAME token is refused on the way in, and the fee is taken once per DISTINCT
///                  token, so the chokepoint can never compound into 1-(1-p)^2.
contract SnuggleLpVenue is ILpVenue, Peripheral {
    // ---------------------------------------------------------------- config

    ISnuggleVault public immutable ENGINE;
    /// @notice Incentive token the engine pays on staked positions (AERO on Base).
    address public immutable REWARD_TOKEN;
    /// @inheritdoc ILpVenue
    address public immutable override treasury;
    /// @inheritdoc ILpVenue
    uint256 public immutable override performanceBps;

    /// @notice Hard ceiling on the performance fee. Immutable by construction (a constant).
    uint256 public constant MAX_PERFORMANCE_BPS = 2000;
    uint256 public constant BPS = 10_000;
    /// @notice Deployed engine bounds on the TOTAL tick span (FACT 3).
    uint24 public constant MIN_WIDTH_BPS = 150;
    uint24 public constant MAX_WIDTH_BPS = 5000;
    uint64 public constant MAX_REBALANCE_DELAY = 30 days;
    /// @notice Refunds below 10^decimals / DUST_DIVISOR are not worth an engine deposit.
    uint256 public constant DUST_DIVISOR = 1e5;
    /// @notice Enumeration bound for `positionsOf` (real users hold 13–25 ids, FACT 2).
    uint256 public constant MAX_ENUMERATION = 512;
    /// @notice Widest price band accepted, in bps of the LOWER bound (sqrtPriceX96 space). A
    ///         backstop only: the product's real tolerance is far tighter and set off chain.
    uint256 public constant MAX_BAND_BPS = 2500;
    uint256 private constant CANARY_INDEX = type(uint256).max;
    /// @dev The one revert an array-bounds read inside a generated getter can produce.
    bytes32 private constant PANIC_ARRAY_OOB_HASH =
        keccak256(abi.encodeWithSignature("Panic(uint256)", 0x32));

    // ---------------------------------------------------------------- events

    event LpOpened(
        address indexed account,
        bytes32 indexed poolId,
        uint256 indexed positionId,
        uint256 amount0,
        uint256 amount1,
        uint24 rangeWidthBps
    );
    event LpIncreased(
        address indexed account,
        uint256 indexed positionId,
        uint256 indexed newPositionId,
        uint256 amount0,
        uint256 amount1
    );
    event LpClosed(
        address indexed account,
        uint256 indexed positionId,
        uint256 out0,
        uint256 out1,
        uint256 rewards
    );
    event LpCloseFailed(address indexed account, uint256 indexed positionId, bytes reason);
    event ClaimSkipped(address indexed account, uint256 indexed positionId);
    event PerformanceFee(address indexed account, address indexed token, uint256 gross, uint256 fee);
    /// @notice The fee transfer to the treasury failed (e.g. the issuer blocked the treasury for a
    ///         B20 token); the user's exit proceeds untaxed rather than bricked.
    event FeeSkipped(address indexed account, address indexed token, uint256 fee);
    event RefundFolded(
        address indexed account, address indexed token, uint256 amount, uint256 newPositionId
    );
    event RefundLeft(address indexed account, address indexed token, uint256 amount);

    // ---------------------------------------------------------------- errors

    error FeeAboveCap(uint256 bps, uint256 cap);
    error ZeroAddress();
    error InvalidWidth(uint24 rangeWidthBps);
    error InvalidDelay(uint64 rebalanceDelay);
    error Expired(uint256 deadline);
    error ZeroAmounts();
    error PoolInactive(bytes32 poolId);
    error BandRequired();
    error PriceUnreadable(address pool);
    error PriceOutOfBand(uint256 sqrtPriceX96, uint160 min, uint160 max);
    error NotPositionOwner(uint256 positionId, address owner);
    error BandTooWide(uint160 min, uint160 max, uint256 maxBps);
    error DegeneratePool(bytes32 poolId, address token);
    error EngineUnreachable();
    error EnumerationFailed(bytes reason);
    error TooManyPositions(uint256 cap);

    struct Ctx {
        bytes32 poolId;
        address token0;
        address token1;
        uint24 width;
        uint64 delay;
        bool autoCompound;
        uint256 deadline;
    }

    constructor(ISnuggleVault engine, address rewardToken, address treasury_, uint256 performanceBps_) {
        if (address(engine) == address(0) || rewardToken == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (performanceBps_ > MAX_PERFORMANCE_BPS) {
            revert FeeAboveCap(performanceBps_, MAX_PERFORMANCE_BPS);
        }
        ENGINE = engine;
        REWARD_TOKEN = rewardToken;
        treasury = treasury_;
        performanceBps = performanceBps_;
    }

    // ------------------------------------------------------------------ open

    /// @inheritdoc ILpVenue
    /// @dev Invariant: width ∈ [150, 5000]; the pool price is inside `band` (read live) or the call
    ///      reverts; the id is minted to the calling account; any bounce is folded or left in the
    ///      account; no allowance survives.
    function open(LpOpenParams calldata p) external override returns (uint256 positionId) {
        _validate(p.rangeWidthBps, p.rebalanceDelay, p.deadline);
        if (p.amount0 == 0 && p.amount1 == 0) revert ZeroAmounts();
        (address t0, address t1, address pool, bool active) = _poolOf(p.poolId);
        if (!active) revert PoolInactive(p.poolId);
        // `approvedPools` is third-party admin state. A pool whose two tokens are the SAME token
        // makes every balance-delta measurement here ambiguous (and doubles the fee) — refuse it on
        // the way IN. Exits never consult this: a position that somehow exists must still close.
        if (t0 == t1) revert DegeneratePool(p.poolId, t0);
        _checkBand(pool, p.band);
        Ctx memory ctx = Ctx(p.poolId, t0, t1, p.rangeWidthBps, p.rebalanceDelay, p.autoCompound, p.deadline);
        positionId = _deposit(ctx, p.amount0, p.amount1);
        emit LpOpened(msg.sender, p.poolId, positionId, p.amount0, p.amount1, p.rangeWidthBps);
    }

    /// @inheritdoc ILpVenue
    /// @dev Invariant: `positionId` must be owned by the calling account; parameters are read from
    ///      the engine; same guarantees as `open`.
    function increase(
        uint256 positionId,
        uint256 amount0,
        uint256 amount1,
        PriceBand calldata band,
        uint256 deadline
    ) external override returns (uint256 newPositionId) {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmounts();
        (, bytes32 poolId, address owner, uint24 width,,,, bool autoCompound, uint64 delay,,,,,,,,) =
            ENGINE.positions(positionId);
        if (owner != msg.sender) revert NotPositionOwner(positionId, owner);
        _validate(width, delay, deadline);
        (address t0, address t1, address pool, bool active) = _poolOf(poolId);
        if (!active) revert PoolInactive(poolId);
        if (t0 == t1) revert DegeneratePool(poolId, t0);
        _checkBand(pool, band);
        newPositionId = _deposit(Ctx(poolId, t0, t1, width, delay, autoCompound, deadline), amount0, amount1);
        emit LpIncreased(msg.sender, positionId, newPositionId, amount0, amount1);
    }

    // ----------------------------------------------------------------- close

    /// @inheritdoc ILpVenue
    /// @dev Invariant: fee only on what the collect step gained; principal withdrawn after, untaxed;
    ///      the engine's refusal to close bubbles (use `closeMany` for best-effort).
    function close(uint256 positionId, PriceBand calldata band)
        external
        override
        returns (uint256 out0, uint256 out1, uint256 rewards)
    {
        (bytes32 poolId, address t0, address t1) = _ownedPool(positionId);
        (,, address pool,) = _poolOf(poolId);
        _checkBand(pool, band);
        uint256[] memory ids = new uint256[](1);
        ids[0] = positionId;
        (uint256 f0, uint256 f1, uint256 fr) = _collect(ids, t0, t1);
        (uint256 p0, uint256 p1) = _withdraw(positionId, t0, t1);
        out0 = p0 + f0;
        out1 = p1 + f1;
        rewards = fr;
        emit LpClosed(msg.sender, positionId, out0, out1, rewards);
    }

    /// @inheritdoc ILpVenue
    /// @dev Invariant: an id the engine refuses (or that the account does not own, or that sits in
    ///      another pool) is reported in `failed` and skipped; every other id is paid in full.
    function closeMany(uint256[] calldata positionIds, PriceBand calldata band)
        external
        override
        returns (uint256 out0, uint256 out1, uint256 rewards, uint256[] memory failed)
    {
        if (positionIds.length == 0) revert ZeroAmounts();
        // The batch's pool comes from the first id the caller ACTUALLY OWNS, not from index 0: a
        // stale id at the front is reported like any other, never a revert that kills the batch.
        (bool found, bytes32 poolId, address t0, address t1) = _firstOwnedPool(positionIds);
        if (!found) return (0, 0, 0, _copy(positionIds));
        (,, address pool,) = _poolOf(poolId);
        _checkBand(pool, band);

        uint256[] memory failedBuf = new uint256[](positionIds.length);
        uint256 nFailed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            (, bytes32 pid, address owner,,,,,,,,,,,,,,) = ENGINE.positions(id);
            if (owner != msg.sender || pid != poolId) {
                failedBuf[nFailed++] = id;
                emit LpCloseFailed(msg.sender, id, abi.encodeWithSelector(NotPositionOwner.selector, id, owner));
                continue;
            }
            uint256[] memory one = new uint256[](1);
            one[0] = id;
            (uint256 f0, uint256 f1, uint256 fr) = _collect(one, t0, t1);
            (bool ok, uint256 p0, uint256 p1, bytes memory reason) = _tryWithdraw(id, t0, t1);
            if (!ok) {
                failedBuf[nFailed++] = id;
                emit LpCloseFailed(msg.sender, id, reason);
            } else {
                emit LpClosed(msg.sender, id, p0 + f0, p1 + f1, fr);
            }
            // Yield collected for a refused id is still the user's (it is in the account already).
            out0 += p0 + f0;
            out1 += p1 + f1;
            rewards += fr;
        }
        failed = new uint256[](nFailed);
        for (uint256 i = 0; i < nFailed; i++) {
            failed[i] = failedBuf[i];
        }
    }

    /// @inheritdoc ILpVenue
    /// @dev Invariant: the single fee chokepoint (with `close`); all ids must be the account's and in
    ///      one pool; fee = gain × performanceBps / 10 000 per token, paid to `treasury`.
    function claim(uint256[] calldata positionIds, PriceBand calldata band, uint256 deadline)
        external
        override
        returns (uint256 fees0, uint256 fees1, uint256 rewards, uint256[] memory failed)
    {
        if (positionIds.length == 0) revert ZeroAmounts();
        if (deadline < block.timestamp) revert Expired(deadline);
        (bool found, bytes32 poolId, address t0, address t1) = _firstOwnedPool(positionIds);
        if (!found) return (0, 0, 0, _copy(positionIds));
        (,, address pool,) = _poolOf(poolId);
        // Every position is opened with autoCompound = true, so a harvest inside the engine may
        // swap: claim carries the same band as the deposit and close paths, and the same deadline.
        _checkBand(pool, band);

        uint256[] memory keep = new uint256[](positionIds.length);
        uint256[] memory failedBuf = new uint256[](positionIds.length);
        uint256 nKeep;
        uint256 nFailed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            (, bytes32 pid, address owner,,,,,,,,,,,,,,) = ENGINE.positions(id);
            if (owner != msg.sender || pid != poolId) {
                failedBuf[nFailed++] = id;
                emit ClaimSkipped(msg.sender, id);
            } else {
                keep[nKeep++] = id;
            }
        }
        uint256[] memory ids = new uint256[](nKeep);
        for (uint256 i = 0; i < nKeep; i++) {
            ids[i] = keep[i];
        }
        failed = new uint256[](nFailed);
        for (uint256 i = 0; i < nFailed; i++) {
            failed[i] = failedBuf[i];
        }
        (fees0, fees1, rewards) = _collect(ids, t0, t1);
    }

    // ----------------------------------------------------------------- views

    /// @inheritdoc ILpVenue
    /// @dev C-2. The end-of-list revert shape is measured with a canary index first; a terminating
    ///      revert of a different shape, or an engine that fails a plain liveness read, reverts —
    ///      "cannot enumerate" is never reported as "owns nothing".
    function positionsOf(address account) external view override returns (uint256[] memory ids) {
        // Liveness: a plain view must answer, or nothing below can be trusted.
        (bool alive, bytes memory aliveRet) =
            address(ENGINE).staticcall(abi.encodeCall(ISnuggleVault.poolIdsCount, ()));
        if (!alive || aliveRet.length < 32) revert EngineUnreachable();

        (bool canaryOk, bytes memory canary) = address(ENGINE).staticcall(
            abi.encodeCall(ISnuggleVault.userPositions, (account, CANARY_INDEX))
        );
        if (canaryOk) revert EnumerationFailed(canary); // a far index answered: not a bounded list
        // …and the WAY it failed must be the one shape that means "past the end of an array". A
        // canary alone measures the shape of a revert, not its cause: a bare `revert()`, an
        // out-of-gas or a proxy miss all look identical to it, so a transient failure mid-list would
        // read as the end of the list and truncate it silently. Pin the shape.
        if (keccak256(canary) != PANIC_ARRAY_OOB_HASH) revert EnumerationFailed(canary);

        uint256[] memory buf = new uint256[](MAX_ENUMERATION);
        uint256 kept;
        for (uint256 i = 0;; i++) {
            if (i == MAX_ENUMERATION) revert TooManyPositions(MAX_ENUMERATION);
            (bool ok, bytes memory ret) = address(ENGINE).staticcall(
                abi.encodeCall(ISnuggleVault.userPositions, (account, i))
            );
            if (!ok) {
                if (keccak256(ret) != PANIC_ARRAY_OOB_HASH) revert EnumerationFailed(ret);
                break;
            }
            if (ret.length < 32) revert EnumerationFailed(ret);
            uint256 id = abi.decode(ret, (uint256));
            (,, address owner,,,,,,,,,,,,,,) = ENGINE.positions(id);
            if (owner == account) buf[kept++] = id;
        }
        ids = new uint256[](kept);
        for (uint256 i = 0; i < kept; i++) {
            ids[i] = buf[i];
        }
    }

    /// @inheritdoc ILpVenue
    function poolTokens(bytes32 poolId)
        external
        view
        override
        returns (address token0, address token1, address pool)
    {
        (token0, token1, pool,) = _poolOf(poolId);
    }

    /// @inheritdoc ILpVenue
    function poolOf(uint256 positionId)
        external
        view
        override
        returns (bytes32 poolId, address owner)
    {
        (, poolId, owner,,,,,,,,,,,,,,) = ENGINE.positions(positionId);
    }

    /// @notice Current pool sqrtPriceX96 for `poolId`, read exactly as the band check reads it.
    function poolSqrtPriceX96(bytes32 poolId) external view returns (uint256) {
        (,, address pool,) = _poolOf(poolId);
        return _readSqrtPrice(pool);
    }

    /// @notice Decimals-aware refund floor for `token` (max uint if decimals are unreadable → never fold).
    function dustFloor(address token) public view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) return type(uint256).max;
        uint256 d = abi.decode(ret, (uint256));
        if (d > 77) return type(uint256).max;
        uint256 unit = 10 ** d;
        uint256 floor = unit / DUST_DIVISOR;
        return floor == 0 ? 1 : floor;
    }

    // -------------------------------------------------------------- internal

    function _deposit(Ctx memory ctx, uint256 a0, uint256 a1) internal returns (uint256 id) {
        address acct = msg.sender;
        uint256 b0 = _bal(ctx.token0, acct);
        uint256 b1 = _bal(ctx.token1, acct);

        if (a0 != 0 && a1 != 0) {
            Call[] memory calls = new Call[](5);
            calls[0] = _approveCall(ctx.token0, address(ENGINE), a0);
            calls[1] = _approveCall(ctx.token1, address(ENGINE), a1);
            calls[2] = Call({
                target: address(ENGINE),
                value: 0,
                data: abi.encodeCall(
                    ISnuggleVault.deposit,
                    (ctx.poolId, a0, a1, ctx.width, ctx.delay, true, ctx.autoCompound, ctx.deadline, treasury)
                ),
                callback: false
            });
            calls[3] = _approveCall(ctx.token0, address(ENGINE), 0);
            calls[4] = _approveCall(ctx.token1, address(ENGINE), 0);
            id = abi.decode(_execMany(calls)[2], (uint256));
            _fold(ctx, ctx.token0, _refund(ctx.token0, acct, b0, a0));
            _fold(ctx, ctx.token1, _refund(ctx.token1, acct, b1, a1));
        } else {
            (address token, uint256 amount, uint256 before) =
                a0 != 0 ? (ctx.token0, a0, b0) : (ctx.token1, a1, b1);
            id = abi.decode(
                _approveCallReset(token, address(ENGINE), amount, _singleSidedCall(ctx, token, amount)),
                (uint256)
            );
            _fold(ctx, token, _refund(token, acct, before, amount));
        }
    }

    function _singleSidedCall(Ctx memory ctx, address token, uint256 amount)
        internal
        view
        returns (Call memory)
    {
        return Call({
            target: address(ENGINE),
            value: 0,
            data: abi.encodeCall(
                ISnuggleVault.depositSingleSided,
                (ctx.poolId, token, amount, ctx.width, ctx.delay, true, ctx.autoCompound, ctx.deadline, treasury)
            ),
            callback: false
        });
    }

    /// @dev How much of `sent` came back. Non-negative and never more than was sent, so a balance
    ///      that moved for any other reason (a rebase between reads) can only shrink the fold.
    function _refund(address token, address acct, uint256 before, uint256 sent)
        internal
        view
        returns (uint256)
    {
        if (sent == 0 || before < sent) return 0;
        uint256 expectedMin = before - sent;
        uint256 after_ = _bal(token, acct);
        if (after_ <= expectedMin) return 0;
        uint256 r = after_ - expectedMin;
        return r > sent ? sent : r;
    }

    /// @dev Single-sided re-deposit of a bounce. Best effort: a refusal leaves the tokens in the
    ///      account (they are the user's) and is reported, never reverted.
    function _fold(Ctx memory ctx, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (amount < dustFloor(token)) {
            emit RefundLeft(msg.sender, token, amount);
            return;
        }
        Call[] memory calls = new Call[](3);
        calls[0] = _approveCall(token, address(ENGINE), amount);
        calls[1] = _singleSidedCall(ctx, token, amount);
        calls[2] = _approveCall(token, address(ENGINE), 0);
        try _account().execFromPeripheral(calls) returns (bytes[] memory res) {
            emit RefundFolded(msg.sender, token, amount, abi.decode(res[1], (uint256)));
        } catch {
            emit RefundLeft(msg.sender, token, amount);
        }
    }

    /// @dev Collect realised yield for `ids` and take the performance fee. Returns NET gains.
    function _collect(uint256[] memory ids, address t0, address t1)
        internal
        returns (uint256 n0, uint256 n1, uint256 nr)
    {
        address acct = msg.sender;
        bool rewardIsPoolToken = REWARD_TOKEN == t0 || REWARD_TOKEN == t1;
        uint256 b0 = _bal(t0, acct);
        uint256 b1 = _bal(t1, acct);
        uint256 br = rewardIsPoolToken ? 0 : _bal(REWARD_TOKEN, acct);

        for (uint256 i = 0; i < ids.length; i++) {
            _claimOne(ids[i]);
        }

        n0 = _takeFee(t0, acct, b0);
        // One fee per DISTINCT token. A degenerate (X, X) pool is refused at open, but if one ever
        // existed a second call would measure the already-reduced gain and charge again —
        // 1-(1-p)^2, i.e. 19 % at a 10 % setting, above the cap this contract advertises.
        n1 = t1 == t0 ? 0 : _takeFee(t1, acct, b1);
        nr = rewardIsPoolToken ? 0 : _takeFee(REWARD_TOKEN, acct, br);
    }

    /// @dev Staked positions pay via claimStakingRewards, unstaked via harvest. A position that
    ///      refuses both is skipped (its yield stays in the engine; nothing is lost or locked).
    function _claimOne(uint256 id) internal {
        Call[] memory c = new Call[](1);
        c[0] = Call({
            target: address(ENGINE),
            value: 0,
            data: abi.encodeCall(ISnuggleVault.claimStakingRewards, (id)),
            callback: false
        });
        try _account().execFromPeripheral(c) {
            return;
        } catch {}
        c[0].data = abi.encodeCall(ISnuggleVault.harvest, (id));
        try _account().execFromPeripheral(c) {
            return;
        } catch {
            emit ClaimSkipped(msg.sender, id);
        }
    }

    /// @dev Fee on what `acct` gained in `token` since `before`; pays the treasury from the account.
    ///      Best effort: a treasury that cannot receive (a B20 block) never blocks the user's exit.
    function _takeFee(address token, address acct, uint256 before) internal returns (uint256 net) {
        uint256 after_ = _bal(token, acct);
        if (after_ <= before) return 0;
        uint256 gained = after_ - before;
        uint256 fee = (gained * performanceBps) / BPS;
        if (fee != 0) {
            Call[] memory c = new Call[](1);
            c[0] = Call({target: token, value: 0, data: abi.encodeCall(IERC20.transfer, (treasury, fee)), callback: false});
            try _account().execFromPeripheral(c) {}
            catch {
                emit FeeSkipped(acct, token, fee);
                return gained;
            }
        }
        emit PerformanceFee(acct, token, gained, fee);
        return gained - fee;
    }

    function _withdraw(uint256 id, address t0, address t1) internal returns (uint256 p0, uint256 p1) {
        address acct = msg.sender;
        uint256 b0 = _bal(t0, acct);
        uint256 b1 = _bal(t1, acct);
        _exec(address(ENGINE), abi.encodeCall(ISnuggleVault.withdraw, (id, false)));
        p0 = _gain(t0, acct, b0);
        p1 = _gain(t1, acct, b1);
    }

    function _tryWithdraw(uint256 id, address t0, address t1)
        internal
        returns (bool ok, uint256 p0, uint256 p1, bytes memory reason)
    {
        address acct = msg.sender;
        uint256 b0 = _bal(t0, acct);
        uint256 b1 = _bal(t1, acct);
        Call[] memory c = new Call[](1);
        c[0] = Call({
            target: address(ENGINE),
            value: 0,
            data: abi.encodeCall(ISnuggleVault.withdraw, (id, false)),
            callback: false
        });
        try _account().execFromPeripheral(c) {
            ok = true;
            p0 = _gain(t0, acct, b0);
            p1 = _gain(t1, acct, b1);
        } catch (bytes memory r) {
            reason = r;
        }
    }

    function _gain(address token, address acct, uint256 before) internal view returns (uint256) {
        uint256 after_ = _bal(token, acct);
        return after_ > before ? after_ - before : 0;
    }

    /// @dev The pool of the first id in `ids` this account actually owns. Never reverts: an unowned
    ///      or re-keyed id is something to tell the caller about, not a reason to kill a batch.
    function _firstOwnedPool(uint256[] calldata ids)
        internal
        view
        returns (bool found, bytes32 poolId, address t0, address t1)
    {
        for (uint256 i = 0; i < ids.length; i++) {
            (, bytes32 pid, address owner,,,,,,,,,,,,,,) = ENGINE.positions(ids[i]);
            if (owner == msg.sender && pid != bytes32(0)) {
                (t0, t1,,) = _poolOf(pid);
                return (true, pid, t0, t1);
            }
        }
        return (false, bytes32(0), address(0), address(0));
    }

    function _copy(uint256[] calldata ids) internal pure returns (uint256[] memory out) {
        out = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = ids[i];
        }
    }

    function _ownedPool(uint256 id) internal view returns (bytes32 poolId, address t0, address t1) {
        address owner;
        (, poolId, owner,,,,,,,,,,,,,,) = ENGINE.positions(id);
        if (owner != msg.sender) revert NotPositionOwner(id, owner);
        (t0, t1,,) = _poolOf(poolId);
    }

    function _poolOf(bytes32 poolId)
        internal
        view
        returns (address t0, address t1, address pool, bool active)
    {
        (pool, t0, t1,,, active,,) = ENGINE.approvedPools(poolId);
    }

    function _validate(uint24 width, uint64 delay, uint256 deadline) internal view {
        if (width < MIN_WIDTH_BPS || width > MAX_WIDTH_BPS) revert InvalidWidth(width);
        if (delay > MAX_REBALANCE_DELAY) revert InvalidDelay(delay);
        if (deadline < block.timestamp) revert Expired(deadline);
    }

    function _checkBand(address pool, PriceBand calldata band) internal view {
        if (band.minSqrtPriceX96 == 0 || band.maxSqrtPriceX96 == 0
                || band.minSqrtPriceX96 > band.maxSqrtPriceX96) revert BandRequired();
        // "There is no 'no band'" has to mean something: bound the WIDTH, or [1, uint160.max] is
        // accepted and the pre-check protects nothing.
        if (
            uint256(band.maxSqrtPriceX96) * BPS
                > uint256(band.minSqrtPriceX96) * (BPS + MAX_BAND_BPS)
        ) revert BandTooWide(band.minSqrtPriceX96, band.maxSqrtPriceX96, MAX_BAND_BPS);
        uint256 price = _readSqrtPrice(pool);
        if (price < band.minSqrtPriceX96 || price > band.maxSqrtPriceX96) {
            revert PriceOutOfBand(price, band.minSqrtPriceX96, band.maxSqrtPriceX96);
        }
    }

    /// @dev slot0().sqrtPriceX96, failing closed on any read problem.
    function _readSqrtPrice(address pool) internal view returns (uint256 price) {
        if (pool == address(0) || pool.code.length == 0) revert PriceUnreadable(pool);
        (bool ok, bytes memory ret) =
            pool.staticcall(abi.encodeWithSelector(IAerodromeCLPool.slot0.selector));
        if (!ok || ret.length < 32) revert PriceUnreadable(pool);
        price = abi.decode(ret, (uint256));
        if (price == 0 || price > type(uint160).max) revert PriceUnreadable(pool);
    }

    /// @dev Raw balance read: a token whose balanceOf cannot be decoded reads as 0 rather than
    ///      bricking a claim or exit (AUDIT-FINDINGS Lens A).
    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IERC20.balanceOf, (who)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}
