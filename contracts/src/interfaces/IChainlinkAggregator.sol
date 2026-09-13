// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IChainlinkAggregator — the subset of Chainlink's AggregatorV3Interface this repo reads.
/// @dev `decimals()` is NOT assumed to be 8. The Base ZEC/USD feed verified on 2026-09-13
///      (`docs/VERIFIED-BASE-FACTS.md` Addendum 16) reports **18**, while BTC/USD, ETH/USD, USDC/USD
///      and cbBTC/USD on the same chain report 8. Every consumer must read it and normalise; an
///      assumed 8 against that feed is wrong by 10^10.
interface IChainlinkAggregator {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
