// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Aerodrome Slipstream (CL) pool surface we rely on. Verified live on Base (AUDIT-FINDINGS
///         FACT 5, pool 0xb2cc…DC59 WETH/USDC; and VERIFIED-BASE-FACTS for the cbZEC/USDC pool
///         0x0Fc47C17AF86078d809358db1b4db2DeBC988566: token0 = USDC, token1 = cbZEC, tickSpacing 200).
///         `slot0()` (0x3850c7bd), `liquidity()`, `token0()`, `token1()`, `tickSpacing()`, `fee()`
///         exist; `gauge()` reverts on the pool (gauge is reached via the Voter).
interface IAerodromeCLPool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);

    /// @notice Uniswap-v3-style oracle: cumulative ticks at `secondsAgos` (used for the TWAP peg
    ///         breaker in PythOracleAdapter; must be probed on the live pool before v1.1 ships).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
