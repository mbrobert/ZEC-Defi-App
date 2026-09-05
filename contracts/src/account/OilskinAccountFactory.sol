// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {OilskinAccount} from "./OilskinAccount.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";

/// @title OilskinAccountFactory — CREATE2 (EIP-1167) clones, one per owner, address known in advance.
///
/// @notice `accountOf(owner)` is deterministic before deployment, so the web can quote the account
///         address (and a Permit2 spender) to a first-time user before anything exists on chain.
///         `createAccount(owner)` may be called by anyone but only ever deploys the account of the
///         named owner; it is idempotent. `createAccountAndExec` gives a first-time user a single
///         transaction: deploy the account and run an owner batch (e.g. the router open) at once.
contract OilskinAccountFactory {
    /// @notice The account implementation every clone delegates to. Bricked (owner = 1).
    address public immutable IMPLEMENTATION;

    event AccountCreated(address indexed owner, address indexed account);

    error ZeroOwner();
    error AccountExists(address account);

    constructor(address permit2) {
        IMPLEMENTATION = address(new OilskinAccount(address(this), permit2));
    }

    /// @notice The account address for `owner`, whether or not it has been deployed.
    /// @dev Invariant: pure function of (this factory, owner); equals the address `createAccount`
    ///      deploys to.
    function accountOf(address owner) public view returns (address) {
        return Clones.predictDeterministicAddress(IMPLEMENTATION, _salt(owner), address(this));
    }

    /// @notice Whether `owner`'s account has been deployed.
    function isDeployed(address owner) public view returns (bool) {
        return accountOf(owner).code.length != 0;
    }

    /// @notice Deploy `owner`'s account (no-op if it exists). Anyone may call; the deployed account
    ///         always belongs to `owner`.
    /// @dev Invariant: returns accountOf(owner); emits AccountCreated only on first deployment.
    function createAccount(address owner) public returns (address account) {
        if (owner == address(0)) revert ZeroOwner();
        account = accountOf(owner);
        if (account.code.length != 0) return account;
        Clones.cloneDeterministic(IMPLEMENTATION, _salt(owner));
        Call[] memory none;
        OilskinAccount(payable(account)).initialize(owner, none);
        emit AccountCreated(owner, account);
    }

    /// @notice Deploy the CALLER's account and run `calls` as its owner in the same transaction.
    /// @dev Invariant: only for a not-yet-deployed account (an existing one takes `execBatch` from
    ///      its owner directly); `calls` run with the caller as owner; msg.value is forwarded.
    function createAccountAndExec(Call[] calldata calls)
        external
        payable
        returns (address account, bytes[] memory results)
    {
        account = accountOf(msg.sender);
        if (account.code.length != 0) revert AccountExists(account);
        Clones.cloneDeterministic(IMPLEMENTATION, _salt(msg.sender));
        results = OilskinAccount(payable(account)).initialize{value: msg.value}(msg.sender, calls);
        emit AccountCreated(msg.sender, account);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }
}
