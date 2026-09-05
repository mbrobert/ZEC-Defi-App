// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Pyth surface (Base contract 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
///         Crypto.ZEC/USD id 0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24).
///         Pyth is PULL-based: the on-chain price is only as fresh as the last posted update, which
///         was 5.5 h old when VERIFIED-BASE-FACTS was written. Adapters must post an update in the
///         same transaction and enforce a max age.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @dev Reverts (StalePrice) when the stored price is older than `age` seconds.
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}
