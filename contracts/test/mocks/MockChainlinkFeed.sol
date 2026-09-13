// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A Chainlink AggregatorV3 double with every field the adapter gates on settable, so the
///         fail-closed paths can be proved: a non-positive answer, an incomplete round
///         (`answeredInRound < roundId`), a zero or future `updatedAt`, and an aged one. `decimals`
///         is a constructor argument because the live Base ZEC/USD feed reports 18 while every other
///         Chainlink feed this repo reads reports 8 (VERIFIED-BASE-FACTS Addendum 16).
contract MockChainlinkFeed {
    uint8 public immutable decimals;
    string public description;

    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    bool public reverting;

    error FeedDown();

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    function setAnswer(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = updatedAt_;
        updatedAt = updatedAt_;
    }

    function setRound(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function setReverting(bool on) external {
        reverting = on;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverting) revert FeedDown();
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
