// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";

/// @notice Permit2 test double with REAL EIP-712 verification of `PermitTransferFrom` (same type
///         strings and domain layout as Uniswap's Permit2, so a signature produced for this mock
///         has the same shape the live contract expects), unordered nonces, and the two
///         AllowanceTransfer entrypoints the account's keeper budget logic recognises.
contract MockPermit2 is IPermit2 {
    using SafeERC20 for IERC20;

    bytes32 private constant _TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant _PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    error SignatureExpired(uint256 deadline);
    error InvalidAmount(uint256 maxAmount);
    error InvalidNonce();
    error InvalidSigner();
    error AllowanceExpired(uint256 expiration);
    error InsufficientAllowance(uint256 amount);

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowance;

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, address(this))
        );
    }

    /// @notice Digest a signer must sign for (permit, spender). Exposed for tests.
    function hashPermit(PermitTransferFrom memory permit, address spender)
        public
        view
        returns (bytes32)
    {
        bytes32 permitted = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash = keccak256(
            abi.encode(_PERMIT_TRANSFER_FROM_TYPEHASH, permitted, spender, permit.nonce, permit.deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        if (block.timestamp > permit.deadline) revert SignatureExpired(permit.deadline);
        if (transferDetails.requestedAmount > permit.permitted.amount) {
            revert InvalidAmount(permit.permitted.amount);
        }
        _useNonce(owner, permit.nonce);
        address signer = ECDSA.recover(hashPermit(permit, msg.sender), signature);
        if (signer != owner) revert InvalidSigner();
        IERC20(permit.permitted.token).safeTransferFrom(
            owner, transferDetails.to, transferDetails.requestedAmount
        );
    }

    // ------------------------------------------------ AllowanceTransfer subset

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = PackedAllowance(amount, expiration, 0);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage a = allowance[from][token][msg.sender];
        if (block.timestamp > a.expiration) revert AllowanceExpired(a.expiration);
        if (a.amount < amount) revert InsufficientAllowance(a.amount);
        if (a.amount != type(uint160).max) a.amount -= amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }

    function _useNonce(address from, uint256 nonce) internal {
        uint256 wordPos = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        uint256 flipped = nonceBitmap[from][wordPos] ^= bit;
        if (flipped & bit == 0) revert InvalidNonce();
    }
}
