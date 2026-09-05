// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Permit2 SignatureTransfer surface (canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3,
///         code presence verified on Base). The user signs a `PermitTransferFrom` with
///         `spender` = their OilskinAccount address (known in advance via the factory); the account
///         calls `permitTransferFrom` with itself as `to`, so the router never touches the tokens.
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
