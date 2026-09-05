// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice cbZEC-style B20 token double: balances are shares × a LIVE `multiplier()` (1e18 = 1.0),
///         so `balanceOf` moves under every holder when the issuer rebases; transfers to / from a
///         blocked address revert; the issuer can pause and can seize (`burnBlocked`) a blocked
///         balance. Amount → shares rounds down, as a rebase token must (no value is minted by
///         rounding). 8 decimals like the live token.
contract MockB20 {
    string public constant name = "Coinbase Wrapped ZEC";
    string public constant symbol = "cbZEC";
    uint8 public constant decimals = 8;

    uint256 public multiplier = 1e18;
    uint256 public totalShares;
    bool public paused;

    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MultiplierSet(uint256 multiplier);

    error Blocked(address who);
    error Paused();
    error InsufficientBalance();
    error InsufficientAllowance();

    // --------------------------------------------------------------- issuer

    function mint(address to, uint256 amount) external {
        uint256 s = _toShares(amount);
        sharesOf[to] += s;
        totalShares += s;
        emit Transfer(address(0), to, amount);
    }

    function setMultiplier(uint256 m) external {
        multiplier = m;
        emit MultiplierSet(m);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    /// @dev Seize a blocked holder's balance (the B20 `burnBlocked` power).
    function burnBlocked(address who) external {
        totalShares -= sharesOf[who];
        sharesOf[who] = 0;
    }

    // ---------------------------------------------------------------- ERC20

    function totalSupply() external view returns (uint256) {
        return _toAmount(totalShares);
    }

    function balanceOf(address who) public view returns (uint256) {
        return _toAmount(sharesOf[who]);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    // ------------------------------------------------------------- internal

    function _move(address from, address to, uint256 amount) internal {
        if (paused) revert Paused();
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        uint256 s = _toShares(amount);
        if (sharesOf[from] < s) revert InsufficientBalance();
        sharesOf[from] -= s;
        sharesOf[to] += s;
        emit Transfer(from, to, amount);
    }

    function _toShares(uint256 amount) internal view returns (uint256) {
        return (amount * 1e18) / multiplier;
    }

    function _toAmount(uint256 shares) internal view returns (uint256) {
        return (shares * multiplier) / 1e18;
    }
}
