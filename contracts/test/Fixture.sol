// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../src/account/OilskinAccountFactory.sol";
import {Call, Permission, TokenLimit} from "../src/interfaces/IOilskinAccount.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IAaveV3.sol";
import {IMorphoBlue, MarketParams} from "../src/interfaces/IMorphoBlue.sol";
import {IAerodromeSwapRouter} from "../src/interfaces/IAerodromeSwapRouter.sol";
import {ICollateralRegistry} from "../src/interfaces/ICollateralRegistry.sol";
import {AaveV3Venue} from "../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../src/venues/MorphoBlueVenue.sol";
import {SnuggleLpVenue} from "../src/venues/SnuggleLpVenue.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
import {AerodromeSwapAdapter} from "../src/swap/AerodromeSwapAdapter.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockB20} from "./mocks/MockB20.sol";
import {MockAave} from "./mocks/MockAave.sol";
import {MockIrm, MockMorpho, MockMorphoOracle} from "./mocks/MockMorpho.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {MockSnuggleVault} from "./mocks/MockSnuggleVault.sol";
import {MockAerodromeSwapRouter} from "./mocks/MockAerodromeSwapRouter.sol";
import {MockCLGauge, MockSlipstreamNpm, MockVoter} from "./mocks/MockSlipstream.sol";
import {SlipstreamLpVenue} from "../src/venues/SlipstreamLpVenue.sol";
import {SlipstreamPoolSwapAdapter} from "../src/swap/SlipstreamPoolSwapAdapter.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ISlipstreamGauge, ISlipstreamNpm, ISlipstreamPool} from "../src/interfaces/ISlipstream.sol";

