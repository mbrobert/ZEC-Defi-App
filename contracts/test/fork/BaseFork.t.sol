// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BaseAddresses} from "../../script/Deploy.s.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../../src/account/OilskinAccountFactory.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";
import {SnuggleLpVenue} from "../../src/venues/SnuggleLpVenue.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {IAerodromeCLPool} from "../../src/interfaces/IAerodromeCLPool.sol";
import {IPoolAddressesProvider} from "../../src/interfaces/IAaveV3.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {ICollateralRegistry} from "../../src/interfaces/ICollateralRegistry.sol";

/// @title BaseFork — the tests that can only be true against the chain (Part 6 lesson 2: "verify
///        the external contract against the chain, not against your own mock").
///
/// Run:   FORK_URL=<Base RPC> FOUNDRY_PROFILE=local forge test --match-path test/fork/BaseFork.t.sol -vv
/// CI:    a `fork` job with `secrets.BASE_RPC_URL`; the job is REQUIRED on main. Without FORK_URL every
///        test here is reported as SKIPPED (vm.skip), never as passed — a green run with these
///        skipped is not a verified run and the CI summary must say so.
///
/// Pinned block: none by default (`FORK_BLOCK` env pins one for reproducibility). The assertions
/// are about SHAPES (selectors answer, getters revert past the end, token order, decimals, flags)
/// and about our flows landing under the account; they are not about live numbers, which the
/// fixture mirrors from VERIFIED-BASE-FACTS and which change.
contract BaseForkTest is Test {
    bool forked;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    AaveV3Venue aaveVenue;
    SnuggleLpVenue lpVenue;
    CollateralRegistry registry;
    address alice = makeAddr("alice-fork");
    address treasury = makeAddr("treasury-fork");

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        uint256 blockNumber = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blockNumber);
        forked = true;
        require(block.chainid == BaseAddresses.CHAIN_ID, "FORK_URL is not Base");

        factory = new OilskinAccountFactory(BaseAddresses.PERMIT2);
        acct = OilskinAccount(payable(factory.createAccount(alice)));
        // The venue enforces the registry's entry floor and offer flags, so the fork needs the same
        // wiring the deploy script builds: registry first, then the venue, then the assets.
        registry = new CollateralRegistry(address(this), 1.55e18, 2 days);
        aaveVenue = new AaveV3Venue(
            IPoolAddressesProvider(BaseAddresses.AAVE_POOL_ADDRESSES_PROVIDER),
            ICollateralRegistry(address(registry))
        );
        registry.register(BaseAddresses.CBBTC, address(aaveVenue), address(0), true, "");
        registry.register(BaseAddresses.WETH, address(aaveVenue), address(0), true, "");
        lpVenue = new SnuggleLpVenue(ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE), BaseAddresses.AERO, treasury, 1000);
    }

    modifier onlyForked() {
        vm.skip(!forked);
        _;
    }

    // -------------------------------------------------------------- facts

    function test_fork_aaveProviderResolvesToVerifiedAddresses() public onlyForked {
        IPoolAddressesProvider p = IPoolAddressesProvider(BaseAddresses.AAVE_POOL_ADDRESSES_PROVIDER);
        assertEq(p.getPool(), BaseAddresses.AAVE_POOL, "Aave pool moved: re-read VERIFIED-BASE-FACTS");
        assertEq(p.getPoolDataProvider(), BaseAddresses.AAVE_POOL_DATA_PROVIDER, "data provider moved");
        assertEq(p.getPriceOracle(), BaseAddresses.AAVE_ORACLE, "oracle moved");
    }

    function test_fork_reserveParamsAreLiveAndListed() public onlyForked {
        uint256 ltBtc = aaveVenue.liquidationThresholdBps(BaseAddresses.CBBTC);
        uint256 ltEth = aaveVenue.liquidationThresholdBps(BaseAddresses.WETH);
        console2.log("cbBTC LT / LTV", ltBtc, aaveVenue.maxLtvBps(BaseAddresses.CBBTC));
        console2.log("WETH  LT / LTV", ltEth, aaveVenue.maxLtvBps(BaseAddresses.WETH));
        console2.log("USDC borrow rate (ray)", aaveVenue.borrowRateRay(BaseAddresses.USDC));
        assertGt(ltBtc, 0);
        assertGt(ltEth, 0);
        assertGt(aaveVenue.maxLtvBps(BaseAddresses.CBBTC), 0);
        assertLt(aaveVenue.maxLtvBps(BaseAddresses.CBBTC), ltBtc);
        assertGt(aaveVenue.borrowRateRay(BaseAddresses.USDC), 0);
        assertEq(aaveVenue.liquidationThresholdBps(BaseAddresses.CBZEC), 0, "cbZEC is NOT listed on Aave");
    }

    function test_fork_cbzecIsAB20WithLiveMultiplier() public onlyForked {
        assertEq(BaseAddresses.CBZEC.code.length, 1, "B20 precompile: code is a single 0xef byte");
        assertEq(IERC20Metadata(BaseAddresses.CBZEC).decimals(), 8);
        assertEq(IERC20Metadata(BaseAddresses.CBZEC).symbol(), "cbZEC");
        (bool ok, bytes memory ret) = BaseAddresses.CBZEC.staticcall(abi.encodeWithSignature("multiplier()"));
        assertTrue(ok && ret.length >= 32, "multiplier() must answer");
        console2.log("cbZEC multiplier", abi.decode(ret, (uint256)));
    }

    function test_fork_cbzecUsdcPoolSlot0() public onlyForked {
        IAerodromeCLPool pool = IAerodromeCLPool(BaseAddresses.AERODROME_CBZEC_USDC_POOL);
        assertEq(pool.token0(), BaseAddresses.USDC, "token0 is USDC");
        assertEq(pool.token1(), BaseAddresses.CBZEC, "token1 is cbZEC");
        assertEq(pool.tickSpacing(), 200);
        (uint160 sqrtPriceX96, int24 tick,,,,) = pool.slot0();
        assertGt(sqrtPriceX96, 0);
        console2.log("cbZEC/USDC sqrtPriceX96", sqrtPriceX96);
        console2.log("cbZEC/USDC tick", tick);
        console2.log("cbZEC/USDC liquidity", pool.liquidity());
        // The band check reads exactly this word through a raw staticcall.
        (bool ok, bytes memory ret) = address(pool).staticcall(abi.encodeWithSelector(IAerodromeCLPool.slot0.selector));
        assertTrue(ok && ret.length >= 32);
        assertEq(abi.decode(ret, (uint256)), uint256(sqrtPriceX96));
    }

    /// FACT 1 against the live engine, measured (slice A, 2026-09-10): the array-returning getter
    /// does not exist; the index getter reverts past the end with the EMPTY shape; that revert is a
    /// cheap REVERT, not an all-gas INVALID, so a bounded stipend tells it from an out-of-gas; the
    /// canary and the end of the list fail the same way; a selector the engine lacks fails the
    /// same way too (the proxy-miss ambiguity `RISKS.md` §12 records); and the venue's enumeration
    /// returns EMPTY for a fresh address and the real list for a live holder, every id corroborated
    /// by `positions(id).owner`.
    function test_fork_engineIndexGetterShape() public onlyForked {
        address fresh = makeAddr("nobody");
        (bool okArray,) = BaseAddresses.SNUGGLE_ENGINE.staticcall(abi.encodeWithSelector(0x613cf420, fresh));
        assertFalse(okArray, "userPositions(address) must NOT exist (C-2)");

        uint256 stipend = lpVenue.PROBE_GAS();
        // The four shapes, each metered under the venue's own stipend (EIP-150 forwards exactly it).
        (bool ok0, bytes memory shape0, uint256 used0) = _meter(abi.encodeCall(ISnuggleVault.userPositions, (fresh, 0)), stipend);
        (bool okC, bytes memory shapeC, uint256 usedC) = _meter(abi.encodeCall(ISnuggleVault.userPositions, (fresh, type(uint256).max)), stipend);
        (bool okM, bytes memory shapeM, uint256 usedM) = _meter(hex"deadbeef", stipend);
        console2.log("end-of-list (index 0, fresh): ok / gas used", ok0, used0);
        console2.logBytes(shape0);
        console2.log("canary (2^256-1, fresh): ok / gas used", okC, usedC);
        console2.logBytes(shapeC);
        console2.log("selector the engine lacks (0xdeadbeef): ok / gas used", okM, usedM);
        console2.logBytes(shapeM);
        assertFalse(ok0, "index 0 of an empty list must revert");
        assertFalse(okC, "the canary must revert");
        assertEq(shape0.length, 0, "measured 2026-09-10: the live end-of-list revert is EMPTY");
        assertEq(keccak256(shapeC), keccak256(shape0), "canary and end-of-list must fail the same way");
        assertLt(used0 * 4, stipend, "the end-of-list revert must be cheap against the stipend, or OOG cannot be told apart");
        assertLt(usedC * 4, stipend, "the canary revert must be cheap against the stipend");

        // A live holder: the first id of the engine's global list, its owner, and that owner's list
        // through the venue — the id must be in it (owner-corroborated), and a successful index
        // read must also sit well inside the stipend.
        (bool okAll, bytes memory allRet) = BaseAddresses.SNUGGLE_ENGINE.staticcall(abi.encodeWithSignature("allPositionIds(uint256)", 0));
        assertTrue(okAll && allRet.length == 32, "allPositionIds(0) must answer");
        uint256 liveId = abi.decode(allRet, (uint256));
        (,, address liveOwner,,,,,,,,,,,,,,) = ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE).positions(liveId);
        assertTrue(liveOwner != address(0), "a live id has an owner");
        (bool okL, bytes memory retL, uint256 usedL) = _meter(abi.encodeCall(ISnuggleVault.userPositions, (liveOwner, 0)), stipend);
        console2.log("successful index read (live holder, index 0): ok / gas used", okL, usedL);
        assertTrue(okL && retL.length == 32, "a live holder's index 0 answers");
        assertLt(usedL * 8, stipend, "a successful read must sit well inside the stipend");
        (bool okP, bytes memory retP, uint256 usedP) = _meter(abi.encodeCall(ISnuggleVault.positions, (liveId)), stipend);
        console2.log("positions(id) read (live id): ok / gas used", okP, usedP);
        assertTrue(okP && retP.length == 17 * 32, "positions(id) returns the 17-word struct");
        assertLt(usedP * 8, stipend, "a positions(id) read must sit well inside the stipend");
        assertLt(used0 * 8, stipend, "and the end-of-list revert is under one eighth of it");

        uint256[] memory ids = lpVenue.positionsOf(fresh);
        assertEq(ids.length, 0, "a fresh address owns nothing, and the venue can now say so");
        uint256[] memory liveIds = lpVenue.positionsOf(liveOwner);
        console2.log("live holder", liveOwner, "ids", liveIds.length);
        bool found;
        for (uint256 i = 0; i < liveIds.length; i++) {
            if (liveIds[i] == liveId) found = true;
        }
        assertTrue(found, "the live holder's list contains the id the global list names");
        assertGt(ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE).poolIdsCount(), 0);
    }

    /// @dev One engine probe under a fixed stipend, with the gas it consumed (EIP-150: the callee
    ///      receives exactly `stipend` when the caller holds more than 64/63 of it, which a test does).
    function _meter(bytes memory data, uint256 stipend) internal view returns (bool ok, bytes memory ret, uint256 used) {
        uint256 g0 = gasleft();
        (ok, ret) = BaseAddresses.SNUGGLE_ENGINE.staticcall{gas: stipend}(data);
        used = g0 - gasleft();
    }

    // -------------------------------------------------------------- flows

    function test_fork_supplyBorrowRepayWithdrawUnderTheAccount() public onlyForked {
        deal(BaseAddresses.CBBTC, address(acct), 1e8);
        vm.startPrank(alice);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.supply, (BaseAddresses.CBBTC, 1e8)));
        // Aave v3 mints aTokens as a scaled balance (amount / liquidityIndex, then * index on read), so
        // a 1e8 supply reads back 1 unit short. Live: `PoolDataProvider.getUserReserveData(cbBTC, acct)`
        // → currentATokenBalance 99,999,999 with liquidityIndex 1.002030255356308190911377929e27 at
        // block 51,127,409 (2026-09-10; the same 99999999 != 100000000 at block 51,001,138 on 2026-09-07).
        assertApproxEqAbs(aaveVenue.collateral(address(acct), BaseAddresses.CBBTC), 1e8, 1, "aToken index rounding");
        uint256 borrow = 10_000e6;
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (BaseAddresses.USDC, borrow)));
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(acct)), borrow, "borrowed USDC lands in the account");
        uint256 hf = aaveVenue.healthFactor(address(acct));
        console2.log("HF after borrow (wad)", hf);
        assertGt(hf, 1e18);
        assertApproxEqAbs(aaveVenue.debt(address(acct), BaseAddresses.USDC), borrow, 2);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (BaseAddresses.USDC, type(uint256).max)));
        assertEq(aaveVenue.debt(address(acct), BaseAddresses.USDC), 0);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (BaseAddresses.CBBTC, type(uint256).max)));
        vm.stopPrank();
        assertEq(IERC20(BaseAddresses.CBBTC).balanceOf(address(acct)), 1e8);
        assertEq(IERC20(BaseAddresses.CBBTC).allowance(address(acct), BaseAddresses.AAVE_POOL), 0);
        assertEq(IERC20(BaseAddresses.USDC).allowance(address(acct), BaseAddresses.AAVE_POOL), 0);
    }

    /// Open → close on the live engine through the account, in the first active USDC pool the
    /// engine lists. Proves the id is minted TO THE ACCOUNT, the band reads the live pool, the
    /// enumeration sees the id, and the close pays the account.
    function test_fork_lpOpenCloseOnLiveEngine() public onlyForked {
        ISnuggleVault engine = ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE);
        bytes32 poolId;
        address pool;
        uint256 n = engine.poolIdsCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 candidate = engine.poolIds(i);
            (address cPool, address c0, address c1,,, bool active,,) = engine.approvedPools(candidate);
            if (active && (c0 == BaseAddresses.USDC || c1 == BaseAddresses.USDC) && (c0 == BaseAddresses.WETH || c1 == BaseAddresses.WETH)) {
                poolId = candidate;
                pool = cPool;
                break;
            }
        }
        vm.skip(poolId == bytes32(0)); // no active WETH/USDC pool listed: nothing to prove
        (address t0,,) = lpVenue.poolTokens(poolId);
        uint256 amount = 1_000e6;
        deal(BaseAddresses.USDC, address(acct), amount);
        uint256 price = lpVenue.poolSqrtPriceX96(poolId);
        LpOpenParams memory p = LpOpenParams({
            poolId: poolId,
            amount0: t0 == BaseAddresses.USDC ? amount : 0,
            amount1: t0 == BaseAddresses.USDC ? 0 : amount,
            rangeWidthBps: 1500,
            rebalanceDelay: 12 hours,
            autoCompound: true,
            band: PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100)),
            deadline: block.timestamp + 15 minutes
        });
        vm.prank(alice);
        uint256 id = abi.decode(acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p))), (uint256));
        (bytes32 pid, address owner) = lpVenue.poolOf(id);
        assertEq(pid, poolId);
        assertEq(owner, address(acct), "minted to the account");
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 1);
        assertEq(ids[0], id);

        // Engine flash-loan hold: one timestamp read, single warp (via-IR CSE note, AUDIT round 3).
        uint256 t = block.timestamp;
        vm.warp(t + 2 minutes);
        PriceBand memory band = PriceBand(uint160((price * 80) / 100), uint160((price * 120) / 100));
        vm.prank(alice);
        bytes memory ret = acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, band)));
        (uint256 out0, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        console2.log("closed: out0", out0, "out1", out1);
        assertGt(out0 + out1, 0);
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        // Round-trip loss bounded to engine fees / swap impact on a small size.
        uint256 usdcBack = IERC20(BaseAddresses.USDC).balanceOf(address(acct));
        assertGt(usdcBack, 900e6, "excessive round-trip loss");
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(lpVenue)), 0);
    }

    function test_fork_permit2Present() public onlyForked {
        assertGt(BaseAddresses.PERMIT2.code.length, 0);
        assertGt(BaseAddresses.MORPHO_BLUE.code.length, 0);
        assertGt(BaseAddresses.PYTH.code.length, 0);
    }
}
