// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Call, IOilskinAccount} from "../interfaces/IOilskinAccount.sol";

/// @title Peripheral — base for contracts an OilskinAccount calls and that act back on it.
///
/// @notice A peripheral's mutating functions are meant to be called BY an account with the callback
///         opt-in set (`execWithCallback`, a `Call` with `callback: true`, a grant with
///         `allowCallback`, or a nested peripheral call). `msg.sender` is that account; every token
///         movement is instructed back into the account with `execFromPeripheral`, so the account is
///         `msg.sender` to the protocol and the peripheral never holds anything.
/// @dev Calls a peripheral asks the account to make NEVER carry the callback flag — the account
///      rejects one that does. A peripheral that needs to compose another peripheral uses
///      `execNestedPeripheral`, which is bounded in depth. Peripherals with per-call state must
///      carry their own reentrancy guard: the account's lock guards its own doors, not a venue's.
abstract contract Peripheral {
    /// @dev The calling account. Only meaningful inside a mutating entrypoint.
    function _account() internal view returns (IOilskinAccount) {
        return IOilskinAccount(msg.sender);
    }

    /// @dev One raw call from the account. Reverts bubble from the account untouched.
    function _exec(address target, bytes memory data) internal returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: target, value: 0, data: data, callback: false});
        return _account().execFromPeripheral(calls)[0];
    }

    /// @dev Several raw calls from the account in order.
    function _execMany(Call[] memory calls) internal returns (bytes[] memory) {
        return _account().execFromPeripheral(calls);
    }

    /// @dev Build an ERC-20 approve call from the account.
    function _approveCall(address token, address spender, uint256 amount)
        internal
        pure
        returns (Call memory)
    {
        return Call({
            target: token,
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", spender, amount),
            callback: false
        });
    }

    /// @dev approve(exact) → call → approve(0). The account never leaves an allowance behind, so a
    ///      later keeper call cannot ride a standing approval outside its budget.
    function _approveCallReset(address token, address spender, uint256 amount, Call memory action)
        internal
        returns (bytes memory result)
    {
        Call[] memory calls = new Call[](3);
        calls[0] = _approveCall(token, spender, amount);
        calls[1] = action;
        calls[2] = _approveCall(token, spender, 0);
        return _account().execFromPeripheral(calls)[1];
    }
}
