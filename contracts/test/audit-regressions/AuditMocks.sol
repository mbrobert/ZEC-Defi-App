// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Call, IOilskinAccount} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice A token whose `transfer` is a hook: while the ACCOUNT is calling it (so the token is the
///         active peripheral) it instructs the account to run `payload` through execFromPeripheral.
///         Models an upgradeable / issuer-controlled token (cbZEC is a B20 precompile).
contract HostileToken {
    string public constant name = "Hostile";
    string public constant symbol = "HOST";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    Call[] internal _payload;
    bool public armed;
    bool public fired;
    bytes public lastRevert;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function arm(Call[] calldata payload) external {
        delete _payload;
        for (uint256 i = 0; i < payload.length; i++) _payload.push(payload[i]);
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _fire() internal {
        if (!armed) return;
        armed = false; // once per arming
        Call[] memory p = new Call[](_payload.length);
        for (uint256 i = 0; i < _payload.length; i++) p[i] = _payload[i];
        (bool ok, bytes memory ret) =
            msg.sender.call(abi.encodeWithSignature("execFromPeripheral((address,uint256,bytes,bool)[])", p));
        fired = ok;
        lastRevert = ret;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _fire();
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        _fire();
        allowance[msg.sender][s] = a;
        return true;
    }
}

/// @notice A token with an ERC-777 / ERC-677 style transfer the budget parser does not recognise.
contract ExoticToken {
    string public constant name = "Exotic";
    string public constant symbol = "EXO";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    /// @dev ERC-777 style: same economics, different selector.
    function send(address to, uint256 a, bytes calldata) external {
        _move(msg.sender, to, a);
    }

    /// @dev ERC-677 style.
    function transferAndCall(address to, uint256 a, bytes calldata) external returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    /// @dev A "transfer" whose amount is NOT the second word — models a non-standard token
    ///      (or a Vyper/assembly token) that the parser reads with the wrong layout.
    function transferMany(address[] calldata to, uint256[] calldata amounts) external {
        for (uint256 i = 0; i < to.length; i++) _move(msg.sender, to[i], amounts[i]);
    }

    function _move(address f, address t, uint256 a) internal {
        balanceOf[f] -= a;
        balanceOf[t] += a;
    }
}

/// @notice Permit2 double carrying BOTH real AllowanceTransfer entrypoints:
///           transferFrom(address,address,uint160,address)              <- the account parser knows this
///           transferFrom((address,address,uint160,address)[])          <- the real batch overload; unknown
///         plus permitTransferFrom (SignatureTransfer), also unknown to the parser.
contract PocPermit2 {
    using SafeERC20 for IERC20;

    struct AllowanceTransferDetails {
        address from;
        address to;
        uint160 amount;
        address token;
    }

    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][token][spender] = amount;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        _pull(from, to, amount, token);
    }

    function transferFrom(AllowanceTransferDetails[] calldata d) external {
        for (uint256 i = 0; i < d.length; i++) _pull(d[i].from, d[i].to, d[i].amount, d[i].token);
    }

    function _pull(address from, address to, uint160 amount, address token) internal {
        uint160 a = allowance[from][token][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint160).max) allowance[from][token][msg.sender] = a - amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}

/// @notice A "venue" the registry owner could point an asset at — kept from the audit PoCs so the
///         fixed behaviour is proved against the SAME attacker, not a sketch of one.
/// @dev Original note: A "venue" the registry owner can point an asset at. Whatever it is asked to do, it runs
///         `loot` from the account instead (it is the ACTIVE PERIPHERAL while the router nests into it).
contract RogueVenue {
    address public immutable TOKEN;
    address public immutable THIEF;

    constructor(address token, address thief) {
        TOKEN = token;
        THIEF = thief;
    }

    function enabled() external pure returns (bool) {
        return true;
    }

    function liquidationThresholdBps(address) external pure returns (uint256) {
        return 7800;
    }

    function maxLtvBps(address) external pure returns (uint256) {
        return 7300;
    }

    function healthFactor(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function debt(address, address) external pure returns (uint256) {
        return 0;
    }

    function collateral(address, address) external pure returns (uint256) {
        return 0;
    }

    function borrowRateRay(address) external pure returns (uint256) {
        return 0;
    }

    /// @dev Every ICollateralVenue mutator loots instead. The account is the caller, so the rogue
    ///      venue is the ACTIVE PERIPHERAL and may instruct the account freely.
    function supply(address, uint256) external {
        _loot();
    }

    function withdraw(address, uint256) external returns (uint256) {
        _loot();
        return 0;
    }

    function borrow(address, uint256) external {
        _loot();
    }

    function repay(address, uint256) external returns (uint256) {
        _loot();
        return 0;
    }

    function _loot() internal {
        uint256 bal = IERC20(TOKEN).balanceOf(msg.sender);
        if (bal == 0) return;
        Call[] memory c = new Call[](1);
        c[0] = Call({
            target: TOKEN,
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", THIEF, bal),
            callback: false
        });
        IOilskinAccount(msg.sender).execFromPeripheral(c);
    }
}

/// @notice Remembers the account and tries to call back LATER in the same transaction, from a frame
///         where it is no longer the active peripheral.
contract LateCaller {
    address public account;
    bool public lateOk;
    bytes public lateRevert;

    function remember(address a) external {
        account = a;
    }

    function noop() external {}

    function callBackNow() external returns (bool ok) {
        Call[] memory c = new Call[](1);
        c[0] = Call({target: address(this), value: 0, data: abi.encodeWithSignature("noop()"), callback: false});
        bytes memory ret;
        (ok, ret) = account.call(
            abi.encodeWithSignature("execFromPeripheral((address,uint256,bytes,bool)[])", c)
        );
        lateOk = ok;
        lateRevert = ret;
    }
}

/// @notice Recursion probe: nests peripherally into itself `depth` times.
contract DepthProbe {
    uint256 public reached;

    function dive(uint256 depth) external {
        if (depth > reached) reached = depth;
        if (depth == 0) return;
        IOilskinAccount(msg.sender).execNestedPeripheral(
            address(this), 0, abi.encodeWithSignature("dive(uint256)", depth - 1)
        );
    }
}

/// @notice An owner contract that reverts on plain ETH receipt.
contract RevertingOwner {
    receive() external payable {
        revert("no eth");
    }

    function exec(address account, address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        return IOilskinAccount(account).exec(target, value, data);
    }

    function execBatch(address account, Call[] calldata calls) external returns (bytes[] memory) {
        return IOilskinAccount(account).execBatch(calls);
    }
}

/// @notice Calls two DIFFERENT accounts in one transaction, to probe transient-storage isolation.
contract CrossAccountProbe {
    address public other;
    bool public crossOk;
    bytes public crossRevert;

    function setOther(address a) external {
        other = a;
    }

    /// @dev Called by account A (so this contract is A's active peripheral). It then tries to use
    ///      the peripheral door of account B in the same transaction.
    function tryOther() external returns (bool ok) {
        Call[] memory c = new Call[](1);
        c[0] = Call({target: address(this), value: 0, data: abi.encodeWithSignature("tryOther()"), callback: false});
        bytes memory ret;
        (ok, ret) = other.call(
            abi.encodeWithSignature("execFromPeripheral((address,uint256,bytes,bool)[])", c)
        );
        crossOk = ok;
        crossRevert = ret;
    }
}
