// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth} from "../../src/interfaces/IPyth.sol";

/// @notice Pyth double: pull-based. `updatePriceFeeds` takes abi.encode(id, price, conf, expo,
///         publishTime) blobs and charges `feePerUpdate` each; `getPriceNoOlderThan` reverts
///         StalePrice past `age` (the real contract's behaviour); `getPriceUnsafe` never reverts.
contract MockPyth is IPyth {
    error StalePrice();
    error PriceFeedNotFound();
    error InsufficientFee();

    uint256 public feePerUpdate = 1 wei;
    mapping(bytes32 => Price) internal prices;
    mapping(bytes32 => bool) internal known;

    function setFee(uint256 f) external {
        feePerUpdate = f;
    }

    /// @dev Direct set, for the "stale on chain" starting state.
    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)
        external
    {
        prices[id] = Price(price, conf, expo, publishTime);
        known[id] = true;
    }

    function encodeUpdate(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(id, price, conf, expo, publishTime);
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < feePerUpdate * updateData.length) revert InsufficientFee();
        for (uint256 i = 0; i < updateData.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint256));
            if (!known[id] || publishTime >= prices[id].publishTime) {
                prices[id] = Price(price, conf, expo, publishTime);
                known[id] = true;
            }
        }
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        if (!known[id]) revert PriceFeedNotFound();
        p = prices[id];
        if (block.timestamp > p.publishTime && block.timestamp - p.publishTime > age) {
            revert StalePrice();
        }
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        if (!known[id]) revert PriceFeedNotFound();
        return prices[id];
    }
}
