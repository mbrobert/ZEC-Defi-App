// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICLSwapCallback} from "../../src/interfaces/ISlipstream.sol";

/// @notice Test double for an Aerodrome Slipstream (CL) pool: the verified surface (FACT 5) —
///         `slot0()`, `liquidity()`, `token0()`, `token1()`, `tickSpacing()`, `fee()` — plus a
///         UniV3-style `observe()` for the TWAP breaker, switches that make `slot0()` revert or
///         return short data so fail-closed paths can be proved, and (2026-09-11, the direct
///         Slipstream venue) the second deployment's surface: `swap` with the
///         `uniswapV3SwapCallback` payment rule copied from the verified `CLPool.sol` (output sent
///         to the recipient FIRST, then the callback, then the balance check "IIA"), `gauge()`,
///         `nft()`, `factory()`, and the token custody the mock position manager settles through.
contract MockCLPool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    int24 public immutable tickSpacing;
    uint24 public fee;

    uint160 public sqrtPriceX96;
    int24 public tick;
    uint128 public liquidity;

    /// @dev TWAP tick returned by observe() for any window.
    int24 public twapTick;

    address public gauge;
    address public nft;
    address public factory;

    /// @dev Basis points the price moves AGAINST the swapper after each swap (a modelled impact).
    uint256 public impactBps;
    /// @dev Basis points of the promised output the pool withholds — a pool that pays less than it
    ///      says, so a floor checked on a return value would be fooled.
    uint256 public shortPayBps;
    /// @dev Basis points of the requested input the pool actually consumes (liquidity running out);
    ///      0 = all of it.
    uint256 public fillBps;

    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant PIPS = 1_000_000;
    uint256 private constant BPS = 10_000;

    enum Mode {
        Normal,
        Revert,
        ShortReturn
    }

    Mode public mode;

    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96);

    constructor(address t0, address t1, int24 spacing, uint24 fee_, uint160 sqrtPrice) {
        token0 = t0;
        token1 = t1;
        tickSpacing = spacing;
        fee = fee_;
        sqrtPriceX96 = sqrtPrice;
        liquidity = 15_382_171_343_960; // the live cbZEC/USDC figure, for realism only
    }

    // ------------------------------------------------------------ test hooks

    function setSqrtPrice(uint160 p) external {
        sqrtPriceX96 = p;
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function setTwapTick(int24 t) external {
        twapTick = t;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setFee(uint24 f) external {
        fee = f;
    }

    function setGaugeAndNft(address gauge_, address nft_, address factory_) external {
        gauge = gauge_;
        nft = nft_;
        factory = factory_;
    }

    function setImpactBps(uint256 bps) external {
        impactBps = bps;
    }

    function setShortPayBps(uint256 bps) external {
        shortPayBps = bps;
    }

    function setFillBps(uint256 bps) external {
        fillBps = bps;
    }

    /// @dev The mock position manager settles principal and fees out of the pool's custody.
    function payout(address token, address to, uint256 amount) external {
        require(msg.sender == nft, "only nft");
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }

    // ------------------------------------------------------------ pool surface

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, bool)
    {
        if (mode == Mode.Revert) revert("slot0 unavailable");
        if (mode == Mode.ShortReturn) {
            assembly {
                mstore(0, 0)
                return(0, 8) // 8 bytes: shorter than one word
            }
        }
        return (sqrtPriceX96, tick, 0, 1, 1, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (mode == Mode.Revert) revert("observe unavailable");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        // cumulative = twapTick * (T - secondsAgo) for a constant-tick history.
        int56 base = int56(int256(uint256(block.timestamp))) * 1;
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            int56 t = base - int56(uint56(secondsAgos[i]));
            tickCumulatives[i] = int56(twapTick) * t;
        }
    }

    /// @notice Exact-input swap at the current price less the fee; the verified payment rule.
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "AS");
        require(
            zeroForOne ? sqrtPriceLimitX96 < sqrtPriceX96 : sqrtPriceLimitX96 > sqrtPriceX96,
            "SPL"
        );
        uint256 amountIn = uint256(amountSpecified);
        if (fillBps != 0) amountIn = Math.mulDiv(amountIn, fillBps, BPS);
        uint256 net = Math.mulDiv(amountIn, PIPS - fee, PIPS);
        uint256 out = zeroForOne
            ? Math.mulDiv(Math.mulDiv(net, sqrtPriceX96, Q96), sqrtPriceX96, Q96)
            : Math.mulDiv(Math.mulDiv(net, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        uint256 paid = out - Math.mulDiv(out, shortPayBps, BPS);
        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(out);
            if (paid != 0) IERC20(token1).safeTransfer(recipient, paid);
            uint256 before = IERC20(token0).balanceOf(address(this));
            ICLSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(before + amountIn <= IERC20(token0).balanceOf(address(this)), "IIA");
            if (impactBps != 0) sqrtPriceX96 = uint160(uint256(sqrtPriceX96) * (BPS - impactBps) / BPS);
        } else {
            amount0 = -int256(out);
            amount1 = int256(amountIn);
            if (paid != 0) IERC20(token0).safeTransfer(recipient, paid);
            uint256 before = IERC20(token1).balanceOf(address(this));
            ICLSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(before + amountIn <= IERC20(token1).balanceOf(address(this)), "IIA");
            if (impactBps != 0) sqrtPriceX96 = uint160(uint256(sqrtPriceX96) * (BPS + impactBps) / BPS);
        }
        emit Swap(msg.sender, recipient, amount0, amount1, sqrtPriceX96);
    }

    /// @notice Virtual-liquidity bookkeeping the gauge performs on the real pool; nothing here.
    function stake(int128, int24, int24, bool) external {}
}
