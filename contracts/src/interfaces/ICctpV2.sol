// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICctpV2 — the two Circle Cross-Chain Transfer Protocol (CCTP) V2 contracts the router and the
///        keeper touch on Base, transcribed from the VERIFIED implementations behind the proxies
///        (`docs/VERIFIED-SOLANA-FACTS.md` Addendum 3, read 2026-09-13: TokenMessengerV2 impl
///        `0x555E…3ec8`, MessageTransmitterV2 impl `0x7Db6…21e3`). Nothing here is typed from a document:
///        every selector and event topic is pinned to the compiled bundle by `scripts/verify-abi.mjs` and
///        `packages/shared/test/cctp.test.ts` recomputes them from the verified signatures.
///
/// @dev CCTP burns native USDC on the source chain and mints native USDC on the destination once Circle's
///      attesters (2 of 2 on both chains) have signed the message. `mintRecipient` is a `bytes32`: an EVM
///      address left-padded with 12 zero bytes; on Solana the recipient's USDC TOKEN ACCOUNT, not the
///      wallet that owns it. `destinationCaller` = 0 lets anyone deliver. `minFinalityThreshold`
///      1000 = Fast Transfer (seconds, fee-bearing), 2000 = Standard (source-chain finality, fee 0).
interface ITokenMessengerV2 {
    event DepositForBurn(
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 indexed minFinalityThreshold,
        bytes hookData
    );

    /// @notice Burn `amount` of `burnToken` from the caller (who must have approved this contract) for a
    ///         mint of `amount − feeExecuted` to `mintRecipient` on `destinationDomain`. `maxFee` bounds
    ///         the fee Circle may take at delivery; the call reverts when it is not below `amount`.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function localMessageTransmitter() external view returns (address);
    function localMinter() external view returns (address);
    function messageBodyVersion() external view returns (uint32);
    /// @notice The remote messenger for a domain as bytes32 (Solana's TokenMessengerMinterV2 program for 5).
    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);
    /// @notice Circle holds a denylist on the messenger: a denylisted depositor cannot burn.
    function isDenylisted(address account) external view returns (bool);
}

interface IMessageTransmitterV2 {
    event MessageSent(bytes message);
    event MessageReceived(
        address indexed caller,
        uint32 sourceDomain,
        bytes32 indexed nonce,
        bytes32 sender,
        uint32 indexed finalityThresholdExecuted,
        bytes messageBody
    );

    /// @notice Deliver an attested message: anyone may call; the mint lands at the message's own
    ///         `mintRecipient`, so the receiving account signs nothing.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);

    function localDomain() external view returns (uint32);
    function version() external view returns (uint32);
    function usedNonces(bytes32 nonce) external view returns (uint256);
    function paused() external view returns (bool);
}
