// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ISlipstreamNpm} from "../../src/interfaces/ISlipstream.sol";
import {LiquidityAmounts} from "../../src/libraries/LiquidityAmounts.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockCLPool} from "./MockCLPool.sol";

/// @notice Test double for the second deployment's NonfungiblePositionManager (`0xe1f8…8b53`,
///         verified source read 2026-09-10): ERC-721 Enumerable, `mint` pulls both tokens from
///         `msg.sender` and mints to `recipient` with a plain `_mint`; `decreaseLiquidity`,
///         `collect` and `burn` require `msg.sender` to own or be approved for the id; `burn`
///         requires liquidity and both `tokensOwed` at zero ("NC"). Liquidity ↔ amounts is the
///         real `LiquidityAmounts` math at the pool's live sqrt price, so a position's value
///         moves with the price like the real one. Bound to ONE `MockCLPool`, which holds the tokens.
contract MockSlipstreamNpm is ERC721Enumerable {
    using SafeERC20 for IERC20;

    MockCLPool public immutable POOL;
    address public immutable factory;

    struct Position {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    mapping(uint256 => Position) internal _positions;
    uint256 private _nextId = 1;

    error DeadlinePassed();
    error WrongPool();

    constructor(MockCLPool pool, address factory_) ERC721("Slipstream Position NFT v1", "CL-POS") {
        POOL = pool;
        factory = factory_;
    }

    // ------------------------------------------------------------ test hooks

    /// @dev Trading fees accrue to an UNSTAKED position: mint them into the pool's custody and owe them.
    function accrueFees(uint256 tokenId, uint256 f0, uint256 f1) external {
        Position storage p = _positions[tokenId];
        p.tokensOwed0 += uint128(f0);
        p.tokensOwed1 += uint128(f1);
    }

    function nextId() external view returns (uint256) {
        return _nextId;
    }

    /// @dev Tokens `owner` holds that carry a standing `approve` — the venue approves the gauge
    ///      only inside the batch that deposits, so a staked token is the gauge's (no approval)
    ///      and a held token has none.
    function getApprovedCount(address owner) external view returns (uint256 n) {
        uint256 bal = balanceOf(owner);
        for (uint256 i = 0; i < bal; i++) {
            if (getApproved(tokenOfOwnerByIndex(owner, i)) != address(0)) n++;
        }
    }

    // ------------------------------------------------------------ NPM surface

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            int24 tickSpacing,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage p = _positions[tokenId];
        return (0, address(0), p.token0, p.token1, p.tickSpacing, p.tickLower, p.tickUpper, p.liquidity, 0, 0, p.tokensOwed0, p.tokensOwed1);
    }

    function mint(ISlipstreamNpm.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (block.timestamp > params.deadline) revert DeadlinePassed();
        if (params.token0 != POOL.token0() || params.token1 != POOL.token1() || params.tickSpacing != POOL.tickSpacing()) {
            revert WrongPool();
        }
        require(params.tickLower < params.tickUpper, "TLU");
        require(params.tickLower % params.tickSpacing == 0 && params.tickUpper % params.tickSpacing == 0, "TS");
        (liquidity, amount0, amount1) = _addLiquidity(params.tickLower, params.tickUpper, params.amount0Desired, params.amount1Desired);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        tokenId = _nextId++;
        _mint(params.recipient, tokenId);
        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            tickSpacing: params.tickSpacing,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
    }

    function increaseLiquidity(ISlipstreamNpm.IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (block.timestamp > params.deadline) revert DeadlinePassed();
        Position storage p = _positions[params.tokenId];
        (liquidity, amount0, amount1) = _addLiquidity(p.tickLower, p.tickUpper, params.amount0Desired, params.amount1Desired);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        p.liquidity += liquidity;
    }

    function decreaseLiquidity(ISlipstreamNpm.DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        _requireAuthorized(params.tokenId);
        if (block.timestamp > params.deadline) revert DeadlinePassed();
        require(params.liquidity > 0);
        Position storage p = _positions[params.tokenId];
        require(p.liquidity >= params.liquidity);
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            POOL.sqrtPriceX96(),
            TickMath.getSqrtRatioAtTick(p.tickLower),
            TickMath.getSqrtRatioAtTick(p.tickUpper),
            params.liquidity
        );
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        p.liquidity -= params.liquidity;
        p.tokensOwed0 += uint128(amount0);
        p.tokensOwed1 += uint128(amount1);
    }

    function collect(ISlipstreamNpm.CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        _requireAuthorized(params.tokenId);
        require(params.amount0Max > 0 || params.amount1Max > 0);
        Position storage p = _positions[params.tokenId];
        amount0 = p.tokensOwed0 > params.amount0Max ? params.amount0Max : p.tokensOwed0;
        amount1 = p.tokensOwed1 > params.amount1Max ? params.amount1Max : p.tokensOwed1;
        p.tokensOwed0 -= uint128(amount0);
        p.tokensOwed1 -= uint128(amount1);
        address to = params.recipient == address(0) ? address(this) : params.recipient;
        POOL.payout(p.token0, to, amount0);
        POOL.payout(p.token1, to, amount1);
    }

    function burn(uint256 tokenId) external payable {
        _requireAuthorized(tokenId);
        Position storage p = _positions[tokenId];
        require(p.liquidity == 0 && p.tokensOwed0 == 0 && p.tokensOwed1 == 0, "NC");
        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ------------------------------------------------------------ internal

    function _addLiquidity(int24 lower, int24 upper, uint256 a0Desired, uint256 a1Desired)
        internal
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        uint160 sqrtP = POOL.sqrtPriceX96();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(upper);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, a0Desired, a1Desired);
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
        if (amount0 > a0Desired) amount0 = a0Desired;
        if (amount1 > a1Desired) amount1 = a1Desired;
        // The real periphery pulls through `uniswapV3MintCallback` → `transferFrom(payer = msg.sender)`.
        if (amount0 != 0) IERC20(POOL.token0()).safeTransferFrom(msg.sender, address(POOL), amount0);
        if (amount1 != 0) IERC20(POOL.token1()).safeTransferFrom(msg.sender, address(POOL), amount1);
    }

    function _requireAuthorized(uint256 tokenId) internal view {
        require(_isAuthorized(_ownerOf(tokenId), msg.sender, tokenId), "Not approved");
    }
}

