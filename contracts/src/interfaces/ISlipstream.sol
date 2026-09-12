// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAerodromeCLPool} from "./IAerodromeCLPool.sol";

/// @notice The second Aerodrome Slipstream deployment on Base — the one the cbZEC/USDC pool lives
///         on (CLFactory `0xf8f2…61Ef`, its NonfungiblePositionManager `0xe1f8…8b53`, CLGauge
///         implementation `0x434B…0f7B` behind EIP-1167 clones from gauge factory `0x3852…6AbB`).
///         Every signature below is copied from the verified sources (Sourcify exact match, solc
///         0.7.6) read 2026-09-10 — `VERIFIED-BASE-FACTS.md` Addendum 9 — never from memory.
///
///         Only the surface Oilskin binds to is declared: the venue mints, unstakes, decreases,
///         collects and burns through the NPM; stakes, claims and enumerates through the gauge;
///         swaps through the pool with the callback. Nothing here is a full interface.

/// @dev `INonfungiblePositionManager` subset. `mint` pulls both tokens from `msg.sender`
///      (`PeripheryPayments.pay` → `transferFrom`) and mints to `recipient` with a plain `_mint`;
///      `decreaseLiquidity`, `collect` and `burn` require `msg.sender` to own or be approved for
///      the id (`isAuthorizedForToken`); `burn` requires liquidity and both `tokensOwed` at zero.
///      The NPM is ERC-721 Enumerable (`supportsInterface(0x780e9d63)` = true, read live).
interface ISlipstreamNpm {
    struct MintParams {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
        /// @dev Non-zero creates the pool; Oilskin always passes 0 (the pool exists).
        uint160 sqrtPriceX96;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;

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
        );

    // ERC-721 + Enumerable surface the venue reads and instructs.
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function factory() external view returns (address);
}

/// @dev `ICLGauge` subset (CLGauge.sol, verified). `deposit(tokenId)` requires
///      `nft.ownerOf(tokenId) == msg.sender`, `voter.isAlive(gauge)`, a position in the gauge's
///      pool; it calls `nft.collect(tokenId → msg.sender)` and `nft.safeTransferFrom(msg.sender,
///      gauge, tokenId)` — so the depositor must `approve(gauge, tokenId)` first. `withdraw(tokenId)`
///      collects, pays the reward to `msg.sender` (`_getReward`, less any early-withdraw penalty
///      the gauge factory sets), unstakes and `safeTransferFrom`s the NFT back — the receiver must
///      implement `onERC721Received` (the account does). `getReward(tokenId)` pays without
///      unstaking. `stakedValues(depositor)` lists the depositor's staked ids; there is NO
///      id → depositor view, which is why `ILpVenue.ownedPool` takes the account.
interface ISlipstreamGauge {
    function deposit(uint256 tokenId) external;
    function withdraw(uint256 tokenId) external;
    function getReward(uint256 tokenId) external;
    function earned(address account, uint256 tokenId) external view returns (uint256);
    function stakedValues(address depositor) external view returns (uint256[] memory);
    function stakedContains(address depositor, uint256 tokenId) external view returns (bool);
    function stakedLength(address depositor) external view returns (uint256);
    function rewardToken() external view returns (address);
    function rewardRate() external view returns (uint256);
    function periodFinish() external view returns (uint256);
    function nft() external view returns (address);
    function pool() external view returns (address);
    function voter() external view returns (address);
    /// @dev The factory whose `penaltyRate()` / `minStakeTimes(pool)` set the early-withdraw penalty.
    function gaugeFactory() external view returns (address);
    /// @dev When `tokenId` was staked (0 = not staked); the penalty window counts from here.
    function depositTimestamp(uint256 tokenId) external view returns (uint256);
}

/// @dev `ICLGaugeFactory` subset (CLGaugeFactory.sol, verified): the early-withdraw penalty —
///      `penaltyRate()` in bps of the reward, applied while `block.timestamp < depositTimestamp +
///      minStakeTimes(pool)` (read 2026-09-11 at block 51,193,797 for the cbZEC/USDC pool: 10,000
///      bps for 10 seconds — Addendum 9).
interface ISlipstreamGaugeFactory {
    function penaltyRate() external view returns (uint256);
    function minStakeTimes(address pool) external view returns (uint256);
}

/// @dev The Aerodrome Voter surface the venue reads: whether a gauge is alive (a killed gauge
///      refuses `deposit` with "GK"; the position is then held unstaked).
interface ISlipstreamVoter {
    function isAlive(address gauge) external view returns (bool);
    function gauges(address pool) external view returns (address);
}

/// @dev `ICLPool` subset over the read-only surface already in `IAerodromeCLPool`: the swap with
///      its callback, and the two peripheral pointers this deployment's pools expose (`gauge()`
///      and `nft()` answered live on the cbZEC/USDC pool 2026-09-10; the OLD deployment's pools
///      revert on `gauge()`).
interface ISlipstreamPool is IAerodromeCLPool {
    /// @notice Exact-input when `amountSpecified > 0`. `sqrtPriceLimitX96` must lie strictly between
    ///         the current price and the tick bound in the swap's direction ("SPL" otherwise). The
    ///         output is sent to `recipient` BEFORE `uniswapV3SwapCallback` is called on
    ///         `msg.sender`, which must then pay the positive delta; the pool checks its balance.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function gauge() external view returns (address);
    function nft() external view returns (address);
    function factory() external view returns (address);
}

/// @dev `ICLSwapCallback` (verified): called on `msg.sender` of `swap`; a positive delta is what
///      the callback must transfer to the pool.
interface ICLSwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}
