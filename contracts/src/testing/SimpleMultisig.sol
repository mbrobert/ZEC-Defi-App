// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SimpleMultisig — INTERIM M-of-N wallet for TESTNET / FORK TESTING.
///
/// @notice ⚠️ NOT FOR MAINNET FUNDS. Production uses Safe{Wallet} (+ timelock);
///         this exists so the admin path (owner = multisig) is exercised in
///         tests and testnet deployments before the real Safe is configured.
///         Deliberately minimal: no EIP-712, no gas relaying, no modules.
contract SimpleMultisig {
    event Submitted(uint256 indexed txId, address indexed proposer, address target, bytes data);
    event Confirmed(uint256 indexed txId, address indexed owner, uint256 confirmations);
    event Executed(uint256 indexed txId, bool success, bytes result);

    error NotOwner();
    error AlreadyConfirmed();
    error AlreadyExecuted();
    error ThresholdNotMet(uint256 have, uint256 need);
    error BadThreshold();
    error UnknownTx(uint256 txId);
    error ExecutionFailed();

    struct Txn {
        address target;
        uint256 value;
        bytes data;
        uint256 confirmations;
        bool executed;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    Txn[] public txns;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory _owners, uint256 _threshold) {
        if (_threshold == 0 || _threshold > _owners.length) revert BadThreshold();
        for (uint256 i = 0; i < _owners.length; i++) {
            isOwner[_owners[i]] = true;
            owners.push(_owners[i]);
        }
        threshold = _threshold;
    }

    receive() external payable {}

    /// @notice Propose a call; auto-confirms for the proposer.
    function submit(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        txns.push(Txn({target: target, value: value, data: data, confirmations: 0, executed: false}));
        txId = txns.length - 1;
        emit Submitted(txId, msg.sender, target, data);
        confirm(txId);
    }

    function confirm(uint256 txId) public onlyOwner {
        if (txId >= txns.length) revert UnknownTx(txId);
        Txn storage t = txns[txId];
        if (t.executed) revert AlreadyExecuted();
        if (confirmedBy[txId][msg.sender]) revert AlreadyConfirmed();
        confirmedBy[txId][msg.sender] = true;
        t.confirmations += 1;
        emit Confirmed(txId, msg.sender, t.confirmations);
    }

    function execute(uint256 txId) external onlyOwner returns (bytes memory result) {
        if (txId >= txns.length) revert UnknownTx(txId);
        Txn storage t = txns[txId];
        if (t.executed) revert AlreadyExecuted();
        if (t.confirmations < threshold) revert ThresholdNotMet(t.confirmations, threshold);
        t.executed = true;
        (bool ok, bytes memory ret) = t.target.call{value: t.value}(t.data);
        if (!ok) revert ExecutionFailed();
        emit Executed(txId, ok, ret);
        return ret;
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function txCount() external view returns (uint256) {
        return txns.length;
    }
}
