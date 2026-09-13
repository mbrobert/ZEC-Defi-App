// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMessageTransmitterV2, ITokenMessengerV2} from "../../src/interfaces/ICctpV2.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice The CCTP V2 message byte layout (`docs/VERIFIED-SOLANA-FACTS.md` Addendum 3; Circle's technical
///         guide): a 148-byte header and a 228-byte BurnMessageV2 body, big-endian, plus hook data. The
///         mocks below build and parse exactly this so a Foundry test can hand a message from "Solana" to
///         `receiveMessage` and read the message a burn emits, byte for byte as the real transmitter would.
library CctpMessageV2 {
    uint256 internal constant HEADER_LEN = 148;
    uint256 internal constant BODY_LEN = 228;

    struct Header {
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        uint32 minFinalityThreshold;
        uint32 finalityThresholdExecuted;
    }

    struct BurnBody {
        uint32 version;
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
        uint256 maxFee;
        uint256 feeExecuted;
        uint256 expirationBlock;
        bytes hookData;
    }

    function encodeHeader(Header memory h) internal pure returns (bytes memory) {
        return abi.encodePacked(
            h.version,
            h.sourceDomain,
            h.destinationDomain,
            h.nonce,
            h.sender,
            h.recipient,
            h.destinationCaller,
            h.minFinalityThreshold,
            h.finalityThresholdExecuted
        );
    }

    function encodeBody(BurnBody memory b) internal pure returns (bytes memory) {
        bytes memory fixedPart = abi.encodePacked(b.version, b.burnToken, b.mintRecipient, b.amount, b.messageSender);
        return bytes.concat(fixedPart, abi.encodePacked(b.maxFee, b.feeExecuted, b.expirationBlock), b.hookData);
    }

    function encode(Header memory h, BurnBody memory b) internal pure returns (bytes memory) {
        return bytes.concat(encodeHeader(h), encodeBody(b));
    }

    function u32At(bytes memory m, uint256 o) internal pure returns (uint32 v) {
        require(m.length >= o + 4, "CctpMessageV2: short");
        assembly ("memory-safe") {
            v := shr(224, mload(add(add(m, 32), o)))
        }
    }

    function b32At(bytes memory m, uint256 o) internal pure returns (bytes32 v) {
        require(m.length >= o + 32, "CctpMessageV2: short");
        assembly ("memory-safe") {
            v := mload(add(add(m, 32), o))
        }
    }

    function decode(bytes memory m) internal pure returns (Header memory h, BurnBody memory b) {
        require(m.length >= HEADER_LEN + BODY_LEN, "CctpMessageV2: too short");
        h.version = u32At(m, 0);
        h.sourceDomain = u32At(m, 4);
        h.destinationDomain = u32At(m, 8);
        h.nonce = b32At(m, 12);
        h.sender = b32At(m, 44);
        h.recipient = b32At(m, 76);
        h.destinationCaller = b32At(m, 108);
        h.minFinalityThreshold = u32At(m, 140);
        h.finalityThresholdExecuted = u32At(m, 144);
        uint256 o = HEADER_LEN;
        b.version = u32At(m, o);
        b.burnToken = b32At(m, o + 4);
        b.mintRecipient = b32At(m, o + 36);
        b.amount = uint256(b32At(m, o + 68));
        b.messageSender = b32At(m, o + 100);
        b.maxFee = uint256(b32At(m, o + 132));
        b.feeExecuted = uint256(b32At(m, o + 164));
        b.expirationBlock = uint256(b32At(m, o + 196));
        uint256 hookLen = m.length - HEADER_LEN - BODY_LEN;
        b.hookData = new bytes(hookLen);
        for (uint256 i = 0; i < hookLen; i++) {
            b.hookData[i] = m[HEADER_LEN + BODY_LEN + i];
        }
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev The inverse; refuses a value whose top 12 bytes are not zero (it is not an EVM address).
    function toAddress(bytes32 b) internal pure returns (address) {
        require(uint256(b) >> 160 == 0, "CctpMessageV2: not an EVM address");
        return address(uint160(uint256(b)));
    }
}

/// @notice MessageTransmitterV2 double: `sendMessage` (only its messenger) builds the header and emits
///         `MessageSent` with the full message; `receiveMessage` checks the domain, the caller and the nonce
///         the way the real one does — and TRUSTS ANY NON-EMPTY ATTESTATION, which is the one thing the
///         real transmitter does not (2-of-2 attester signatures, Addendum 3). Every accepted message is
///         handed to the messenger, which mints.
contract MockMessageTransmitterV2 is IMessageTransmitterV2 {
    uint32 public immutable override localDomain;
    uint32 public immutable override version;
    MockTokenMessengerV2 public messenger;
    mapping(bytes32 => uint256) public override usedNonces;
    bool public override paused;
    uint256 public nonceCounter;
    bytes public lastMessage;

    error NotTheMessenger();
    error WrongDestinationDomain(uint32 got, uint32 want);
    error NonceUsed(bytes32 nonce);
    error NotTheDestinationCaller(bytes32 want, address got);
    error EmptyAttestation();
    error Paused();
    error UnknownVersion(uint32 v);

    constructor(uint32 localDomain_, uint32 version_) {
        localDomain = localDomain_;
        version = version_;
    }

    function setMessenger(MockTokenMessengerV2 m) external {
        messenger = m;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        if (msg.sender != address(messenger)) revert NotTheMessenger();
        nonceCounter++;
        bytes memory header = abi.encodePacked(
            version,
            localDomain,
            destinationDomain,
            bytes32(nonceCounter),
            CctpMessageV2.toBytes32(msg.sender),
            recipient,
            destinationCaller,
            minFinalityThreshold,
            uint32(0)
        );
        lastMessage = bytes.concat(header, messageBody);
        emit MessageSent(lastMessage);
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external override returns (bool) {
        if (paused) revert Paused();
        if (attestation.length == 0) revert EmptyAttestation();
        (CctpMessageV2.Header memory h, CctpMessageV2.BurnBody memory b) = CctpMessageV2.decode(message);
        if (h.version != version) revert UnknownVersion(h.version);
        if (h.destinationDomain != localDomain) revert WrongDestinationDomain(h.destinationDomain, localDomain);
        if (h.destinationCaller != bytes32(0) && h.destinationCaller != CctpMessageV2.toBytes32(msg.sender)) {
            revert NotTheDestinationCaller(h.destinationCaller, msg.sender);
        }
        if (usedNonces[h.nonce] != 0) revert NonceUsed(h.nonce);
        usedNonces[h.nonce] = 1;
        messenger.handleReceive(h, b);
        emit MessageReceived(msg.sender, h.sourceDomain, h.nonce, h.sender, h.finalityThresholdExecuted, message[CctpMessageV2.HEADER_LEN:]);
        return true;
    }
}

/// @notice TokenMessengerV2 double over a `MockERC20` USDC: `depositForBurn` pulls the approved amount from
///         the depositor and BURNS it (the supply falls, as on the real contract), refuses a denylisted
///         depositor, an unknown destination, a fee not below the amount and an amount above the
///         per-message cap, then sends the burn body through the transmitter. A received burn mints
///         `amount − feeExecuted` to the recipient and the fee to `feeRecipient`.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    MockERC20 public immutable usdc;
    MockMessageTransmitterV2 public immutable transmitter;
    uint32 public immutable override messageBodyVersion;
    address public feeRecipient;
    uint256 public burnLimitPerMessage;
    mapping(uint32 => bytes32) public override remoteTokenMessengers;
    mapping(address => bool) public override isDenylisted;
    /// @dev The fee the "destination" will execute on the next received burn, as a share in bps of the amount.
    uint256 public feeExecutedBps;
    uint256 public burnCount;

    error ZeroAmount();
    error MaxFeeNotBelowAmount(uint256 maxFee, uint256 amount);
    error UnknownDestination(uint32 domain);
    error Denylisted(address account);
    error AboveBurnLimit(uint256 amount, uint256 limit);
    error NotTheTransmitter();
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error WrongBurnToken(bytes32 burnToken);

    constructor(MockERC20 usdc_, MockMessageTransmitterV2 transmitter_, uint32 bodyVersion, address feeRecipient_, uint256 burnLimit) {
        usdc = usdc_;
        transmitter = transmitter_;
        messageBodyVersion = bodyVersion;
        feeRecipient = feeRecipient_;
        burnLimitPerMessage = burnLimit;
    }

    function addRemoteTokenMessenger(uint32 domain, bytes32 remote) external {
        remoteTokenMessengers[domain] = remote;
    }

    function setDenylisted(address a, bool v) external {
        isDenylisted[a] = v;
    }

    function setFeeExecutedBps(uint256 bps) external {
        feeExecutedBps = bps;
    }

    function localMessageTransmitter() external view override returns (address) {
        return address(transmitter);
    }

    function localMinter() external view override returns (address) {
        return address(this);
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external override {
        if (amount == 0) revert ZeroAmount();
        if (maxFee >= amount) revert MaxFeeNotBelowAmount(maxFee, amount);
        if (isDenylisted[msg.sender]) revert Denylisted(msg.sender);
        if (burnToken != address(usdc)) revert WrongBurnToken(CctpMessageV2.toBytes32(burnToken));
        if (amount > burnLimitPerMessage) revert AboveBurnLimit(amount, burnLimitPerMessage);
        bytes32 remote = remoteTokenMessengers[destinationDomain];
        if (remote == bytes32(0)) revert UnknownDestination(destinationDomain);
        usdc.transferFrom(msg.sender, address(this), amount);
        usdc.burn(address(this), amount);
        burnCount++;
        bytes memory body = CctpMessageV2.encodeBody(
            CctpMessageV2.BurnBody({
                version: messageBodyVersion,
                burnToken: CctpMessageV2.toBytes32(burnToken),
                mintRecipient: mintRecipient,
                amount: amount,
                messageSender: CctpMessageV2.toBytes32(msg.sender),
                maxFee: maxFee,
                feeExecuted: 0,
                expirationBlock: block.number + 7200,
                hookData: ""
            })
        );
        transmitter.sendMessage(destinationDomain, remote, destinationCaller, minFinalityThreshold, body);
        emit DepositForBurn(burnToken, amount, msg.sender, mintRecipient, destinationDomain, remote, destinationCaller, maxFee, minFinalityThreshold, "");
    }

    /// @dev Called by the transmitter for an accepted message: mint `amount − fee` to the recipient.
    function handleReceive(CctpMessageV2.Header memory, CctpMessageV2.BurnBody memory b) external {
        if (msg.sender != address(transmitter)) revert NotTheTransmitter();
        uint256 fee = b.feeExecuted != 0 ? b.feeExecuted : (b.amount * feeExecutedBps) / 10_000;
        if (fee > b.maxFee) revert FeeAboveMax(fee, b.maxFee);
        address to = CctpMessageV2.toAddress(b.mintRecipient);
        usdc.mint(to, b.amount - fee);
        if (fee != 0) usdc.mint(feeRecipient, fee);
    }
}
