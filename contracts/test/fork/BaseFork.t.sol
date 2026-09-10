// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
import {LoanDust} from "../../src/libraries/LoanDust.sol";

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

    /// supply → borrow → repay(max) → withdraw(max) under the account against the real Aave pool,
    /// funded exactly as a user would be (slice C, 2026-09-10; `RISKS.md` §8 "Rounding dust"):
    /// the borrow lands the borrowed USDC and nothing else. Aave reads the aToken one unit under and
    /// the debt one unit over in the same block (Addendum 3), so: (a) `repay(max)` with exactly the
    /// borrowed balance repays everything held and leaves the rounding residual, which is dust by the
    /// shared threshold; (b) `withdraw(max)` with that residual outstanding is refused by Aave itself
    /// — the venues do not forgive dust, only the app's reading of it; (c) topping the account up to
    /// the `debt()` the venue reports — what the dashboard tells the user to hold — clears it; (d)
    /// `withdraw(max)` then returns the aToken balance, one unit under what was supplied. Every
    /// number is logged for the facts.
    function test_fork_supplyBorrowRepayWithdrawUnderTheAccount() public onlyForked {
        deal(BaseAddresses.CBBTC, address(acct), 1e8);
        vm.startPrank(alice);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.supply, (BaseAddresses.CBBTC, 1e8)));
        uint256 collateralRead = aaveVenue.collateral(address(acct), BaseAddresses.CBBTC);
        console2.log("collateral read after supplying 1e8", collateralRead);
        assertApproxEqAbs(collateralRead, 1e8, 1, "aToken index rounding");

        uint256 borrow = 10_000e6;
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (BaseAddresses.USDC, borrow)));
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(acct)), borrow, "borrowed USDC lands in the account, nothing else");
        uint256 hf = aaveVenue.healthFactor(address(acct));
        console2.log("HF after borrow (wad)", hf);
        assertGt(hf, 1e18);
        uint256 owed = aaveVenue.debt(address(acct), BaseAddresses.USDC);
        console2.log("debt read after borrowing 10,000e6", owed);
        assertApproxEqAbs(owed, borrow, 2);

        // (a) repay(max) holding exactly the borrow: everything held goes, the residual is dust.
        bytes memory ret = acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (BaseAddresses.USDC, type(uint256).max)));
        uint256 repaid = abi.decode(ret, (uint256));
        uint256 residual = aaveVenue.debt(address(acct), BaseAddresses.USDC);
        console2.log("repay(max) with exactly the borrow: repaid / residual debt", repaid, residual);
        assertEq(repaid, owed > borrow ? borrow : owed, "repaid everything the account held");
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(acct)), 0);
        assertLe(residual, LoanDust.UNITS, "the residual is rounding by the shared threshold");
        assertEq(IERC20(BaseAddresses.USDC).allowance(address(acct), BaseAddresses.AAVE_POOL), 0);

        // (b) With the residual outstanding, Aave itself refuses to release the last of the collateral.
        if (residual != 0) {
            try acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (BaseAddresses.CBBTC, type(uint256).max))) {
                fail("Aave released all collateral with debt outstanding");
            } catch (bytes memory r) {
                console2.log("withdraw(max) with dust debt outstanding reverted with:");
                console2.logBytes(r);
            }
            assertEq(aaveVenue.collateral(address(acct), BaseAddresses.CBBTC), collateralRead, "collateral untouched by the refused withdraw");
            // (c) Fund the residual — what the dashboard's Close asks the user to hold — and clear it.
            deal(BaseAddresses.USDC, address(acct), residual);
            ret = acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (BaseAddresses.USDC, type(uint256).max)));
            console2.log("repay(max) of the residual: repaid", abi.decode(ret, (uint256)));
        }
        assertEq(aaveVenue.debt(address(acct), BaseAddresses.USDC), 0, "debt fully cleared");
        assertEq(aaveVenue.healthFactor(address(acct)), type(uint256).max, "no debt: HF is max");

        // (d) withdraw(max) returns the aToken balance, one unit under what was supplied.
        ret = acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (BaseAddresses.CBBTC, type(uint256).max)));
        uint256 withdrawn = abi.decode(ret, (uint256));
        vm.stopPrank();
        console2.log("withdraw(max): withdrawn", withdrawn);
        assertEq(IERC20(BaseAddresses.CBBTC).balanceOf(address(acct)), withdrawn);
        assertApproxEqAbs(withdrawn, 1e8, 1, "one unit of aToken rounding at most");
        assertEq(aaveVenue.collateral(address(acct), BaseAddresses.CBBTC), 0);
        assertEq(IERC20(BaseAddresses.CBBTC).allowance(address(acct), BaseAddresses.AAVE_POOL), 0);
        assertEq(IERC20(BaseAddresses.USDC).allowance(address(acct), BaseAddresses.AAVE_POOL), 0);
    }

    // -------------------------------------------------------------- engine entries

    /// @dev One engine registry entry, as `approvedPools` describes it plus its index.
    struct Entry {
        uint256 index;
        bytes32 poolId;
        address pool;
        address token0;
        address token1;
        address adapter;
        address rewardAdapter;
    }

    /// @dev The engine's WETH/USDC entries that can actually mint (slice B, 2026-09-10): active, both
    ///      tokens ours, and a position adapter that answers `getTWAPTick(pool, 300)` — the call the
    ///      engine's library makes inside every deposit, which the 81 stub entries revert
    ///      `NotImplemented()` on (Addendum 3). `aero` is the first such entry whose pool was created by
    ///      the Slipstream CLFactory and that carries a reward adapter (a gauged position); `unstaked`
    ///      the first such entry with no reward adapter (a Uniswap v3 position the engine never
    ///      stakes). Selection is by these properties, never by index: the index is only logged.
    ///      The scan stops as soon as both are found, to spare the public RPC.
    function _mintableWethUsdcEntries() internal view returns (Entry memory aero, Entry memory unstaked) {
        ISnuggleVault engine = ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE);
        uint256 n = engine.poolIdsCount();
        for (uint256 i = 0; i < n && (aero.pool == address(0) || unstaked.pool == address(0)); i++) {
            bytes32 candidate = engine.poolIds(i);
            (address cPool, address c0, address c1,,, bool active, address adapter, address rewardAdapter) =
                engine.approvedPools(candidate);
            if (!active) continue;
            bool pair = (c0 == BaseAddresses.WETH && c1 == BaseAddresses.USDC) || (c0 == BaseAddresses.USDC && c1 == BaseAddresses.WETH);
            if (!pair) continue;
            (bool twapOk, bytes memory twap) = adapter.staticcall(abi.encodeWithSignature("getTWAPTick(address,uint32)", cPool, uint32(300)));
            if (!twapOk || twap.length != 32) continue;
            (bool fOk, bytes memory fRet) = cPool.staticcall(abi.encodeWithSignature("factory()"));
            address factory_ = fOk && fRet.length == 32 ? abi.decode(fRet, (address)) : address(0);
            Entry memory e = Entry(i, candidate, cPool, c0, c1, adapter, rewardAdapter);
            if (aero.pool == address(0) && factory_ == BaseAddresses.AERODROME_CL_FACTORY && rewardAdapter != address(0)) aero = e;
            else if (unstaked.pool == address(0) && rewardAdapter == address(0)) unstaked = e;
        }
    }

    function _logEntry(string memory tag, Entry memory e) internal pure {
        console2.log(tag, "index", e.index);
        console2.logBytes32(e.poolId);
        console2.log("  pool / adapter / rewardAdapter", e.pool, e.adapter, e.rewardAdapter);
    }

    function _openParamsFor(Entry memory e, uint256 usdcAmount, uint256 price) internal view returns (LpOpenParams memory p) {
        p = LpOpenParams({
            poolId: e.poolId,
            amount0: e.token0 == BaseAddresses.USDC ? usdcAmount : 0,
            amount1: e.token0 == BaseAddresses.USDC ? 0 : usdcAmount,
            rangeWidthBps: 1500,
            rebalanceDelay: 12 hours,
            autoCompound: true,
            band: PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100)),
            deadline: block.timestamp + 15 minutes
        });
    }

    /// @dev What the account's raw call to the engine reverted with (empty = it did not revert).
    function _engineRevert(bytes memory data) internal returns (bool reverted, bytes memory reason) {
        vm.prank(alice);
        try acct.exec(BaseAddresses.SNUGGLE_ENGINE, 0, data) {
            return (false, "");
        } catch (bytes memory r) {
            return (true, r);
        }
    }

    /// @dev Value of a WETH amount in USDC at the pool's sqrtPriceX96 (token0 = WETH, token1 = USDC on
    ///      the CL100 pool): token1 = token0 × (sqrtP / 2^96)², in raw units on both sides.
    function _wethInUsdc(uint256 weth, uint256 sqrtPriceX96) internal pure returns (uint256) {
        uint256 v = Math.mulDiv(weth, sqrtPriceX96, 2 ** 96);
        return Math.mulDiv(v, sqrtPriceX96, 2 ** 96);
    }

    /// Open → close on the live engine through the account, in the engine's Aerodrome Slipstream
    /// WETH/USDC entry — the pool the product ships, not the stub the first run landed on (slice B,
    /// 2026-09-10). Proves: the id is minted TO THE ACCOUNT, `positionsOf` (slice A) sees it, the
    /// band reads the live pool, the engine's 60 s hold refuses an early close with the shape the mock
    /// reproduces, the close pays the account in both pool tokens, the round-trip loss is bounded,
    /// and the venue holds nothing. Every revert shape it meets is logged as bytes for the facts.
    function test_fork_lpOpenCloseOnLiveEngine() public onlyForked {
        (Entry memory e,) = _mintableWethUsdcEntries();
        vm.skip(e.pool == address(0)); // no mintable Aerodrome WETH/USDC entry listed: nothing to prove
        _logEntry("aerodrome WETH/USDC entry:", e);
        assertEq(e.token0, BaseAddresses.WETH, "CL100 pool: token0 is WETH");
        assertEq(e.token1, BaseAddresses.USDC, "CL100 pool: token1 is USDC");
        (address t0, address t1, address pool) = lpVenue.poolTokens(e.poolId);
        assertEq(t0, e.token0);
        assertEq(t1, e.token1);
        assertEq(pool, e.pool);

        uint256 amount = 1_000e6;
        deal(BaseAddresses.USDC, address(acct), amount);
        uint256 price = lpVenue.poolSqrtPriceX96(e.poolId);
        console2.log("pool sqrtPriceX96 at open", price);
        LpOpenParams memory p = _openParamsFor(e, amount, price);
        vm.prank(alice);
        uint256 id = abi.decode(acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p))), (uint256));
        console2.log("minted id", id);
        (bytes32 pid, address owner) = lpVenue.poolOf(id);
        assertEq(pid, e.poolId);
        assertEq(owner, address(acct), "minted to the account");
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 1, "slice A: the account's list is readable on the live engine");
        assertEq(ids[0], id);
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(acct)) + IERC20(BaseAddresses.WETH).balanceOf(address(acct)), 0, "nothing bounced on a single-sided open");

        // The engine auto-stakes a gauged entry on deposit (`_tryStakePosition`).
        (bool sOk, bytes memory sRet) = e.rewardAdapter.staticcall(abi.encodeWithSignature("isStaked(uint256)", id));
        bool staked = sOk && sRet.length == 32 && abi.decode(sRet, (bool));
        console2.log("staked in the gauge after deposit", staked);
        // Where the engine put the liquidity relative to the price: measured, because a single-sided
        // deposit that is NOT swapped to ratio is a one-sided range, and a one-sided range below the
        // price holds only token1 (USDC) and earns nothing until the price enters it.
        {
            (,,,, int24 lo, int24 hi,,,,,,,,,,,) = ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE).positions(id);
            (, int24 tick,,,,) = IAerodromeCLPool(e.pool).slot0();
            console2.log("position tickLower", int256(lo));
            console2.log("position tickUpper", int256(hi));
            console2.log("pool tick at open", int256(tick));
            console2.log("in range at open?", lo <= tick && tick < hi);
        }

        // (1) A close inside the engine's 60 s hold: the shape, bubbled untouched through the venue.
        // (The band is ±10 %: the venue's MAX_BAND_BPS = 2500 refuses a window wider than 25 % of its
        // lower bound — the first run of this test met BandTooWide at ±20 % before reaching the engine.)
        PriceBand memory band = PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100));
        vm.prank(alice);
        try acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, band))) {
            fail("a close inside the 60 s hold must revert");
        } catch (bytes memory r) {
            console2.log("close inside the hold reverted with:");
            console2.logBytes(r);
            assertEq(bytes4(r), bytes4(keccak256("MinimumHoldTimeNotMet()")), "the engine's hold error");
            assertEq(r.length, 4, "and nothing else");
        }
        // (2) The claim paths on a fresh staked id, raw from the account: what the venue swallows.
        (bool hRev, bytes memory hReason) = _engineRevert(abi.encodeCall(ISnuggleVault.harvest, (id)));
        console2.log("harvest on the fresh id reverted?", hRev);
        console2.logBytes(hReason);
        (bool cRev, bytes memory cReason) = _engineRevert(abi.encodeCall(ISnuggleVault.claimStakingRewards, (id)));
        console2.log("claimStakingRewards on the fresh id reverted?", cRev);
        console2.logBytes(cReason);
        if (staked) assertEq(bytes4(hReason), bytes4(keccak256("UseClaimStakingRewards()")), "a staked id refuses harvest");
        // (3) closeMany with the live id inside the hold plus two ids the engine refuses: reported, not fatal.
        {
            uint256[] memory many = new uint256[](3);
            (many[0], many[1], many[2]) = (type(uint256).max - 7, id, 1); // never minted; ours; someone else's (or long gone)
            vm.prank(alice);
            bytes memory ret = acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.closeMany, (many, band)));
            (,,, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
            assertEq(failed.length, 3, "inside the hold every id is reported, none closed");
            assertEq(lpVenue.positionsOf(address(acct)).length, 1, "and ours is untouched");
        }

        // (4) Past the hold: close pays the account in the pool tokens the engine holds for it.
        uint256 t = block.timestamp;
        vm.warp(t + 2 minutes);
        vm.prank(alice);
        bytes memory closed = acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, band)));
        (uint256 out0, uint256 out1, uint256 rewards) = abi.decode(closed, (uint256, uint256, uint256));
        console2.log("closed: out0 (WETH wei)", out0, "out1 (USDC)", out1);
        console2.log("closed: rewards (AERO wei)", rewards);
        assertGt(out0 + out1, 0);
        assertEq(lpVenue.positionsOf(address(acct)).length, 0, "the list is empty again");
        assertEq(IERC20(BaseAddresses.WETH).balanceOf(address(acct)), out0, "WETH leg paid to the account");
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(acct)), out1, "USDC leg paid to the account");
        // Round-trip value in USDC at the pool price after the close. Measured 2026-09-10 at block
        // 51,127,409 (Addendum 5); the bound is that measurement with a margin, not a wish.
        uint256 priceAfter = lpVenue.poolSqrtPriceX96(e.poolId);
        uint256 valueBack = out1 + _wethInUsdc(out0, priceAfter);
        console2.log("value back in USDC (raw) / of 1,000e6 in bps", valueBack, (valueBack * 10_000) / amount);
        assertGt(valueBack, (amount * 98) / 100, "round-trip loss above 2% on a 1,000 USDC single-sided open");
        assertEq(IERC20(BaseAddresses.USDC).balanceOf(address(lpVenue)), 0, "venue holds no USDC");
        assertEq(IERC20(BaseAddresses.WETH).balanceOf(address(lpVenue)), 0, "venue holds no WETH");
        assertEq(IERC20(BaseAddresses.AERO).balanceOf(address(lpVenue)), 0, "venue holds no AERO");
    }

    /// The engine's refusal shapes on an UNSTAKED entry (no reward adapter — a Uniswap v3 position the
    /// engine never stakes), raw from the account, for the mocks to reproduce (slice B): a foreign id
    /// and a never-minted id on `withdraw`, `harvest` and `claimStakingRewards`; `harvest` on a fresh
    /// id with nothing to collect; `claimStakingRewards` where there is no gauge.
    function test_fork_engineRefusalShapesOnUnstakedEntry() public onlyForked {
        (, Entry memory e) = _mintableWethUsdcEntries();
        vm.skip(e.pool == address(0)); // no mintable un-gauged WETH/USDC entry: nothing to measure
        _logEntry("unstaked WETH/USDC entry:", e);
        uint256 amount = 500e6;
        deal(BaseAddresses.USDC, address(acct), amount);
        uint256 price = lpVenue.poolSqrtPriceX96(e.poolId);
        LpOpenParams memory p = _openParamsFor(e, amount, price);
        vm.prank(alice);
        bytes memory ret;
        try acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p))) returns (bytes memory r) {
            ret = r;
        } catch (bytes memory r) {
            console2.log("open on the unstaked entry reverted with:");
            console2.logBytes(r);
            fail("the un-gauged entry did not mint: record the shape above and re-select");
        }
        uint256 id = abi.decode(ret, (uint256));
        console2.log("minted id", id);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1);

        bytes4 notOwner = bytes4(keccak256("NotPositionOwner()"));
        // A live id owned by someone else: the engine's global list at index 0.
        (bool okAll, bytes memory allRet) = BaseAddresses.SNUGGLE_ENGINE.staticcall(abi.encodeWithSignature("allPositionIds(uint256)", 0));
        assertTrue(okAll && allRet.length == 32);
        uint256 foreign = abi.decode(allRet, (uint256));
        (,, address foreignOwner,,,,,,,,,,,,,,) = ISnuggleVault(BaseAddresses.SNUGGLE_ENGINE).positions(foreign);
        assertTrue(foreignOwner != address(acct) && foreignOwner != address(0));
        uint256 never = type(uint256).max - 7;

        bytes[6] memory calls = [
            abi.encodeCall(ISnuggleVault.withdraw, (foreign, false)),
            abi.encodeCall(ISnuggleVault.withdraw, (never, false)),
            abi.encodeCall(ISnuggleVault.harvest, (foreign)),
            abi.encodeCall(ISnuggleVault.claimStakingRewards, (foreign)),
            abi.encodeCall(ISnuggleVault.harvest, (id)),
            abi.encodeCall(ISnuggleVault.claimStakingRewards, (id))
        ];
        string[6] memory names = ["withdraw(foreign)", "withdraw(never minted)", "harvest(foreign)", "claimStakingRewards(foreign)", "harvest(own, fresh)", "claimStakingRewards(own, no gauge)"];
        bytes4[6] memory expected = [notOwner, notOwner, notOwner, notOwner, bytes4(keccak256("NoFeesToHarvest()")), bytes4(keccak256("NoRewardAdapter()"))];
        for (uint256 i = 0; i < 6; i++) {
            (bool rev, bytes memory reason) = _engineRevert(calls[i]);
            console2.log(names[i], "reverted?", rev);
            console2.logBytes(reason);
            assertTrue(rev, names[i]);
            assertEq(bytes4(reason), expected[i], names[i]);
            assertEq(reason.length, 4, "no arguments on the engine's errors");
        }
        // The venue's `claim` on the foreign id reports it, never reverts, and the position stays.
        {
            uint256[] memory one = new uint256[](1);
            one[0] = foreign;
            PriceBand memory band = PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100));
            vm.prank(alice);
            bytes memory cret = acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.claim, (one, band, block.timestamp + 60)));
            (,,, uint256[] memory failed) = abi.decode(cret, (uint256, uint256, uint256, uint256[]));
            assertEq(failed.length, 1);
            assertEq(failed[0], foreign);
        }
        // And the un-gauged position closes past the hold, both legs to the account.
        vm.warp(block.timestamp + 2 minutes);
        PriceBand memory closeBand = PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100));
        vm.prank(alice);
        bytes memory closed = acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, closeBand)));
        (uint256 out0, uint256 out1,) = abi.decode(closed, (uint256, uint256, uint256));
        console2.log("closed (unstaked): out0", out0, "out1", out1);
        assertGt(out0 + out1, 0);
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
    }

    function test_fork_permit2Present() public onlyForked {
        assertGt(BaseAddresses.PERMIT2.code.length, 0);
        assertGt(BaseAddresses.MORPHO_BLUE.code.length, 0);
        assertGt(BaseAddresses.PYTH.code.length, 0);
    }
}
