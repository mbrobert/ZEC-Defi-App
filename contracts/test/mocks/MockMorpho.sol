// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIrm, IMorphoBlue, IMorphoOracle, Market, MarketParams} from "../../src/interfaces/IMorphoBlue.sol";
import {MorphoMath} from "../../src/libraries/MorphoMath.sol";

/// @notice A Morpho `IOracle`: 1 collateral unit in loan units, scaled by 1e36. Settable.
contract MockMorphoOracle is IMorphoOracle {
    uint256 internal _price;
    /// @dev A deprecated Chainlink aggregator behind Morpho's ChainlinkOracle reverts on read.
    bool public reverting;

    constructor(uint256 price_) {
        _price = price_;
    }

    function setPrice(uint256 price_) external {
        _price = price_;
    }

    function setRevert(bool on) external {
        reverting = on;
    }

    function price() external view returns (uint256) {
        if (reverting) revert("oracle: feed deprecated");
        return _price;
    }
}

/// @notice A flat interest-rate model: one per-second WAD rate for every market, settable.
contract MockIrm is IIrm {
    uint256 public ratePerSecondWad;

    constructor(uint256 ratePerSecondWad_) {
        ratePerSecondWad = ratePerSecondWad_;
    }

    function setRate(uint256 r) external {
        ratePerSecondWad = r;
    }

    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return ratePerSecondWad;
    }

    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return ratePerSecondWad;
    }
}

