// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "./Fixture.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeploySepolia, BaseSepoliaAddresses} from "../script/DeploySepolia.s.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Stands in for Aave's open faucet at its Sepolia address: mints the etched MockERC20.
contract FaucetDouble {
    function isPermissioned() external pure returns (bool) {
        return false;
    }

    function mint(address token, address to, uint256 amount) external returns (uint256) {
        MockERC20(token).mint(to, amount);
        return amount;
    }
}

/// @notice Proves the Sepolia script offline: its constants are the facts document, its guard is
///         as strict as the mainnet guard, the substitutes are one function of the tick, and the
///         UNCHANGED `Deploy.deploy()` wires them where the real venues would go. The positive
///         guard path needs the real chain and is proved by the dry run in docs/DEPLOY-SEPOLIA.md.
contract DeploySepoliaTest is Fixture {
    DeploySepolia script;

    address constant USDC_S = BaseSepoliaAddresses.USDC;
    address constant WETH_S = BaseSepoliaAddresses.WETH;
    address constant WBTC_S = BaseSepoliaAddresses.WBTC;
    int24 constant TICK = BaseSepoliaAddresses.CBZEC_USDC_TICK;
    uint256 constant Q192 = 2 ** 192;

    // Sepolia reserve facts read 2026-09-07 (VERIFIED-BASE-FACTS, Base Sepolia section)
    uint256 constant S_WETH_LTV = 8350;
    uint256 constant S_WETH_LT = 8500;
    uint256 constant S_USDC_LTV = 8250;
    uint256 constant S_USDC_LT = 8600;
    uint256 constant S_WBTC_LTV = 8150;
    uint256 constant S_WBTC_LT = 8300;
    uint256 constant S_PRICE_WETH_E8 = 248338911522;
    uint256 constant S_PRICE_USDC_E8 = 99988018;
    uint256 constant S_PRICE_WBTC_E8 = 7909201743569;
    uint256 constant S_RATE_WETH_RAY = 230920914197669894104638654;
    uint256 constant S_RATE_USDC_RAY = 29544749503604116043986237;

    function setUp() public override {
        super.setUp();
        script = new DeploySepolia();

        // The three real reserves, as ERC-20 doubles AT their Sepolia addresses.
        vm.etch(USDC_S, address(new MockERC20("USDC", "USDC", 6)).code);
        vm.etch(WETH_S, address(new MockERC20("Wrapped Ether", "WETH", 18)).code);
        vm.etch(WBTC_S, address(new MockERC20("WBTC", "WBTC", 8)).code);
        aave.setReserve(WETH_S, S_WETH_LTV, S_WETH_LT, 300, true, true, S_PRICE_WETH_E8, S_RATE_WETH_RAY);
        aave.setReserve(USDC_S, S_USDC_LTV, S_USDC_LT, 500, true, true, S_PRICE_USDC_E8, S_RATE_USDC_RAY);
        aave.setReserve(WBTC_S, S_WBTC_LTV, S_WBTC_LT, 500, true, false, S_PRICE_WBTC_E8, 0);
        vm.etch(BaseSepoliaAddresses.AAVE_FAUCET, address(new FaucetDouble()).code);
    }

    /// @dev `setUp` runs once and is snapshotted, so process env set there is not per-test state:
    ///      every test that needs TREASURY / REGISTRY_OWNER sets them itself.
    function _setRequiredEnv() internal {
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("REGISTRY_OWNER", vm.toString(registryOwner));
    }

    /// @dev The script's config with the three dependencies that have no code in this VM pointed
    ///      at the fixture's doubles (the mainnet DeployTest does the same).
    function _config(DeploySepolia.Substitutes memory s) internal view returns (Deploy.Config memory c) {
        c = script.sepoliaConfig(s, address(script));
        c.treasury = treasury;
        c.registryOwner = registryOwner;
        c.aaveProvider = address(aave);
        c.permit2 = address(permit2);
        c.morpho = address(aave); // any contract with code
    }

    function test_sepoliaConstantsAreTheFactsDocument() public pure {
        assertEq(BaseSepoliaAddresses.CHAIN_ID, 84532);
        assertEq(BaseSepoliaAddresses.USDC, 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f);
        assertEq(BaseSepoliaAddresses.WBTC, 0x54114591963CF60EF3aA63bEfD6eC263D98145a4);
        assertEq(BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER, 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00);
        assertEq(BaseSepoliaAddresses.AAVE_POOL, 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27);
        assertEq(BaseSepoliaAddresses.AAVE_POOL_DATA_PROVIDER, 0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b);
        assertEq(BaseSepoliaAddresses.AAVE_ORACLE, 0x943b0dE18d4abf4eF02A85912F8fc07684C141dF);
        assertEq(BaseSepoliaAddresses.AAVE_FAUCET, 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc);
        assertEq(BaseSepoliaAddresses.PYTH, 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729);
        assertEq(BaseSepoliaAddresses.PERMIT2, 0x000000000022D473030F116dDEE9F6B43aC78BA3);
        assertEq(BaseSepoliaAddresses.MORPHO_BLUE, 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
        assertEq(BaseSepoliaAddresses.CBZEC_USDC_TICK, -24509);
        assertEq(BaseSepoliaAddresses.ENGINE_MIN_HOLD_SECONDS, 60);
    }

    function test_guardRefusesEveryOtherChain() public {
        _setRequiredEnv();
        vm.expectRevert(abi.encodeWithSelector(DeploySepolia.NotBaseSepolia.selector, block.chainid));
        script.guardSepolia();
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(DeploySepolia.NotBaseSepolia.selector, 8453));
        script.guardSepolia();
    }

    function test_guardRequiresEnvThenCode() public {
        _setRequiredEnv();
        vm.chainId(84532);
        vm.setEnv("TREASURY", vm.toString(address(0)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "TREASURY"));
        script.guardSepolia();
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("REGISTRY_OWNER", vm.toString(address(0)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "REGISTRY_OWNER"));
        script.guardSepolia();
        vm.setEnv("REGISTRY_OWNER", vm.toString(registryOwner));
        // Tokens are etched; the first dependency WITHOUT code in this VM is Aave's provider.
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.NoCode.selector, "Aave PoolAddressesProvider", BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER
            )
        );
        script.guardSepolia();
    }

    function test_guardCatchesAaveProviderDrift() public {
        _setRequiredEnv();
        vm.chainId(84532);
        // Give every real dependency code, and make the provider a MockAave (resolves to itself).
        address[7] memory presence = [
            BaseSepoliaAddresses.CHAINLINK_BTC_USD,
            BaseSepoliaAddresses.CHAINLINK_ETH_USD,
            BaseSepoliaAddresses.PYTH,
            BaseSepoliaAddresses.PERMIT2,
            BaseSepoliaAddresses.MORPHO_BLUE,
            BaseSepoliaAddresses.AAVE_POOL,
            BaseSepoliaAddresses.AAVE_POOL_DATA_PROVIDER
        ];
        for (uint256 i; i < presence.length; ++i) {
            vm.etch(presence[i], address(aave).code);
        }
        vm.etch(BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER, address(aave).code);
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AaveProviderDrift.selector,
                "pool",
                BaseSepoliaAddresses.AAVE_POOL,
                BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER
            )
        );
        script.guardSepolia();
    }

    function test_substitutesAreOneFunctionOfTheTick() public {
        DeploySepolia.Substitutes memory s = script.deploySubstitutes(TICK);
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(TICK);
        uint256 sqrtP2 = uint256(sqrtP) * uint256(sqrtP);

        // pool: verified mainnet shape (token0 USDC, token1 cbZEC, spacing 200, fee 2000) at the tick
        assertEq(s.cbzecUsdcPool.token0(), USDC_S);
        assertEq(s.cbzecUsdcPool.token1(), address(s.cbzec));
        assertEq(s.cbzecUsdcPool.tickSpacing(), 200);
        assertEq(s.cbzecUsdcPool.fee(), 2000);
        assertEq(s.cbzecUsdcPool.tick(), TICK);
        assertEq(s.cbzecUsdcPool.twapTick(), TICK);
        assertEq(s.cbzecUsdcPool.sqrtPriceX96(), sqrtP);
        assertEq(s.cbzec.decimals(), 8);
        assertEq(s.cbzec.multiplier(), 1e18);

        // engine: the pool is approved with the same token order, and the 60 s hold is on
        (address pool, address t0, address t1, uint24 fee,, bool active,,) = s.engine.approvedPools(script.POOL_CBZEC_USDC());
        assertEq(pool, address(s.cbzecUsdcPool));
        assertEq(t0, USDC_S);
        assertEq(t1, address(s.cbzec));
        assertEq(fee, 2000);
        assertTrue(active);
        assertEq(s.engine.minHoldTime(), 60);

        // swap router: both directions are the pool price, derived, not typed
        assertEq(s.swapRouter.quote(address(s.cbzec), USDC_S, 1e8), (1e8 * Q192) / sqrtP2);
        assertEq(s.swapRouter.quote(USDC_S, address(s.cbzec), 1e6), (1e6 * sqrtP2) / Q192);
        uint256 roundTrip = s.swapRouter.quote(address(s.cbzec), USDC_S, s.swapRouter.quote(USDC_S, address(s.cbzec), 1_000e6));
        assertLe(roundTrip, 1_000e6, "no value minted by rounding");
        assertGt(roundTrip, 999e6, "round trip loses only rounding dust");
    }

    function test_tickOverrideMovesEverything() public {
        DeploySepolia.Substitutes memory a = script.deploySubstitutes(TICK);
        DeploySepolia.Substitutes memory b = script.deploySubstitutes(TICK - 200);
        // A lower tick = fewer cbZEC per USDC = more USDC per cbZEC.
        assertGt(
            b.swapRouter.quote(address(b.cbzec), USDC_S, 1e8), a.swapRouter.quote(address(a.cbzec), USDC_S, 1e8)
        );
        assertLt(b.cbzecUsdcPool.sqrtPriceX96(), a.cbzecUsdcPool.sqrtPriceX96());
    }

    function test_deployWiresSubstitutesWhereTheVenuesGo() public {
        DeploySepolia.Substitutes memory s = script.deploySubstitutes(TICK);
        Deploy.Config memory c = _config(s);
        Deploy.Deployed memory d = script.deploy(c);

        // real reserves registered as collateral, WBTC standing in for cbBTC
        assertTrue(d.registry.isEnabled(WBTC_S));
        assertTrue(d.registry.isEnabled(WETH_S));
        assertEq(d.registry.config(WBTC_S).decimals, 8);
        assertEq(d.registry.config(WBTC_S).priceFeed, BaseSepoliaAddresses.CHAINLINK_BTC_USD);
        assertEq(d.registry.config(WETH_S).priceFeed, BaseSepoliaAddresses.CHAINLINK_ETH_USD);
        // LT read live: min(5000, floor(8300 / 1.55)) = 5000 for WBTC, same for WETH at 8500
        assertEq(d.registry.maxOfferedLtvBps(WBTC_S), 5000);
        assertEq(d.registry.maxOfferedLtvBps(WETH_S), 5000);

        // the cbZEC double is registered disabled with the same note as mainnet
        CollateralRegistry.AssetConfig memory z = d.registry.config(address(s.cbzec));
        assertFalse(z.enabled);
        assertEq(z.decimals, 8);
        assertEq(z.priceFeed, BaseSepoliaAddresses.PYTH);
        assertEq(z.note, "no collateral market on Base yet");
        assertEq(d.registry.maxOfferedLtvBps(address(s.cbzec)), 0);

        // the substitutes sit exactly where the mainnet venues would
        assertEq(address(d.lpVenue.ENGINE()), address(s.engine));
        assertEq(d.lpVenue.REWARD_TOKEN(), address(s.aero));
        assertEq(address(d.swapAdapter.ROUTER()), address(s.swapRouter));
        assertEq(d.router.USDC(), USDC_S);
        (address t0, address t1,) = d.lpVenue.poolTokens(script.POOL_CBZEC_USDC());
        assertEq(t0, USDC_S, "router's PoolWithoutUsdc check passes for the substitute pool");
        assertEq(t1, address(s.cbzec));

        // ownership hand-off unchanged from mainnet
        assertEq(d.registry.owner(), address(script));
        assertEq(d.registry.pendingOwner(), registryOwner);
        assertEq(d.registry.TIMELOCK_DELAY(), 2 days);
        assertFalse(d.morphoVenue.enabled());
        assertEq(address(d.pythAdapter), address(0));
    }

    function test_fundSubstitutesUsesTheFaucet() public {
        DeploySepolia.Substitutes memory s = script.deploySubstitutes(TICK);
        script.fundSubstitutes(s, USDC_S);
        assertEq(s.cbzec.balanceOf(address(s.swapRouter)), 1_000e8);
        assertEq(IERC20(USDC_S).balanceOf(address(s.swapRouter)), 100_000e6);
    }
}
