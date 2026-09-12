// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IAerodromeCLPool} from "../interfaces/IAerodromeCLPool.sol";
import {ISlipstreamGauge, ISlipstreamNpm, ISlipstreamPool, ISlipstreamVoter} from "../interfaces/ISlipstream.sol";
import {LiquidityAmounts} from "../libraries/LiquidityAmounts.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title SlipstreamLpVenue — ILpVenue directly over ONE Aerodrome Slipstream pool, its
///        NonfungiblePositionManager and its gauge, bypassing the MaxFi/Snuggle engine
///        (`docs/CBZEC-PATH-2026-09.md` option 1, decided 2026-09-10).
///
/// @notice Built for the cbZEC/USDC pool on Base's SECOND Slipstream deployment (CLFactory
///         `0xf8f2…61Ef`, NPM `0xe1f8…8b53`, gauge `0x8779…81FB` — `VERIFIED-BASE-FACTS.md`
///         Addenda 8 and 9), which the engine does not list and the verified SwapRouter cannot
///         reach. Stateless and admin-free like `SnuggleLpVenue`: every position is an NPM token
///         minted to the calling account, every movement is instructed back into that account.
///
///         What it does differently from the engine venue, on purpose:
///           • the position is DUAL-SIDED and CENTRED on the current tick: a single-sided deposit
///             is first swapped to the range's ratio through the pool itself (`SWAP`, the
///             pool-direct adapter, floor from the caller's own price band), then minted — the
///             shape the yield model prices, not the engine's one-sided range below the price
///             (`RISKS.md` §12, measured 2026-09-10);
///           • the NFT is STAKED in the gauge (`approve` + `deposit`) so it earns the epoch's AERO
///             emissions; a gauge that is not alive leaves it unstaked and says so (`StakeSkipped`),
///             the position still exists and still closes;
///           • there is no rebalancer: the range is static (`rebalanceDelay` and `autoCompound`
///             are accepted for interface parity and ignored); a position that drifts out of
///             range earns nothing until closed and re-opened — the dashboard shows the range;
///           • the ONE fee chokepoint is on what `claim` / `close` COLLECT (gauge rewards, and any
///             trading fees accrued while unstaked), once per distinct token; principal is
///             withdrawn afterwards, untaxed.
///
/// @dev Ids are the NPM's token ids. A staked id is owned by the GAUGE on the NPM and by the
///      depositor on the gauge's own books; `ownedPool(id, account)` resolves both, `poolOf(id)`
///      reports the NPM owner and is not enough on its own (there is no id → depositor view on
///      the gauge). Mint / decrease minimums are zero BECAUSE the whole open or close is one
///      transaction whose pool price was checked against the caller's band at the start and moved
///      only by the venue's own bounded swap: nothing can enter between the check and the mint.
contract SlipstreamLpVenue is ILpVenue, Peripheral {
    // ---------------------------------------------------------------- config

    ISlipstreamPool public immutable POOL;
    ISlipstreamNpm public immutable NPM;
    ISlipstreamGauge public immutable GAUGE;
    ISlipstreamVoter public immutable VOTER;
    /// @notice The pool-direct swap adapter used for the to-ratio swap on open.
    ISwapAdapter public immutable SWAP;
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    int24 public immutable TICK_SPACING;
    /// @notice The gauge's reward token (AERO on Base).
    address public immutable REWARD_TOKEN;
    /// @notice The one `poolId` this venue serves: the pool address, left-padded to 32 bytes.
    bytes32 public immutable POOL_ID;
    /// @inheritdoc ILpVenue
    address public immutable override treasury;
    /// @inheritdoc ILpVenue
    uint256 public immutable override performanceBps;

    uint256 public constant MAX_PERFORMANCE_BPS = 2000;
    uint256 public constant BPS = 10_000;
    /// @notice Bounds on the TOTAL tick span, the same the engine venue enforces (1 bps = 1 tick).
    uint24 public constant MIN_WIDTH_BPS = 150;
    uint24 public constant MAX_WIDTH_BPS = 5000;
    uint64 public constant MAX_REBALANCE_DELAY = 30 days;
    uint256 public constant MAX_BAND_BPS = 2500;
    uint256 public constant MAX_ENUMERATION = 512;
    /// @dev Pool fees are in pips (1e-6): `fee()` = 2000 is 0.2 %.
    uint256 private constant PIPS = 1_000_000;
    uint256 private constant Q96 = 2 ** 96;
    /// @dev Reference liquidity for the to-ratio sizing: only the RATIO of the two amounts matters.
    uint128 private constant REF_LIQUIDITY = 1e24;

    // ---------------------------------------------------------------- events

    event LpOpened(
        address indexed account,
        bytes32 indexed poolId,
        uint256 indexed positionId,
        uint256 amount0,
        uint256 amount1,
        uint24 rangeWidthBps
    );
    /// @notice What was actually minted: the rounded range, the liquidity, the amounts the pool took,
    ///         and whether the NFT was staked in the gauge.
    event LpMinted(
        address indexed account,
        uint256 indexed positionId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 used0,
        uint256 used1,
        bool staked
    );
    event LpIncreased(
        address indexed account,
        uint256 indexed positionId,
        uint256 indexed newPositionId,
        uint256 amount0,
        uint256 amount1
    );
    event LpClosed(address indexed account, uint256 indexed positionId, uint256 out0, uint256 out1, uint256 rewards);
    event LpCloseFailed(address indexed account, uint256 indexed positionId, bytes reason);
    event ClaimSkipped(address indexed account, uint256 indexed positionId);
    event PerformanceFee(address indexed account, address indexed token, uint256 gross, uint256 fee);
    event FeeSkipped(address indexed account, address indexed token, uint256 fee);
    /// @notice Deposit the pool did not take (the ratio after the swap, or a rounding remainder)
    ///         stays in the account; nothing is swept anywhere else.
    event RefundLeft(address indexed account, address indexed token, uint256 amount);
    /// @notice The gauge refused the stake (not alive, or any revert); the position is held unstaked.
    event StakeSkipped(address indexed account, uint256 indexed positionId, bytes reason);
    /// @notice The to-ratio swap on open: `amountIn` of `tokenIn` for `amountOut` of the other token.
    event SwappedToRatio(address indexed account, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

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
    error BandTooWide(uint160 min, uint160 max, uint256 maxBps);
    error NotPositionOwner(uint256 positionId, address owner);
    error DegeneratePool(bytes32 poolId, address token);
    error TooManyPositions(uint256 cap);
    /// @notice A constructor cross-check between the pool, the NPM, the gauge and the adapter failed.
    error PoolMismatch(string what);
    /// @notice `positionsOf` could not be trusted: the gauge or the NPM did not answer.
    error PositionsUnreadable(bytes reason);
    /// @notice The rounded range does not contain the current tick — nothing to centre on.
    error RangeExcludesPrice(int24 tick, int24 tickLower, int24 tickUpper);

    constructor(
        ISlipstreamPool pool,
        ISlipstreamNpm npm,
        ISlipstreamGauge gauge,
        ISwapAdapter swapAdapter,
        address rewardToken,
        address treasury_,
        uint256 performanceBps_
    ) {
        if (
            address(pool) == address(0) || address(npm) == address(0) || address(gauge) == address(0)
                || address(swapAdapter) == address(0) || rewardToken == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (performanceBps_ > MAX_PERFORMANCE_BPS) revert FeeAboveCap(performanceBps_, MAX_PERFORMANCE_BPS);
        // The four contracts must name each other: a venue built over a pool, a manager that does
        // not mint into it, or a gauge for another pool would hold the user's tokens hostage.
        if (pool.nft() != address(npm)) revert PoolMismatch("pool.nft");
        if (pool.gauge() != address(gauge)) revert PoolMismatch("pool.gauge");
        if (gauge.nft() != address(npm)) revert PoolMismatch("gauge.nft");
        if (gauge.pool() != address(pool)) revert PoolMismatch("gauge.pool");
        if (gauge.rewardToken() != rewardToken) revert PoolMismatch("gauge.rewardToken");
        (bool ok, bytes memory ret) = address(swapAdapter).staticcall(abi.encodeWithSignature("POOL()"));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(pool)) revert PoolMismatch("swap.POOL");
        POOL = pool;
        NPM = npm;
        GAUGE = gauge;
        VOTER = ISlipstreamVoter(gauge.voter());
        SWAP = swapAdapter;
        TOKEN0 = pool.token0();
        TOKEN1 = pool.token1();
        TICK_SPACING = pool.tickSpacing();
        if (TOKEN0 == address(0) || TOKEN1 == address(0) || TICK_SPACING <= 0) revert PoolMismatch("pool.tokens");
        POOL_ID = bytes32(uint256(uint160(address(pool))));
        if (TOKEN0 == TOKEN1) revert DegeneratePool(POOL_ID, TOKEN0);
        REWARD_TOKEN = rewardToken;
        treasury = treasury_;
        performanceBps = performanceBps_;
    }

    // ------------------------------------------------------------------ open

    /// @inheritdoc ILpVenue
    /// @dev Invariant: width ∈ [150, 5000]; the pool price is inside `band` (read live) or the call
    ///      reverts; a single-sided deposit is swapped to the centred range's ratio through `SWAP`
    ///      under a floor derived from the band; the id is minted to the calling account and
    ///      staked when the gauge is alive; what the pool did not take stays in the account; no
    ///      allowance survives.
    function open(LpOpenParams calldata p) external override returns (uint256 positionId) {
        _validate(p.rangeWidthBps, p.rebalanceDelay, p.deadline);
        if (p.amount0 == 0 && p.amount1 == 0) revert ZeroAmounts();
        if (p.poolId != POOL_ID) revert PoolInactive(p.poolId);
        (, int24 tick) = _checkBand(p.band);
        (int24 lower, int24 upper) = _centredTicks(tick, p.rangeWidthBps);
        positionId = _openRange(lower, upper, p.amount0, p.amount1, p.band, p.deadline);
        emit LpOpened(msg.sender, POOL_ID, positionId, p.amount0, p.amount1, p.rangeWidthBps);
    }

    /// @inheritdoc ILpVenue
    /// @dev Invariant: `positionId` must be the calling account's (staked or held); the new id takes
    ///      the SAME range; same guarantees as `open`. A range the price has left is filled
    ///      single-sided on the side it wants (the swap turns the whole deposit into that token).
    function increase(
        uint256 positionId,
        uint256 amount0,
        uint256 amount1,
        PriceBand calldata band,
        uint256 deadline
    ) external override returns (uint256 newPositionId) {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmounts();
        if (deadline < block.timestamp) revert Expired(deadline);
        _requireOwned(positionId);
        (,,,,, int24 lower, int24 upper,,,,,) = NPM.positions(positionId);
        _checkBand(band);
        newPositionId = _openRange(lower, upper, amount0, amount1, band, deadline);
        emit LpIncreased(msg.sender, positionId, newPositionId, amount0, amount1);
    }

    // ----------------------------------------------------------------- close

    /// @inheritdoc ILpVenue
    /// @dev Invariant: rewards (and fees accrued while unstaked) are collected first and taxed once
    ///      per distinct token; principal is decreased, collected and the NFT burnt afterwards,
    ///      untaxed; a refusal anywhere bubbles (use `closeMany` for best effort).
    function close(uint256 positionId, PriceBand calldata band)
        external
        override
        returns (uint256 out0, uint256 out1, uint256 rewards)
    {
        _requireOwned(positionId);
        _checkBand(band);
        uint256[] memory one = new uint256[](1);
        one[0] = positionId;
        (uint256 f0, uint256 f1, uint256 fr) = _collect(one, true);
        (uint256 p0, uint256 p1) = _withdrawPrincipal(positionId);
        out0 = p0 + f0;
        out1 = p1 + f1;
        rewards = fr;
        emit LpClosed(msg.sender, positionId, out0, out1, rewards);
    }

    /// @inheritdoc ILpVenue
    /// @dev Invariant: an id the account does not own is reported in `failed`; an id whose unstake
    ///      or whose principal withdrawal reverts is reported in `failed` and left where it is (an
    ///      id unstaked but not withdrawn stays in the account, still the user's, closable later);
    ///      every other id is paid in full.
    function closeMany(uint256[] calldata positionIds, PriceBand calldata band)
        external
        override
        returns (uint256 out0, uint256 out1, uint256 rewards, uint256[] memory failed)
    {
        if (positionIds.length == 0) revert ZeroAmounts();
        _checkBand(band);
        uint256[] memory failedBuf = new uint256[](positionIds.length);
        uint256 nFailed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            if (!_owned(id)) {
                failedBuf[nFailed++] = id;
                emit LpCloseFailed(msg.sender, id, abi.encodeWithSelector(NotPositionOwner.selector, id, _npmOwner(id)));
                continue;
            }
            (bool okC, uint256 f0, uint256 f1, uint256 fr, bytes memory why) = _tryCollectOne(id, true);
            if (!okC) {
                failedBuf[nFailed++] = id;
                emit LpCloseFailed(msg.sender, id, why);
                continue;
            }
            (bool okW, uint256 p0, uint256 p1, bytes memory reason) = _tryWithdrawPrincipal(id);
            if (!okW) {
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
    /// @dev Invariant: the single fee chokepoint (with `close`); ids the account does not own are
    ///      reported in `failed`; staked ids are paid by the gauge (`getReward`), unstaked ids by
    ///      the NPM (`collect`); fee = gain × performanceBps / 10 000 per distinct token.
    function claim(uint256[] calldata positionIds, PriceBand calldata band, uint256 deadline)
        external
        override
        returns (uint256 fees0, uint256 fees1, uint256 rewards, uint256[] memory failed)
    {
        if (positionIds.length == 0) revert ZeroAmounts();
        if (deadline < block.timestamp) revert Expired(deadline);
        _checkBand(band);
        uint256[] memory keep = new uint256[](positionIds.length);
        uint256[] memory failedBuf = new uint256[](positionIds.length);
        uint256 nKeep;
        uint256 nFailed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            if (!_owned(id)) {
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
        (fees0, fees1, rewards) = _collect(ids, false);
    }

    // ----------------------------------------------------------------- views

    /// @inheritdoc ILpVenue
    /// @dev The gauge's `stakedValues(account)` — the account's OWN deposits, in full: the gauge
    ///      stakes for `msg.sender`, so nobody else can pad that list — plus the NPM tokens the
    ///      account holds that sit in this pool, scanned through a window of `MAX_ENUMERATION`
    ///      (ERC-721 transfers are permissionless, so a stranger CAN pad the account's holdings;
    ///      audit wave 3, W3-MED-2: counting them against the cap let 512 dust tokens switch the
    ///      keeper's protection off). `unstakedOverflow` says what the window did not reach; the
    ///      keeper and the dashboard name it. Fails closed by name when the gauge or the NPM cannot
    ///      be read — never "owns nothing" — and still refuses a staked list past the cap, which
    ///      only the account itself can produce.
    function positionsOf(address account) external view override returns (uint256[] memory ids) {
        uint256[] memory staked;
        try GAUGE.stakedValues(account) returns (uint256[] memory s) {
            staked = s;
        } catch (bytes memory r) {
            revert PositionsUnreadable(r);
        }
        if (staked.length > MAX_ENUMERATION) revert TooManyPositions(MAX_ENUMERATION);
        (uint256 held, uint256 window) = _unstakedWindow(account);
        uint256[] memory buf = new uint256[](staked.length + window);
        uint256 kept;
        for (uint256 i = 0; i < staked.length; i++) {
            buf[kept++] = staked[i];
        }
        for (uint256 i = 0; i < window; i++) {
            uint256 id;
            try NPM.tokenOfOwnerByIndex(account, i) returns (uint256 t) {
                id = t;
            } catch (bytes memory r) {
                revert PositionsUnreadable(r);
            }
            if (_isThisPool(id)) buf[kept++] = id;
        }
        ids = new uint256[](kept);
        for (uint256 i = 0; i < kept; i++) {
            ids[i] = buf[i];
        }
        held; // the overflow, if any, is reported by `unstakedOverflow`
    }

    /// @notice How many Slipstream tokens the account holds unstaked on this deployment (any pool)
    ///         and how many of them `positionsOf` scans: `held > scanned` means tokens beyond the
    ///         window are not listed — a stranger may have sent them, or the account holds more
    ///         unstaked positions than the window. The staked list is never truncated.
    function unstakedOverflow(address account) external view returns (uint256 held, uint256 scanned) {
        (held, scanned) = _unstakedWindow(account);
    }

    function _unstakedWindow(address account) internal view returns (uint256 held, uint256 window) {
        try NPM.balanceOf(account) returns (uint256 n) {
            held = n;
        } catch (bytes memory r) {
            revert PositionsUnreadable(r);
        }
        window = held > MAX_ENUMERATION ? MAX_ENUMERATION : held;
    }

    /// @inheritdoc ILpVenue
    function poolTokens(bytes32 poolId) external view override returns (address token0, address token1, address pool) {
        if (poolId != POOL_ID) return (address(0), address(0), address(0));
        return (TOKEN0, TOKEN1, address(POOL));
    }

    /// @inheritdoc ILpVenue
    /// @dev `owner` is the NPM's owner: the GAUGE for a staked id. Use `ownedPool` to ask whether
    ///      an ACCOUNT owns the position; the gauge has no id → depositor view.
    function poolOf(uint256 positionId) external view override returns (bytes32 poolId, address owner) {
        owner = _npmOwner(positionId);
        if (owner == address(0) || !_isThisPool(positionId)) return (bytes32(0), address(0));
        poolId = POOL_ID;
    }

    /// @inheritdoc ILpVenue
    function ownedPool(uint256 positionId, address account) external view override returns (bytes32 poolId, bool owned) {
        owned = _ownedBy(positionId, account);
        poolId = owned ? POOL_ID : bytes32(0);
    }

    /// @notice Current pool sqrtPriceX96, read exactly as the band check reads it.
    function poolSqrtPriceX96(bytes32 poolId) external view returns (uint256) {
        if (poolId != POOL_ID) revert PoolInactive(poolId);
        (uint160 sqrtP,) = _readSlot0();
        return sqrtP;
    }

    /// @notice The range and liquidity of `positionId`, and whether it is staked in the gauge by
    ///         `account` — what the dashboard shows for a static range.
    function positionRange(uint256 positionId, address account)
        external
        view
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity, bool staked)
    {
        (,,,,, tickLower, tickUpper, liquidity,,,,) = NPM.positions(positionId);
        staked = GAUGE.stakedContains(account, positionId);
    }

    // -------------------------------------------------------------- internal

    function _openRange(int24 lower, int24 upper, uint256 a0, uint256 a1, PriceBand calldata band, uint256 deadline)
        internal
        returns (uint256 id)
    {
        if (a0 == 0 || a1 == 0) (a0, a1) = _toRatio(a0, a1, lower, upper, band, deadline);
        uint128 liquidity;
        uint256 used0;
        uint256 used1;
        (id, liquidity, used0, used1) = _mint(lower, upper, a0, a1, deadline);
        if (a0 > used0) emit RefundLeft(msg.sender, TOKEN0, a0 - used0);
        if (a1 > used1) emit RefundLeft(msg.sender, TOKEN1, a1 - used1);
        bool staked = _stake(id);
        emit LpMinted(msg.sender, id, lower, upper, liquidity, used0, used1, staked);
    }

    /// @dev Turn a single-sided deposit into the two amounts the range wants at the current price.
    ///      With r0 : r1 the range's amounts per unit of liquidity at price p (token1 per token0)
    ///      and f the pool fee, selling x of token0 yields ≈ x·p·(1−f) of token1, so
    ///      x = a0·r1 / (r1 + p·(1−f)·r0); the mirror for token1. Price impact makes the bought
    ///      side a little short of the ratio, so a little of the sold side is left over — reported,
    ///      never folded (a second swap would chase its own impact).
    function _toRatio(uint256 a0, uint256 a1, int24 lower, int24 upper, PriceBand calldata band, uint256 deadline)
        internal
        returns (uint256, uint256)
    {
        (uint160 sqrtP,) = _readSlot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(upper);
        if (sqrtP <= sqrtA) {
            // Price below the range: the range holds token0 only.
            if (a0 == 0) return (_swapAll(TOKEN1, TOKEN0, a1, sqrtP, band, deadline), 0);
            return (a0, a1);
        }
        if (sqrtP >= sqrtB) {
            if (a1 == 0) return (0, _swapAll(TOKEN0, TOKEN1, a0, sqrtP, band, deadline));
            return (a0, a1);
        }
        uint256 r0 = LiquidityAmounts.getAmount0ForLiquidity(sqrtP, sqrtB, REF_LIQUIDITY);
        uint256 r1 = LiquidityAmounts.getAmount1ForLiquidity(sqrtA, sqrtP, REF_LIQUIDITY);
        if (r0 == 0 || r1 == 0) revert RangeExcludesPrice(_tickOf(sqrtP), lower, upper);
        uint256 fee = POOL.fee();
        if (a1 == 0) {
            // sell token0: den = r1 + r0·p·(1−f)
            uint256 r0p = Math.mulDiv(Math.mulDiv(r0, sqrtP, Q96), sqrtP, Q96);
            uint256 den = r1 + Math.mulDiv(r0p, PIPS - fee, PIPS);
            uint256 x = Math.mulDiv(a0, r1, den);
            if (x == 0 || x >= a0) return (a0, 0);
            uint256 got = _swap(TOKEN0, TOKEN1, x, _quoteOut(x, sqrtP, true, fee), band, deadline);
            return (a0 - x, got);
        } else {
            // sell token1: den = r0 + r1·(1−f)/p
            uint256 r1p = Math.mulDiv(Math.mulDiv(r1, Q96, sqrtP), Q96, sqrtP);
            uint256 den = r0 + Math.mulDiv(r1p, PIPS - fee, PIPS);
            uint256 x = Math.mulDiv(a1, r0, den);
            if (x == 0 || x >= a1) return (0, a1);
            uint256 got = _swap(TOKEN1, TOKEN0, x, _quoteOut(x, sqrtP, false, fee), band, deadline);
            return (got, a1 - x);
        }
    }

    function _swapAll(address tokenIn, address tokenOut, uint256 amount, uint160 sqrtP, PriceBand calldata band, uint256 deadline)
        internal
        returns (uint256)
    {
        uint256 fee = POOL.fee();
        return _swap(tokenIn, tokenOut, amount, _quoteOut(amount, sqrtP, tokenIn == TOKEN0, fee), band, deadline);
    }

    /// @dev The output the current price promises for `x`, net of the pool fee (the quote the
    ///      adapter scales its floor from).
    function _quoteOut(uint256 x, uint160 sqrtP, bool zeroForOne, uint256 fee) internal pure returns (uint256 out) {
        out = zeroForOne
            ? Math.mulDiv(Math.mulDiv(x, sqrtP, Q96), sqrtP, Q96)
            : Math.mulDiv(Math.mulDiv(x, Q96, sqrtP), Q96, sqrtP);
        out = Math.mulDiv(out, PIPS - fee, PIPS);
    }

    /// @dev The to-ratio swap through the pool-direct adapter. The tolerance is the worst price the
    ///      caller's band allows, in output terms — (min / P)² selling token0, (P / max)² selling
    ///      token1 — capped at the adapter's own ceiling: the user's stated tolerance, never more.
    function _swap(address tokenIn, address tokenOut, uint256 x, uint256 quotedOut, PriceBand calldata band, uint256 deadline)
        internal
        returns (uint256 got)
    {
        (uint160 sqrtP,) = _readSlot0();
        uint256 keepBps = tokenIn == TOKEN0
            ? Math.mulDiv(Math.mulDiv(BPS, band.minSqrtPriceX96, sqrtP), band.minSqrtPriceX96, sqrtP)
            : Math.mulDiv(Math.mulDiv(BPS, sqrtP, band.maxSqrtPriceX96), sqrtP, band.maxSqrtPriceX96);
        uint256 tol = keepBps >= BPS ? 0 : BPS - keepBps;
        uint16 cap = SWAP.MAX_SLIPPAGE_BPS();
        if (tol > cap) tol = cap;
        bytes memory ret = _nested(
            address(SWAP),
            abi.encodeCall(
                ISwapAdapter.swap, (tokenIn, tokenOut, x, x, quotedOut, uint16(tol), deadline, abi.encode(TICK_SPACING))
            )
        );
        got = abi.decode(ret, (uint256));
        emit SwappedToRatio(msg.sender, tokenIn, x, got);
    }

    function _mint(int24 lower, int24 upper, uint256 a0, uint256 a1, uint256 deadline)
        internal
        returns (uint256 id, uint128 liquidity, uint256 used0, uint256 used1)
    {
        Call[] memory calls = new Call[](5);
        calls[0] = _approveCall(TOKEN0, address(NPM), a0);
        calls[1] = _approveCall(TOKEN1, address(NPM), a1);
        calls[2] = Call({
            target: address(NPM),
            value: 0,
            data: abi.encodeCall(
                ISlipstreamNpm.mint,
                (
                    ISlipstreamNpm.MintParams({
                        token0: TOKEN0,
                        token1: TOKEN1,
                        tickSpacing: TICK_SPACING,
                        tickLower: lower,
                        tickUpper: upper,
                        amount0Desired: a0,
                        amount1Desired: a1,
                        amount0Min: 0,
                        amount1Min: 0,
                        recipient: msg.sender,
                        deadline: deadline,
                        sqrtPriceX96: 0
                    })
                )
            ),
            callback: false
        });
        calls[3] = _approveCall(TOKEN0, address(NPM), 0);
        calls[4] = _approveCall(TOKEN1, address(NPM), 0);
        (id, liquidity, used0, used1) = abi.decode(_execMany(calls)[2], (uint256, uint128, uint256, uint256));
    }

    /// @dev Best effort: a gauge that is not alive, or refuses, leaves the NFT in the account.
    function _stake(uint256 id) internal returns (bool) {
        bool alive;
        try VOTER.isAlive(address(GAUGE)) returns (bool a) {
            alive = a;
        } catch {}
        if (!alive) {
            emit StakeSkipped(msg.sender, id, "gauge not alive");
            return false;
        }
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(NPM),
            value: 0,
            data: abi.encodeCall(ISlipstreamNpm.approve, (address(GAUGE), id)),
            callback: false
        });
        calls[1] = Call({target: address(GAUGE), value: 0, data: abi.encodeCall(ISlipstreamGauge.deposit, (id)), callback: false});
        try _account().execFromPeripheral(calls) {
            return true;
        } catch (bytes memory r) {
            emit StakeSkipped(msg.sender, id, r);
            return false;
        }
    }

    /// @dev Collect what `ids` have earned into the account and take the fee once per distinct
    ///      token. `unstake` = withdraw the NFT from the gauge (a close) rather than `getReward`.
    function _collect(uint256[] memory ids, bool unstake) internal returns (uint256 n0, uint256 n1, uint256 nr) {
        address acct = msg.sender;
        bool rewardIsPoolToken = REWARD_TOKEN == TOKEN0 || REWARD_TOKEN == TOKEN1;
        uint256 b0 = _bal(TOKEN0, acct);
        uint256 b1 = _bal(TOKEN1, acct);
        uint256 br = rewardIsPoolToken ? 0 : _bal(REWARD_TOKEN, acct);
        for (uint256 i = 0; i < ids.length; i++) {
            _collectOne(ids[i], unstake);
        }
        n0 = _takeFee(TOKEN0, acct, b0);
        n1 = _takeFee(TOKEN1, acct, b1);
        nr = rewardIsPoolToken ? 0 : _takeFee(REWARD_TOKEN, acct, br);
    }

    /// @dev One id's collect, fee taken; `ok` false with the reason when the gauge / NPM refused.
    function _tryCollectOne(uint256 id, bool unstake)
        internal
        returns (bool ok, uint256 n0, uint256 n1, uint256 nr, bytes memory reason)
    {
        address acct = msg.sender;
        bool rewardIsPoolToken = REWARD_TOKEN == TOKEN0 || REWARD_TOKEN == TOKEN1;
        uint256 b0 = _bal(TOKEN0, acct);
        uint256 b1 = _bal(TOKEN1, acct);
        uint256 br = rewardIsPoolToken ? 0 : _bal(REWARD_TOKEN, acct);
        try _account().execFromPeripheral(_collectCalls(id, unstake)) {
            ok = true;
        } catch (bytes memory r) {
            return (false, 0, 0, 0, r);
        }
        n0 = _takeFee(TOKEN0, acct, b0);
        n1 = _takeFee(TOKEN1, acct, b1);
        nr = rewardIsPoolToken ? 0 : _takeFee(REWARD_TOKEN, acct, br);
    }

    function _collectOne(uint256 id, bool unstake) internal {
        _execMany(_collectCalls(id, unstake));
    }

    /// @dev Staked: the gauge pays the reward (`withdraw` also hands the NFT back). Unstaked: the
    ///      NPM pays the accrued trading fees to the account.
    function _collectCalls(uint256 id, bool unstake) internal view returns (Call[] memory calls) {
        calls = new Call[](1);
        if (GAUGE.stakedContains(msg.sender, id)) {
            calls[0] = Call({
                target: address(GAUGE),
                value: 0,
                data: unstake ? abi.encodeCall(ISlipstreamGauge.withdraw, (id)) : abi.encodeCall(ISlipstreamGauge.getReward, (id)),
                callback: false
            });
        } else {
            calls[0] = Call({
                target: address(NPM),
                value: 0,
                data: abi.encodeCall(
                    ISlipstreamNpm.collect,
                    (ISlipstreamNpm.CollectParams({tokenId: id, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max}))
                ),
                callback: false
            });
        }
    }

    /// @dev decrease → collect → burn, in one atomic batch from the account; principal measured
    ///      as the account's balance deltas, untaxed.
    function _withdrawPrincipal(uint256 id) internal returns (uint256 p0, uint256 p1) {
        address acct = msg.sender;
        uint256 b0 = _bal(TOKEN0, acct);
        uint256 b1 = _bal(TOKEN1, acct);
        _execMany(_principalCalls(id));
        p0 = _gain(TOKEN0, acct, b0);
        p1 = _gain(TOKEN1, acct, b1);
    }

    function _tryWithdrawPrincipal(uint256 id) internal returns (bool ok, uint256 p0, uint256 p1, bytes memory reason) {
        address acct = msg.sender;
        uint256 b0 = _bal(TOKEN0, acct);
        uint256 b1 = _bal(TOKEN1, acct);
        try _account().execFromPeripheral(_principalCalls(id)) {
            ok = true;
            p0 = _gain(TOKEN0, acct, b0);
            p1 = _gain(TOKEN1, acct, b1);
        } catch (bytes memory r) {
            reason = r;
        }
    }

    function _principalCalls(uint256 id) internal view returns (Call[] memory calls) {
        (,,,,,,, uint128 liquidity,,,,) = NPM.positions(id);
        uint256 n = liquidity != 0 ? 3 : 2;
        calls = new Call[](n);
        uint256 k;
        if (liquidity != 0) {
            calls[k++] = Call({
                target: address(NPM),
                value: 0,
                data: abi.encodeCall(
                    ISlipstreamNpm.decreaseLiquidity,
                    (
                        ISlipstreamNpm.DecreaseLiquidityParams({
                            tokenId: id,
                            liquidity: liquidity,
                            amount0Min: 0,
                            amount1Min: 0,
                            deadline: block.timestamp
                        })
                    )
                ),
                callback: false
            });
        }
        calls[k++] = Call({
            target: address(NPM),
            value: 0,
            data: abi.encodeCall(
                ISlipstreamNpm.collect,
                (ISlipstreamNpm.CollectParams({tokenId: id, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max}))
            ),
            callback: false
        });
        calls[k++] = Call({target: address(NPM), value: 0, data: abi.encodeCall(ISlipstreamNpm.burn, (id)), callback: false});
    }

    /// @dev Fee on what `acct` gained in `token` since `before`; pays the treasury from the account.
    ///      Best effort: a treasury that cannot receive never blocks the user's exit.
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

    // ---- ownership and pool checks

    function _requireOwned(uint256 id) internal view {
        if (!_owned(id)) revert NotPositionOwner(id, _npmOwner(id));
    }

    function _owned(uint256 id) internal view returns (bool) {
        return _ownedBy(id, msg.sender);
    }

    function _ownedBy(uint256 id, address account) internal view returns (bool) {
        if (GAUGE.stakedContains(account, id)) return true;
        return _npmOwner(id) == account && _isThisPool(id);
    }

    function _npmOwner(uint256 id) internal view returns (address owner) {
        try NPM.ownerOf(id) returns (address o) {
            owner = o;
        } catch {}
    }

    function _isThisPool(uint256 id) internal view returns (bool) {
        try NPM.positions(id) returns (
            uint96, address, address t0, address t1, int24 ts, int24, int24, uint128, uint256, uint256, uint128, uint128
        ) {
            return t0 == TOKEN0 && t1 == TOKEN1 && ts == TICK_SPACING;
        } catch {
            return false;
        }
    }

    // ---- ticks and prices

    /// @dev A range of about `width` ticks centred on `tick`, rounded outward to the pool's
    ///      spacing so the current tick is strictly inside it.
    function _centredTicks(int24 tick, uint24 width) internal view returns (int24 lower, int24 upper) {
        int24 w = int24(width);
        int24 half = w / 2;
        lower = _floorTo(tick - half, TICK_SPACING);
        upper = _ceilTo(tick + (w - half), TICK_SPACING);
        if (upper <= lower) upper = lower + TICK_SPACING;
        if (lower <= tick - w - TICK_SPACING || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK) {
            revert InvalidWidth(width);
        }
        if (!(lower < tick && tick < upper)) revert RangeExcludesPrice(tick, lower, upper);
    }

    function _floorTo(int24 t, int24 s) internal pure returns (int24) {
        int24 q = t / s;
        if (t < 0 && t % s != 0) q -= 1;
        return q * s;
    }

    function _ceilTo(int24 t, int24 s) internal pure returns (int24) {
        int24 q = t / s;
        if (t > 0 && t % s != 0) q += 1;
        return q * s;
    }

    function _tickOf(uint160) internal view returns (int24 tick) {
        (, tick) = _readSlot0();
    }

    function _validate(uint24 width, uint64 delay, uint256 deadline) internal view {
        if (width < MIN_WIDTH_BPS || width > MAX_WIDTH_BPS) revert InvalidWidth(width);
        if (delay > MAX_REBALANCE_DELAY) revert InvalidDelay(delay);
        if (deadline < block.timestamp) revert Expired(deadline);
    }

    function _checkBand(PriceBand calldata band) internal view returns (uint160 sqrtP, int24 tick) {
        if (band.minSqrtPriceX96 == 0 || band.maxSqrtPriceX96 == 0 || band.minSqrtPriceX96 > band.maxSqrtPriceX96) {
            revert BandRequired();
        }
        if (uint256(band.maxSqrtPriceX96) * BPS > uint256(band.minSqrtPriceX96) * (BPS + MAX_BAND_BPS)) {
            revert BandTooWide(band.minSqrtPriceX96, band.maxSqrtPriceX96, MAX_BAND_BPS);
        }
        (sqrtP, tick) = _readSlot0();
        if (sqrtP < band.minSqrtPriceX96 || sqrtP > band.maxSqrtPriceX96) {
            revert PriceOutOfBand(sqrtP, band.minSqrtPriceX96, band.maxSqrtPriceX96);
        }
    }

    /// @dev slot0().sqrtPriceX96 and tick, failing closed on any read problem.
    function _readSlot0() internal view returns (uint160 sqrtP, int24 tick) {
        address pool = address(POOL);
        if (pool.code.length == 0) revert PriceUnreadable(pool);
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSelector(IAerodromeCLPool.slot0.selector));
        if (!ok || ret.length < 64) revert PriceUnreadable(pool);
        uint256 word0;
        int256 word1;
        assembly ("memory-safe") {
            word0 := mload(add(ret, 0x20))
            word1 := mload(add(ret, 0x40))
        }
        if (word0 == 0 || word0 > type(uint160).max) revert PriceUnreadable(pool);
        if (word1 < TickMath.MIN_TICK || word1 > TickMath.MAX_TICK) revert PriceUnreadable(pool);
        sqrtP = uint160(word0);
        tick = int24(word1);
    }

    function _gain(address token, address acct, uint256 before) internal view returns (uint256) {
        uint256 after_ = _bal(token, acct);
        return after_ > before ? after_ - before : 0;
    }

    /// @dev A nested peripheral call from the account (the pool-direct adapter for the to-ratio swap).
    function _nested(address peripheral, bytes memory data) internal returns (bytes memory) {
        return _account().execNestedPeripheral(peripheral, 0, data);
    }

    /// @dev Raw balance read: a token whose balanceOf cannot be decoded reads as 0 rather than
    ///      bricking a claim or exit.
    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (who)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}
