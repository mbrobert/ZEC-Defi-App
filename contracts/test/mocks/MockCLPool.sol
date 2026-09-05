// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for an Aerodrome Slipstream (CL) pool: the verified surface (FACT 5) —
///         `slot0()`, `liquidity()`, `token0()`, `token1()`, `tickSpacing()`, `fee()` — plus a
///         UniV3-style `observe()` for the TWAP breaker, and switches that make `slot0()` revert or
///         return short data so fail-closed paths can be proved.
contract MockCLPool {
    address public immutable token0;
    address public immutable token1;
    int24 public immutable tickSpacing;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    int24 public tick;
    uint128 public liquidity;

    /// @dev TWAP tick returned by observe() for any window.
    int24 public twapTick;

    enum Mode {
        Normal,
        Revert,
        ShortReturn
    }

    Mode public mode;

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
}
