// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {Call, IOilskinAccount} from "../interfaces/IOilskinAccount.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {ICLSwapCallback, ISlipstreamPool} from "../interfaces/ISlipstream.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title SlipstreamPoolSwapAdapter — ISwapAdapter over ONE Slipstream pool's own `swap`, for the pool
///        the verified SwapRouter cannot reach (the cbZEC/USDC pool on the second CLFactory,
///        `VERIFIED-BASE-FACTS.md` Addendum 8: `exactInputSingle` reverts with no data for that pair).
///
/// @notice Called BY an OilskinAccount. The adapter is `msg.sender` to the pool so the pool's
///         `uniswapV3SwapCallback` lands here; the callback pays the pool EXACTLY the positive delta
///         the pool reports, from the calling account, and nothing else. The recipient of the output
///         is always the calling account. No storage beyond immutables; the swap-in-flight context
///         lives in transient storage and is gone when the call returns.
///
/// @dev Same floor rule as `AerodromeSwapAdapter`: `minOutFor` is derived from the caller's quote,
///      scaled to the input, tolerance capped on chain. Two things are STRICTER here, because the
///      pool is called directly: (1) the output is MEASURED as the account's balance delta, not
///      taken from a return value; (2) a swap the pool could not fill in full (exact input with
///      liquidity running out) is refused by name — the SwapRouter would have refused it through
///      `amountOutMinimum`, and a silent partial fill would leave the unwind's leg half-swapped.
///      The callback accepts only the bound pool, only while a swap is in flight, and only once.
contract SlipstreamPoolSwapAdapter is ISwapAdapter, ICLSwapCallback, Peripheral {
    ISlipstreamPool public immutable POOL;
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    int24 public immutable TICK_SPACING;

    uint256 public constant BPS = 10_000;
    /// @inheritdoc ISwapAdapter
    uint16 public constant override MAX_SLIPPAGE_BPS = 500; // 5 %

    // Transient (EIP-1153) context of the swap in flight: the calling account, the input token, and
    // whether the callback has already paid. Labelled hashes, no storage layout to collide with.
    uint256 private constant T_ACCOUNT = uint256(keccak256("oilskin.slipstream.swap.account")) - 1;
    uint256 private constant T_TOKEN_IN = uint256(keccak256("oilskin.slipstream.swap.tokenIn")) - 1;
    uint256 private constant T_PAID = uint256(keccak256("oilskin.slipstream.swap.paid")) - 1;

    error ZeroAddress();
    error ZeroAmount();
    error ZeroQuote();
    error SlippageTooHigh(uint16 bps, uint16 cap);
    error Expired(uint256 deadline);
    error SameToken();
    /// @notice The pair is not this pool's (token0, token1) in either direction.
    error NotPoolPair(address tokenIn, address tokenOut);
    /// @notice `routeData` names another tick spacing than the pool's — the caller quoted another pool.
    error WrongRoute(int24 given, int24 expected);
    /// @notice The callback came from something other than the bound pool.
    error NotPool(address caller);
    /// @notice The callback came while no swap was in flight, or a second time for one swap.
    error NoSwapInFlight();
    /// @notice The pool consumed less than `amountIn` (liquidity ran out): refused, never half-done.
    error PartialFill(uint256 amountIn, uint256 consumed);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error Reentrancy();

    event Swapped(
        address indexed account,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minOut
    );

    constructor(ISlipstreamPool pool) {
        if (address(pool) == address(0)) revert ZeroAddress();
        POOL = pool;
        TOKEN0 = pool.token0();
        TOKEN1 = pool.token1();
        TICK_SPACING = pool.tickSpacing();
        if (TOKEN0 == address(0) || TOKEN1 == address(0)) revert ZeroAddress();
        if (TOKEN0 == TOKEN1) revert SameToken();
    }

    /// @inheritdoc ISwapAdapter
    function minOutFor(uint256 amountIn, uint256 quotedIn, uint256 quotedOut, uint16 maxSlippageBps)
        public
        pure
        override
        returns (uint256)
    {
        if (quotedIn == 0 || quotedOut == 0) revert ZeroQuote();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps, MAX_SLIPPAGE_BPS);
        return (amountIn * quotedOut * (BPS - maxSlippageBps)) / (quotedIn * BPS);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev Invariant: recipient = calling account; the floor is `minOutFor(amountIn, …)` and is
    ///      compared to what the account ACTUALLY received (balance delta); the input consumed is
    ///      exactly `amountIn` or the call reverts `PartialFill`; the callback pays only the bound
    ///      pool, only during this call, only once; no allowance is ever granted to anyone.
    ///      `routeData` = `abi.encode(int24 tickSpacing)`, the same shape the SwapRouter adapter
    ///      takes, and it must be this pool's.
    /// @dev Slither `reentrancy-eth` ("stale balance used after the call"), triaged 2026-09-12
    ///      (AUDIT-2026-09-12.md): the balance DELTA across the swap is the floor check by design —
    ///      read before, read after, compare — and this adapter holds nothing of its own between
    ///      calls. Proved by SlipstreamLpVenue.t.sol and the T_PAID in-flight guard on the callback.
    // slither-disable-next-line reentrancy-eth
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quotedIn,
        uint256 quotedOut,
        uint16 maxSlippageBps,
        uint256 deadline,
        bytes calldata routeData
    ) external override returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert Expired(deadline);
        if (tokenIn == tokenOut) revert SameToken();
        if (_tload(T_ACCOUNT) != 0) revert Reentrancy();
        uint256 minOut = minOutFor(amountIn, quotedIn, quotedOut, maxSlippageBps);
        if (minOut == 0) revert ZeroQuote();
        bool zeroForOne;
        if (tokenIn == TOKEN0 && tokenOut == TOKEN1) zeroForOne = true;
        else if (tokenIn == TOKEN1 && tokenOut == TOKEN0) zeroForOne = false;
        else revert NotPoolPair(tokenIn, tokenOut);
        int24 ts = abi.decode(routeData, (int24));
        if (ts != TICK_SPACING) revert WrongRoute(ts, TICK_SPACING);
        if (amountIn > uint256(type(int256).max)) revert ZeroAmount();

        address account = msg.sender;
        uint256 inBefore = IERC20(tokenIn).balanceOf(account);
        uint256 outBefore = IERC20(tokenOut).balanceOf(account);

        _tstore(T_ACCOUNT, uint256(uint160(account)));
        _tstore(T_TOKEN_IN, uint256(uint160(tokenIn)));
        _tstore(T_PAID, 0);
        // Exact input, no price limit beyond the tick bounds: the floor below is the protection.
        POOL.swap(
            account,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            ""
        );
        bool paid = _tload(T_PAID) != 0;
        _tstore(T_ACCOUNT, 0);
        _tstore(T_TOKEN_IN, 0);
        _tstore(T_PAID, 0);
        if (!paid) revert NoSwapInFlight();

        uint256 inAfter = IERC20(tokenIn).balanceOf(account);
        uint256 consumed = inBefore > inAfter ? inBefore - inAfter : 0;
        if (consumed != amountIn) revert PartialFill(amountIn, consumed);
        uint256 outAfter = IERC20(tokenOut).balanceOf(account);
        amountOut = outAfter > outBefore ? outAfter - outBefore : 0;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(account, tokenIn, tokenOut, amountIn, amountOut, minOut);
    }

    /// @inheritdoc ICLSwapCallback
    /// @dev Invariant: only the bound pool, only while `swap` is in flight, only once per swap; pays
    ///      the positive delta of the input token from the calling account to the pool via
    ///      `execFromPeripheral` (charged to the keeper's budget on the keeper path like any
    ///      transfer), never the other token, never more than the pool reports.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != address(POOL)) revert NotPool(msg.sender);
        address account = address(uint160(_tload(T_ACCOUNT)));
        if (account == address(0) || _tload(T_PAID) != 0) revert NoSwapInFlight();
        _tstore(T_PAID, 1);
        address tokenIn = address(uint160(_tload(T_TOKEN_IN)));
        int256 owed = tokenIn == TOKEN0 ? amount0Delta : amount1Delta;
        if (owed <= 0) return;
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: tokenIn,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (address(POOL), uint256(owed))),
            callback: false
        });
        // `msg.sender` is the pool here, so the account is the one recorded at `swap`.
        IOilskinAccount(account).execFromPeripheral(calls);
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