/// @notice Morpho Blue test double with the semantics the venue relies on, taken from morpho-blue's
///         `Morpho.sol`: isolated markets keyed by `keccak256(abi.encode(params))`; virtual-share
///         accounting (`MorphoMath`); interest accrued with third-order Taylor compounding on every
///         touch; `supplyCollateral` / `repay` pull from `msg.sender` for `onBehalf`; `borrow` /
///         `withdrawCollateral` require `msg.sender == onBehalf` (no authorizations configured) and
///         pay `receiver`; a borrow or collateral withdrawal must leave
///         `collateral × price / 1e36 × lltv ≥ debt`; a borrow must fit the market's idle liquidity.
///         Revert strings are Morpho's `ErrorsLib` strings so a test expecting them reads like the
///         real thing.
contract MockMorpho is IMorphoBlue {
    using SafeERC20 for IERC20;
    using MorphoMath for uint256;

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

    mapping(bytes32 => MarketParams) internal _params;
    mapping(bytes32 => Market) internal _market;
    mapping(bytes32 => mapping(address => Position)) internal _position;

    event CreateMarket(bytes32 indexed id, MarketParams marketParams);

    // ---------------------------------------------------------------- hooks

    function createMarket(MarketParams memory p) external returns (bytes32 id) {
        id = keccak256(abi.encode(p));
        require(_market[id].lastUpdate == 0, "market already created");
        _params[id] = p;
        _market[id].lastUpdate = uint128(block.timestamp);
        emit CreateMarket(id, p);
    }

    /// @dev A lender's deposit so there is USDC to borrow (Morpho's `supply`).
    function supply(MarketParams memory p, uint256 assets, uint256, address onBehalf, bytes memory)
        external
        returns (uint256, uint256)
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        _accrue(id);
        Market storage m = _market[id];
        uint256 shares = assets.toSharesDown(m.totalSupplyAssets, m.totalSupplyShares);
        _position[id][onBehalf].supplyShares += shares;
        m.totalSupplyAssets += uint128(assets);
        m.totalSupplyShares += uint128(shares);
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        return (assets, shares);
    }

    /// @dev A lender's withdrawal (Morpho's `withdraw`), so a test can make a market shallow.
    function withdraw(MarketParams memory p, uint256 assets, uint256, address onBehalf, address receiver)
        external
        returns (uint256, uint256)
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        require(msg.sender == onBehalf, "unauthorized");
        _accrue(id);
        Market storage m = _market[id];
        uint256 shares = assets.toSharesUp(m.totalSupplyAssets, m.totalSupplyShares);
        _position[id][onBehalf].supplyShares -= shares;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assets);
        require(m.totalBorrowAssets <= m.totalSupplyAssets, "insufficient liquidity");
        IERC20(p.loanToken).safeTransfer(receiver, assets);
        return (assets, shares);
    }

    // ------------------------------------------------------------- mutators

    function supplyCollateral(MarketParams memory p, uint256 assets, address onBehalf, bytes memory)
        external
        override
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        require(assets != 0, "zero assets");
        _position[id][onBehalf].collateral += uint128(assets);
        IERC20(p.collateralToken).safeTransferFrom(msg.sender, address(this), assets);
    }

    function withdrawCollateral(MarketParams memory p, uint256 assets, address onBehalf, address receiver)
        external
        override
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        require(assets != 0, "zero assets");
        require(receiver != address(0), "zero address");
        require(msg.sender == onBehalf, "unauthorized");
        _accrue(id);
        _position[id][onBehalf].collateral -= uint128(assets);
        require(_isHealthy(id, onBehalf), "insufficient collateral");
        IERC20(p.collateralToken).safeTransfer(receiver, assets);
    }

    function borrow(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        override
        returns (uint256, uint256)
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        require((assets == 0) != (shares == 0), "inconsistent input");
        require(receiver != address(0), "zero address");
        require(msg.sender == onBehalf, "unauthorized");
        _accrue(id);
        Market storage m = _market[id];
        if (assets != 0) shares = assets.toSharesUp(m.totalBorrowAssets, m.totalBorrowShares);
        else assets = shares.toAssetsDown(m.totalBorrowAssets, m.totalBorrowShares);
        _position[id][onBehalf].borrowShares += uint128(shares);
        m.totalBorrowShares += uint128(shares);
        m.totalBorrowAssets += uint128(assets);
        require(_isHealthy(id, onBehalf), "insufficient collateral");
        require(m.totalBorrowAssets <= m.totalSupplyAssets, "insufficient liquidity");
        IERC20(p.loanToken).safeTransfer(receiver, assets);
        return (assets, shares);
    }

    function repay(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
        override
        returns (uint256, uint256)
    {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        require((assets == 0) != (shares == 0), "inconsistent input");
        _accrue(id);
        Market storage m = _market[id];
        if (assets != 0) shares = assets.toSharesDown(m.totalBorrowAssets, m.totalBorrowShares);
        else assets = shares.toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
        _position[id][onBehalf].borrowShares -= uint128(shares);
        m.totalBorrowShares -= uint128(shares);
        m.totalBorrowAssets = uint128(_zeroFloorSub(m.totalBorrowAssets, assets));
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        return (assets, shares);
    }

    /// @dev Morpho's public `accrueInterest`, for tests that want to observe accrual explicitly.
    function accrueInterest(MarketParams memory p) external {
        bytes32 id = keccak256(abi.encode(p));
        _requireCreated(id);
        _accrue(id);
    }

    // ---------------------------------------------------------------- views

    function position(bytes32 id, address user)
        external
        view
        override
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
    {
        Position storage q = _position[id][user];
        return (q.supplyShares, q.borrowShares, q.collateral);
    }

    function market(bytes32 id)
        external
        view
        override
        returns (uint128, uint128, uint128, uint128, uint128, uint128)
    {
        Market storage m = _market[id];
        return (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee);
    }

    function idToMarketParams(bytes32 id)
        external
        view
        override
        returns (address, address, address, address, uint256)
    {
        MarketParams storage p = _params[id];
        return (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv);
    }

    // ------------------------------------------------------------- internal

    function _requireCreated(bytes32 id) internal view {
        require(_market[id].lastUpdate != 0, "market not created");
    }

    function _accrue(bytes32 id) internal {
        Market storage m = _market[id];
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0) return;
        MarketParams storage p = _params[id];
        if (p.irm != address(0) && m.totalBorrowAssets != 0) {
            uint256 rate = IIrm(p.irm).borrowRateView(p, m);
            uint256 interest = uint256(m.totalBorrowAssets).wMulDown(rate.wTaylorCompounded(elapsed));
            m.totalBorrowAssets += uint128(interest);
            m.totalSupplyAssets += uint128(interest);
        }
        m.lastUpdate = uint128(block.timestamp);
    }

    function _isHealthy(bytes32 id, address user) internal view returns (bool) {
        Position storage q = _position[id][user];
        if (q.borrowShares == 0) return true;
        MarketParams storage p = _params[id];
        Market storage m = _market[id];
        uint256 price = IMorphoOracle(p.oracle).price();
        uint256 borrowed = uint256(q.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
        uint256 maxBorrow = uint256(q.collateral).mulDivDown(price, ORACLE_PRICE_SCALE).wMulDown(p.lltv);
        return maxBorrow >= borrowed;
    }

    function _zeroFloorSub(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : 0;
    }
}