/// @notice Test double for the Aerodrome Voter's two reads the venue needs.
contract MockVoter {
    mapping(address => bool) public isAlive;
    mapping(address => address) public gauges;

    function setGauge(address pool, address gauge) external {
        gauges[pool] = gauge;
        isAlive[gauge] = true;
    }

    function setAlive(address gauge, bool alive) external {
        isAlive[gauge] = alive;
    }
}

/// @notice Test double for a Slipstream CLGauge (`0x434B…0f7B`, verified source read 2026-09-10):
///         `deposit` requires the depositor to own the NFT and the gauge to be alive, collects to
///         the depositor and `safeTransferFrom`s the NFT in (the depositor must have approved);
///         `withdraw` collects, pays the reward to the depositor and `safeTransferFrom`s the NFT
///         back; `getReward` pays without unstaking; an early-withdraw penalty goes to the minter
///         when the factory sets one. `stakedValues` / `stakedContains` are the only depositor views.
contract MockCLGauge is ERC721Holder {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    MockCLPool public immutable POOL;
    MockSlipstreamNpm public immutable NPM;
    address public immutable rewardToken;
    MockVoter public immutable VOTER;
    address public minter = address(0xBEEF);

    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public penaltyRate; // bps
    uint256 public minStakeTime;

    mapping(address => EnumerableSet.UintSet) internal _stakes;
    mapping(uint256 => uint256) public rewards;
    mapping(uint256 => uint256) public depositTimestamp;
    /// @dev Reverts `deposit` and `withdraw` with a bare reason, to prove the venue's best-effort paths.
    bool public refuse;

    constructor(MockCLPool pool_, MockSlipstreamNpm npm_, address rewardToken_, MockVoter voter_) {
        POOL = pool_;
        NPM = npm_;
        rewardToken = rewardToken_;
        VOTER = voter_;
    }

    // ------------------------------------------------------------ test hooks

    /// @dev Emissions accrued to a staked id. The reward token must already sit in the gauge.
    function setPending(uint256 tokenId, uint256 amount) external {
        rewards[tokenId] = amount;
    }

    function setRewardRate(uint256 r, uint256 finish) external {
        rewardRate = r;
        periodFinish = finish;
    }

    function setPenalty(uint256 bps, uint256 minStake) external {
        penaltyRate = bps;
        minStakeTime = minStake;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    // ------------------------------------------------------------ gauge surface

    function nft() external view returns (address) {
        return address(NPM);
    }

    function pool() external view returns (address) {
        return address(POOL);
    }

    function voter() external view returns (address) {
        return address(VOTER);
    }

    /// @dev The real gauge points at a CLGaugeFactory whose `penaltyRate()` / `minStakeTimes(pool)`
    ///      set the early-withdraw penalty; this mock answers both itself.
    function gaugeFactory() external view returns (address) {
        return address(this);
    }

    function minStakeTimes(address) external view returns (uint256) {
        return minStakeTime;
    }

    function deposit(uint256 tokenId) external {
        require(!refuse, "gauge refused");
        require(NPM.ownerOf(tokenId) == msg.sender, "NA");
        require(VOTER.isAlive(address(this)), "GK");
        (,, address t0, address t1, int24 ts,,,,,,,) = NPM.positions(tokenId);
        require(t0 == POOL.token0() && t1 == POOL.token1() && ts == POOL.tickSpacing(), "PM");
        NPM.collect(
            ISlipstreamNpm.CollectParams({tokenId: tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max})
        );
        NPM.safeTransferFrom(msg.sender, address(this), tokenId);
        _stakes[msg.sender].add(tokenId);
        depositTimestamp[tokenId] = block.timestamp;
    }

    function withdraw(uint256 tokenId) external {
        require(!refuse, "gauge refused");
        require(_stakes[msg.sender].contains(tokenId), "NA");
        NPM.collect(
            ISlipstreamNpm.CollectParams({tokenId: tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max})
        );
        _getReward(tokenId, msg.sender);
        _stakes[msg.sender].remove(tokenId);
        delete depositTimestamp[tokenId];
        NPM.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function getReward(uint256 tokenId) external {
        require(_stakes[msg.sender].contains(tokenId), "NA");
        _getReward(tokenId, msg.sender);
    }

    function earned(address account, uint256 tokenId) external view returns (uint256) {
        require(_stakes[account].contains(tokenId), "NA");
        uint256 claimable = rewards[tokenId];
        return claimable - _penalty(claimable, tokenId);
    }

    function stakedValues(address depositor) external view returns (uint256[] memory staked) {
        uint256 n = _stakes[depositor].length();
        staked = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            staked[i] = _stakes[depositor].at(i);
        }
    }

    function stakedContains(address depositor, uint256 tokenId) external view returns (bool) {
        return _stakes[depositor].contains(tokenId);
    }

    function stakedLength(address depositor) external view returns (uint256) {
        return _stakes[depositor].length();
    }

    // ------------------------------------------------------------ internal

    function _getReward(uint256 tokenId, address owner) internal {
        uint256 reward = rewards[tokenId];
        if (reward == 0) return;
        delete rewards[tokenId];
        uint256 penalty = _penalty(reward, tokenId);
        if (penalty != 0) {
            reward -= penalty;
            IERC20(rewardToken).safeTransfer(minter, penalty);
        }
        if (reward != 0) IERC20(rewardToken).safeTransfer(owner, reward);
    }

    function _penalty(uint256 reward, uint256 tokenId) internal view returns (uint256) {
        if (penaltyRate != 0 && block.timestamp < depositTimestamp[tokenId] + minStakeTime) {
            return reward * penaltyRate / 10_000;
        }
        return 0;
    }
}
