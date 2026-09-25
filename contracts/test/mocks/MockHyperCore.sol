// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICoreWriter, IHyperCoreUsdcAdapter} from "../../src/interfaces/IHyperCore.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice CoreWriter's double: records every action's bytes in order and emits the real event's shape
///         (`RawAction(address indexed user, bytes data)`, topic read from a live log 2026-09-25). It does not
///         execute anything — on the real chain the action lands seconds later and cannot revert the sender.
contract MockCoreWriter is ICoreWriter {
    event RawAction(address indexed user, bytes data);

    bytes[] public actions;
    address[] public senders;

    function sendRawAction(bytes calldata data) external override {
        actions.push(data);
        senders.push(msg.sender);
        emit RawAction(msg.sender, data);
    }

    function count() external view returns (uint256) {
        return actions.length;
    }

    function last() external view returns (bytes memory) {
        return actions[actions.length - 1];
    }
}

/// @notice A read precompile's double, `vm.etch`ed at 0x800–0x810: answers an exact input with a scripted
///         output, reverts on an input nobody scripted (the real precompiles revert on a wrong shape too), and
///         can be told to fail so `PrecompileReadFailed` is exercised.
contract MockHyperCorePrecompile {
    mapping(bytes32 => bytes) internal _answers;
    mapping(bytes32 => bool) internal _scripted;
    bool public failAll;

    function script(bytes calldata input, bytes calldata output) external {
        _answers[keccak256(input)] = output;
        _scripted[keccak256(input)] = true;
    }

    function setFailAll(bool f) external {
        failAll = f;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        if (failAll) revert("mock precompile: failing");
        bytes32 k = keccak256(input);
        require(_scripted[k], "mock precompile: no scripted answer for this input");
        return _answers[k];
    }
}

/// @notice The USDC adapter's double: pulls the caller's USDC (an approval is needed, as on chain) and records
///         (caller, amount, dex). The real one then emits the linked `Transfer` and a CoreWriter `sendAsset`;
///         here nothing further happens — the test scripts the resulting HyperCore balance itself.
contract MockUsdcAdapter is IHyperCoreUsdcAdapter {
    struct Deposit {
        address from;
        uint256 amount;
        uint32 dex;
    }

    MockERC20 public immutable USDC;
    Deposit[] public deposits;
    bool public paused_;

    constructor(MockERC20 usdc) {
        USDC = usdc;
    }

    function deposit(uint256 amount, uint32 destinationDex) external override {
        require(!paused_, "adapter paused");
        require(USDC.transferFrom(msg.sender, address(this), amount), "pull failed");
        deposits.push(Deposit({from: msg.sender, amount: amount, dex: destinationDex}));
    }

    function token() external view override returns (address) {
        return address(USDC);
    }

    function paused() external view override returns (bool) {
        return paused_;
    }

    function setPaused(bool p) external {
        paused_ = p;
    }

    function count() external view returns (uint256) {
        return deposits.length;
    }
}
