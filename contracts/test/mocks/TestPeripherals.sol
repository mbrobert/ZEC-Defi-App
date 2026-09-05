// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Call, IOilskinAccount} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice A generic peripheral: when an account calls `run(calls)` it relays them through
///         `execFromPeripheral`; `runNested` relays through `execNestedPeripheral`.
contract RelayPeripheral {
    function run(Call[] calldata calls) external returns (bytes[] memory) {
        return IOilskinAccount(msg.sender).execFromPeripheral(calls);
    }

    function runNested(address peripheral, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        return IOilskinAccount(msg.sender).execNestedPeripheral(peripheral, value, data);
    }

    function noop() external pure returns (uint256) {
        return 42;
    }
}

/// @notice A target that tries to re-enter the account through every door while it is being called.
contract ReentrantTarget {
    enum Door {
        Exec,
        ExecBatch,
        ExecAsKeeper,
        ExecFromPeripheral
    }

    address public account;
    Door public door;
    bool public reentered;
    bytes public lastRevert;

    function arm(address account_, Door d) external {
        account = account_;
        door = d;
    }

    function hit() external {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(this), value: 0, data: abi.encodeWithSignature("noop()")});
        bool ok;
        bytes memory ret;
        if (door == Door.Exec) {
            (ok, ret) = account.call(
                abi.encodeWithSignature("exec(address,uint256,bytes)", address(this), 0, bytes(""))
            );
        } else if (door == Door.ExecBatch) {
            (ok, ret) = account.call(abi.encodeWithSignature("execBatch((address,uint256,bytes)[])", calls));
        } else if (door == Door.ExecAsKeeper) {
            (ok, ret) = account.call(abi.encodeWithSignature("execAsKeeper((address,uint256,bytes)[])", calls));
        } else {
            // Legit-looking: this contract IS the active peripheral, so this one is allowed.
            (ok, ret) = account.call(
                abi.encodeWithSignature("execFromPeripheral((address,uint256,bytes)[])", calls)
            );
        }
        reentered = ok;
        lastRevert = ret;
    }

    function noop() external pure returns (uint256) {
        return 1;
    }
}

/// @notice A token-like contract whose `transfer` re-enters `execFromPeripheral` (an ERC-777-style
///         hook impersonating a peripheral).
contract HookToken {
    address public account;

    function arm(address account_) external {
        account = account_;
    }

    function transfer(address, uint256) external returns (bool) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(this), value: 0, data: ""});
        (bool ok,) = account.call(
            abi.encodeWithSignature("execFromPeripheral((address,uint256,bytes)[])", calls)
        );
        require(!ok, "hook got peripheral rights");
        return true;
    }
}

contract TestERC721 is ERC721 {
    constructor() ERC721("T", "T") {}

    function safeMint(address to, uint256 id) external {
        _safeMint(to, id);
    }
}

contract TestERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}

/// @notice Minimal ETH sink that records what it received.
contract EthSink {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}