/// @notice The whole v1 surface wired against mocks that mirror VERIFIED-BASE-FACTS:
///           reserves cbBTC LT 7800 / LTV 7300, WETH 8300 / 8000, USDC 7800 / 7500 borrowable,
///           live prices and rates; the cbZEC/USDC Slipstream pool (token0 USDC, token1 cbZEC,
///           tickSpacing 200, fee 2000, tick −23228) and the WETH/USDC pool (token0 WETH, token1
///           USDC, tickSpacing 100, tick −198319); cbZEC as a B20 with a live multiplier.
abstract contract Fixture is Test {
    // tokens
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 cbbtc;
    MockERC20 aero;
    MockB20 cbzec;

    // infra
    MockPermit2 permit2;
    MockAave aave;
    MockMorpho morpho;
    MockIrm morphoIrm;
    MockMorphoOracle morphoOracleCbbtc;
    MockMorphoOracle morphoOracleWeth;
    bytes32 morphoIdCbbtc;
    bytes32 morphoIdWeth;
    MockSnuggleVault engine;
    MockCLPool poolWethUsdc;
    MockCLPool poolCbzecUsdc;
    MockAerodromeSwapRouter aeroRouter;
    // the second Slipstream deployment, around the cbZEC/USDC pool (2026-09-11, the direct venue)
    MockVoter voter;
    MockSlipstreamNpm npmCbzec;
    MockCLGauge gaugeCbzec;

    // ours
    OilskinAccountFactory factory;
    OilskinAccount acct;
    AaveV3Venue aaveVenue;
    MorphoBlueVenue morphoVenue;
    SnuggleLpVenue lpVenue;
    CollateralRegistry registry;
    AerodromeSwapAdapter swapAdapter;
    SlipstreamPoolSwapAdapter poolSwapAdapter;
    SlipstreamLpVenue directVenue;
    StrategyRouter router;

    bytes32 constant POOL_WETH_USDC = keccak256("aero-cl100-WETH-USDC");
    bytes32 constant POOL_CBZEC_USDC = keccak256("aero-cl200-USDC-cbZEC");
    /// @dev The direct venue's one pool id: the pool address, left-padded (set in setUp).
    bytes32 POOL_ID_DIRECT;

    uint256 constant ENTRY_HF_FLOOR_WAD = 1.25e18; // packages/shared ENTRY_HF_FLOOR (pinned 2026-09-12)
    uint256 constant PERF_BPS = 1000; // packages/shared FEES.performanceBps
    uint256 constant REGISTRY_TIMELOCK = 2 days; // Deploy.s.sol REGISTRY_TIMELOCK_DELAY default

    // verified Base reserve facts (2026-09-05)
    uint256 constant CBBTC_LTV = 7300;
    uint256 constant CBBTC_LT = 7800;
    uint256 constant WETH_LTV = 8000;
    uint256 constant WETH_LT = 8300;
    uint256 constant USDC_LTV = 7500;
    uint256 constant USDC_LT = 7800;
    uint256 constant PRICE_CBBTC_E8 = 79_593_77000000;
    uint256 constant PRICE_WETH_E8 = 2_453_45000000;
    uint256 constant PRICE_USDC_E8 = 1_00000000;
    uint256 constant RATE_CBBTC_RAY = 0.00673e27;
    uint256 constant RATE_WETH_RAY = 0.02454e27;
    uint256 constant RATE_USDC_RAY = 0.04828e27;
    // verified Morpho Blue facts (2026-09-07): both Base markets at 86 % LLTV, AdaptiveCurve IRM
    uint256 constant MORPHO_LLTV_WAD = 0.86e18;
    /// @dev Morpho quotes per second in WAD; this is Aave's USDC APR expressed that way.
    uint256 constant MORPHO_RATE_PER_SECOND_WAD = RATE_USDC_RAY / 1e9 / 365 days;
    address morphoLender = makeAddr("morphoLender");
    int24 constant TICK_WETH_USDC = -198319;
    int24 constant TICK_CBZEC_USDC = -23228;

    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address registryOwner = makeAddr("registryOwner");

    function setUp() public virtual {
        alice = vm.addr(aliceKey);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        cbbtc = new MockERC20("Coinbase Wrapped BTC", "cbBTC", 8);
        aero = new MockERC20("Aerodrome", "AERO", 18);
        cbzec = new MockB20();

        permit2 = new MockPermit2();
        aave = new MockAave();
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, PRICE_CBBTC_E8, RATE_CBBTC_RAY);
        aave.setReserve(address(weth), WETH_LTV, WETH_LT, 500, true, true, PRICE_WETH_E8, RATE_WETH_RAY);
        aave.setReserve(address(usdc), USDC_LTV, USDC_LT, 500, true, true, PRICE_USDC_E8, RATE_USDC_RAY);
        usdc.mint(address(aave), 50_000_000e6); // pool liquidity to lend

        // Morpho Blue: one isolated USDC market per collateral, seeded by a lender.
        morpho = new MockMorpho();
        morphoIrm = new MockIrm(MORPHO_RATE_PER_SECOND_WAD);
        morphoOracleCbbtc = new MockMorphoOracle(_morphoPrice36(PRICE_CBBTC_E8, 8));
        morphoOracleWeth = new MockMorphoOracle(_morphoPrice36(PRICE_WETH_E8, 18));
        MarketParams memory mpCbbtc = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(cbbtc),
            oracle: address(morphoOracleCbbtc),
            irm: address(morphoIrm),
            lltv: MORPHO_LLTV_WAD
        });
        MarketParams memory mpWeth = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(weth),
            oracle: address(morphoOracleWeth),
            irm: address(morphoIrm),
            lltv: MORPHO_LLTV_WAD
        });
        morphoIdCbbtc = morpho.createMarket(mpCbbtc);
        morphoIdWeth = morpho.createMarket(mpWeth);
        usdc.mint(morphoLender, 100_000_000e6);
        vm.startPrank(morphoLender);
        usdc.approve(address(morpho), type(uint256).max);
        morpho.supply(mpCbbtc, 50_000_000e6, 0, morphoLender, "");
        morpho.supply(mpWeth, 50_000_000e6, 0, morphoLender, "");
        vm.stopPrank();

        poolWethUsdc = new MockCLPool(address(weth), address(usdc), 100, 871, TickMath.getSqrtRatioAtTick(TICK_WETH_USDC));
        poolCbzecUsdc = new MockCLPool(address(usdc), address(cbzec), 200, 2000, TickMath.getSqrtRatioAtTick(TICK_CBZEC_USDC));
        poolWethUsdc.setTick(TICK_WETH_USDC);
        poolCbzecUsdc.setTick(TICK_CBZEC_USDC);
        engine = new MockSnuggleVault();
        engine.addPool(POOL_WETH_USDC, address(poolWethUsdc), address(weth), address(usdc), 871);
        engine.addPool(POOL_CBZEC_USDC, address(poolCbzecUsdc), address(usdc), address(cbzec), 2000);

        // The second Slipstream deployment: the cbZEC/USDC pool's own position manager and gauge,
        // the Voter that says the gauge is alive, and the pool funded to fill the to-ratio swaps.
        voter = new MockVoter();
        npmCbzec = new MockSlipstreamNpm(poolCbzecUsdc, makeAddr("clfactory-2"));
        gaugeCbzec = new MockCLGauge(poolCbzecUsdc, npmCbzec, address(aero), voter);
        voter.setGauge(address(poolCbzecUsdc), address(gaugeCbzec));
        poolCbzecUsdc.setGaugeAndNft(address(gaugeCbzec), address(npmCbzec), makeAddr("clfactory-2"));
        usdc.mint(address(poolCbzecUsdc), 5_000_000e6);
        cbzec.mint(address(poolCbzecUsdc), 5_000e8);
        aero.mint(address(gaugeCbzec), 100_000e18);
        POOL_ID_DIRECT = bytes32(uint256(uint160(address(poolCbzecUsdc))));

        aeroRouter = new MockAerodromeSwapRouter();
        // 1 WETH → 2453.45 USDC; 1 cbZEC → 1020 USDC; and back.
        aeroRouter.setRate(address(weth), address(usdc), 2453_450000, 1e18);
        aeroRouter.setRate(address(usdc), address(weth), 1e18, 2453_450000);
        aeroRouter.setRate(address(cbzec), address(usdc), 1020_000000, 1e8);
        aeroRouter.setRate(address(usdc), address(cbzec), 1e8, 1020_000000);
        usdc.mint(address(aeroRouter), 10_000_000e6);
        weth.mint(address(aeroRouter), 10_000e18);
        cbzec.mint(address(aeroRouter), 10_000e8);

        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(alice)));

        // Registry first: the collateral venue enforces the registry's entry floor and offer flags
        // itself, so it takes the registry address at construction.
        registry = new CollateralRegistry(registryOwner, ENTRY_HF_FLOOR_WAD, REGISTRY_TIMELOCK);
        aaveVenue = new AaveV3Venue(IPoolAddressesProvider(address(aave)), ICollateralRegistry(address(registry)));
        morphoVenue = new MorphoBlueVenue(
            IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), _morphoIds()
        );
        lpVenue = new SnuggleLpVenue(ISnuggleVault(address(engine)), address(aero), treasury, PERF_BPS);
        vm.startPrank(registryOwner);
        registry.register(address(cbbtc), address(aaveVenue), makeAddr("feed-cbbtc"), true, "");
        registry.register(address(weth), address(aaveVenue), makeAddr("feed-eth"), true, "");
        registry.register(
            address(cbzec), address(aaveVenue), makeAddr("feed-pyth-zec"), false, "no collateral market on Base yet"
        );
        vm.stopPrank();
        swapAdapter = new AerodromeSwapAdapter(IAerodromeSwapRouter(address(aeroRouter)));
        poolSwapAdapter = new SlipstreamPoolSwapAdapter(ISlipstreamPool(address(poolCbzecUsdc)));
        directVenue = new SlipstreamLpVenue(
            ISlipstreamPool(address(poolCbzecUsdc)),
            ISlipstreamNpm(address(npmCbzec)),
            ISlipstreamGauge(address(gaugeCbzec)),
            ISwapAdapter(address(poolSwapAdapter)),
            address(aero),
            treasury,
            PERF_BPS
        );
        router = new StrategyRouter(
            registry,
            lpVenue,
            swapAdapter,
            IPermit2(address(permit2)),
            address(usdc),
            ILpVenue(address(directVenue)),
            ISwapAdapter(address(poolSwapAdapter))
        );
    }

    // ------------------------------------------------------------ helpers

    function _morphoIds() internal view returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = morphoIdCbbtc;
        ids[1] = morphoIdWeth;
    }

    /// @dev A Chainlink-style 8-decimal USD price as a Morpho oracle answer: 1 unit of a
    ///      `collateralDecimals` token in USDC (6 decimals), scaled by 1e36.
    function _morphoPrice36(uint256 priceE8, uint8 collateralDecimals) internal pure returns (uint256) {
        return (priceE8 * 1e6 * 1e36) / 1e8 / (10 ** collateralDecimals);
    }

    /// @dev The registry owner moves `asset` from its current venue to the Morpho venue the only
    ///      way the registry allows: propose → wait out the timelock → accept.
    function _switchToMorpho(address asset) internal {
        address feed = registry.config(asset).priceFeed;
        vm.prank(registryOwner);
        registry.proposeVenue(asset, address(morphoVenue), feed);
        vm.warp(block.timestamp + REGISTRY_TIMELOCK);
        vm.prank(registryOwner);
        registry.acceptVenue(asset);
    }

    /// @dev A PLAIN call: the target gets no rights over the account. Tokens, pools, Permit2.
    function _call(address target, bytes memory data) internal pure returns (Call memory) {
        return Call({target: target, value: 0, data: data, callback: false});
    }

    /// @dev A call that opts the target IN as the active peripheral. Router, venues, adapter.
    function _callP(address target, bytes memory data) internal pure returns (Call memory) {
        return Call({target: target, value: 0, data: data, callback: true});
    }

    function _one(Call memory c) internal pure returns (Call[] memory arr) {
        arr = new Call[](1);
        arr[0] = c;
    }

    /// @dev Owner runs `data` on a PERIPHERAL (router / venue / adapter) from the account.
    function _ownerExec(address target, bytes memory data) internal returns (bytes memory) {
        vm.prank(alice);
        return acct.execWithCallback(target, 0, data);
    }

    /// @dev Owner runs `data` on a plain target (token, pool, Permit2) — no callback rights.
    function _ownerExecPlain(address target, bytes memory data) internal returns (bytes memory) {
        vm.prank(alice);
        return acct.exec(target, 0, data);
    }

    /// @dev A ±pctBps window around the live sqrt price. The venue bounds the total WIDTH at
    ///      MAX_BAND_BPS (2500), so pctBps must stay ≤ 1000 (ratio 1.222).
    function _band(MockCLPool pool, uint256 pctBps) internal view returns (PriceBand memory) {
        uint256 p = pool.sqrtPriceX96();
        return PriceBand({
            minSqrtPriceX96: uint160((p * (10_000 - pctBps)) / 10_000),
            maxSqrtPriceX96: uint160((p * (10_000 + pctBps)) / 10_000)
        });
    }

    function _openParams(bytes32 poolId, uint256 a0, uint256 a1, MockCLPool pool)
        internal
        view
        returns (LpOpenParams memory)
    {
        return LpOpenParams({
            poolId: poolId,
            amount0: a0,
            amount1: a1,
            rangeWidthBps: 1500,
            rebalanceDelay: 12 hours,
            autoCompound: true,
            band: _band(pool, 1000),
            deadline: block.timestamp + 15 minutes
        });
    }

    function _signPermit(address token, uint256 amount, uint256 nonce, uint256 deadline, address spender)
        internal
        view
        returns (bytes memory sig)
    {
        return _signPermitWith(aliceKey, token, amount, nonce, deadline, spender);
    }

    function _signPermitWith(
        uint256 key,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address spender
    ) internal view returns (bytes memory sig) {
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: token, amount: amount}),
            nonce: nonce,
            deadline: deadline
        });
        bytes32 digest = permit2.hashPermit(permit, spender);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev A grant on a PERIPHERAL target (the router): callbacks allowed, as the product's
    ///      protection grant needs.
    function _perm(address target, bytes4 sel, TokenLimit[] memory limits, uint256 maxValue)
        internal
        view
        returns (Permission memory p)
    {
        p = _permPlain(target, sel, limits, maxValue);
        p.allowCallback = true;
    }

    /// @dev A grant on a plain target: no peripheral rights (the default and the safe shape).
    function _permPlain(address target, bytes4 sel, TokenLimit[] memory limits, uint256 maxValue)
        internal
        view
        returns (Permission memory p)
    {
        p.target = target;
        p.selector = sel;
        p.maxValuePerPeriod = maxValue;
        p.tokenLimits = limits;
        p.period = 1 days;
        p.expiry = uint40(block.timestamp + 30 days);
        p.allowCallback = false;
    }

    function _limits1(address t, uint256 a) internal pure returns (TokenLimit[] memory l) {
        l = new TokenLimit[](1);
        l[0] = TokenLimit(t, a);
    }

    function _limits2(address t1, uint256 a1, address t2, uint256 a2)
        internal
        pure
        returns (TokenLimit[] memory l)
    {
        l = new TokenLimit[](2);
        l[0] = TokenLimit(t1, a1);
        l[1] = TokenLimit(t2, a2);
    }
}
