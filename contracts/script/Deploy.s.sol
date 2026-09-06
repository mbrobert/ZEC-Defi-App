// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OilskinAccountFactory} from "../src/account/OilskinAccountFactory.sol";
import {AaveV3Venue} from "../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../src/venues/MorphoBlueVenue.sol";
import {SnuggleLpVenue} from "../src/venues/SnuggleLpVenue.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
import {AerodromeSwapAdapter} from "../src/swap/AerodromeSwapAdapter.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {PythOracleAdapter} from "../src/oracle/PythOracleAdapter.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IAaveV3.sol";
import {IMorphoBlue} from "../src/interfaces/IMorphoBlue.sol";
import {ICollateralRegistry} from "../src/interfaces/ICollateralRegistry.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {IAerodromeSwapRouter} from "../src/interfaces/IAerodromeSwapRouter.sol";
import {IAerodromeCLPool} from "../src/interfaces/IAerodromeCLPool.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";

/// @notice Base mainnet (chain id 8453) addresses — EVERY one from docs/VERIFIED-BASE-FACTS.md
///         (read live 2026-09-05) or AUDIT-FINDINGS Part 1 (engine, 2026-09-03). Nothing else may
///         appear here. The one address the product needs that is NOT verified — the Aerodrome
///         Slipstream SwapRouter — must be supplied by env after being probed, and the script
///         refuses to run on mainnet without it.
library BaseAddresses {
    uint256 internal constant CHAIN_ID = 8453;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant CBZEC = 0xB2000000000000000000008501b13360000cb2EC;
    address internal constant AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;

    address internal constant AAVE_POOL_ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_POOL_DATA_PROVIDER = 0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A;
    address internal constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;

    address internal constant CHAINLINK_CBBTC_USD = 0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D;
    address internal constant CHAINLINK_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant CHAINLINK_USDC_USD = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;

    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    bytes32 internal constant PYTH_ZEC_USD = 0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24;

    address internal constant AERODROME_VOTER = 0x16613524e02ad97eDfeF371bC883F2F5d6C480A5;
    address internal constant AERODROME_CBZEC_USDC_POOL = 0x0Fc47C17AF86078d809358db1b4db2DeBC988566;

    address internal constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev MaxFi / Snuggle engine proxy (AUDIT-FINDINGS-2026-09-03 Part 1, re-verified 2026-09-03).
    address internal constant SNUGGLE_ENGINE = 0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55;
}

/// @title Deploy — the v1 surface on Base.
///
/// Env:
///   CONFIRM_BASE_MAINNET     "true" to allow chain id 8453 (the guard)
///   TREASURY                 fee destination (required on mainnet; must not be the broadcaster)
///   REGISTRY_OWNER           CollateralRegistry owner — a Safe on mainnet (required on mainnet)
///   AERODROME_SWAP_ROUTER    Slipstream SwapRouter — PROBED, not in VERIFIED-BASE-FACTS (required)
///   PERFORMANCE_BPS          default 1000  (packages/shared FEES.performanceBps; capped on chain)
///   ENTRY_HF_FLOOR_WAD       default 1.55e18 (packages/shared ENTRY_HF_FLOOR)
///   REGISTRY_TIMELOCK_DELAY  default 172800 (2 days) — the IMMUTABLE delay on replacing an
///                            asset's venue. Bounded [1 hours, 30 days] by the registry.
///   DEPLOY_PYTH_ADAPTER      "true" to also deploy the v1.1 PythOracleAdapter (unused in v1)
///   PYTH_MAX_AGE / PYTH_MAX_DEVIATION_BPS / PYTH_TWAP_WINDOW  adapter params (defaults 60 / 300 / 1800)
///   ALLOW_ANY_CHAIN          "true" to run on a non-Base chain with ALL addresses given by env
///                            (local / test only; every constant above can be overridden by an env
///                            var of the same name)
///
/// Usage:
///   CONFIRM_BASE_MAINNET=true TREASURY=0x… REGISTRY_OWNER=0x… AERODROME_SWAP_ROUTER=0x… \
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
contract Deploy is Script {
    struct Config {
        address usdc;
        address weth;
        address cbbtc;
        address cbzec;
        address aero;
        address aaveProvider;
        address chainlinkCbbtcUsd;
        address chainlinkEthUsd;
        address pyth;
        bytes32 pythZecUsd;
        address cbzecUsdcPool;
        address morpho;
        address permit2;
        address engine;
        address aerodromeSwapRouter;
        address treasury;
        address registryOwner;
        /// @dev Who sends the setup transactions: the broadcaster in `run()`, the caller in tests.
        address deployer;
        uint256 performanceBps;
        uint256 entryHfFloorWad;
        uint256 registryTimelockDelay;
        bool deployPythAdapter;
        uint256 pythMaxAge;
        uint256 pythMaxDeviationBps;
        uint32 pythTwapWindow;
    }

    struct Deployed {
        OilskinAccountFactory factory;
        AaveV3Venue aaveVenue;
        MorphoBlueVenue morphoVenue;
        SnuggleLpVenue lpVenue;
        CollateralRegistry registry;
        AerodromeSwapAdapter swapAdapter;
        StrategyRouter router;
        PythOracleAdapter pythAdapter;
    }

    error UnsupportedChain(uint256 chainId);
    error MainnetNotConfirmed();
    error MissingEnv(string name);
    error NoCode(string name, address addr);
    error AaveProviderDrift(string what, address expected, address actual);
    error UnexpectedToken(string what);

    string internal constant CBZEC_NOTE = "no collateral market on Base yet";

    function run() external returns (Deployed memory d) {
        Config memory c = configFromEnv();
        guard(c);
        vm.startBroadcast();
        d = deploy(c);
        vm.stopBroadcast();
        _log(d);
    }

    // ---------------------------------------------------------------- config

    function configFromEnv() public view returns (Config memory c) {
        c.usdc = vm.envOr("USDC", BaseAddresses.USDC);
        c.weth = vm.envOr("WETH", BaseAddresses.WETH);
        c.cbbtc = vm.envOr("CBBTC", BaseAddresses.CBBTC);
        c.cbzec = vm.envOr("CBZEC", BaseAddresses.CBZEC);
        c.aero = vm.envOr("AERO", BaseAddresses.AERO);
        c.aaveProvider = vm.envOr("AAVE_POOL_ADDRESSES_PROVIDER", BaseAddresses.AAVE_POOL_ADDRESSES_PROVIDER);
        c.chainlinkCbbtcUsd = vm.envOr("CHAINLINK_CBBTC_USD", BaseAddresses.CHAINLINK_CBBTC_USD);
        c.chainlinkEthUsd = vm.envOr("CHAINLINK_ETH_USD", BaseAddresses.CHAINLINK_ETH_USD);
        c.pyth = vm.envOr("PYTH", BaseAddresses.PYTH);
        c.pythZecUsd = vm.envOr("PYTH_ZEC_USD", BaseAddresses.PYTH_ZEC_USD);
        c.cbzecUsdcPool = vm.envOr("AERODROME_CBZEC_USDC_POOL", BaseAddresses.AERODROME_CBZEC_USDC_POOL);
        c.morpho = vm.envOr("MORPHO_BLUE", BaseAddresses.MORPHO_BLUE);
        c.permit2 = vm.envOr("PERMIT2", BaseAddresses.PERMIT2);
        c.engine = vm.envOr("SNUGGLE_ENGINE", BaseAddresses.SNUGGLE_ENGINE);
        c.aerodromeSwapRouter = vm.envOr("AERODROME_SWAP_ROUTER", address(0));
        c.treasury = vm.envOr("TREASURY", address(0));
        c.registryOwner = vm.envOr("REGISTRY_OWNER", address(0));
        c.deployer = msg.sender;
        c.performanceBps = vm.envOr("PERFORMANCE_BPS", uint256(1000));
        c.entryHfFloorWad = vm.envOr("ENTRY_HF_FLOOR_WAD", uint256(1.55e18));
        c.registryTimelockDelay = vm.envOr("REGISTRY_TIMELOCK_DELAY", uint256(2 days));
        c.deployPythAdapter = vm.envOr("DEPLOY_PYTH_ADAPTER", false);
        c.pythMaxAge = vm.envOr("PYTH_MAX_AGE", uint256(60));
        c.pythMaxDeviationBps = vm.envOr("PYTH_MAX_DEVIATION_BPS", uint256(300));
        c.pythTwapWindow = uint32(vm.envOr("PYTH_TWAP_WINDOW", uint256(1800)));
    }

    // ----------------------------------------------------------------- guard

    /// @notice Refuses to deploy unless the chain is Base with explicit confirmation (or a
    ///         non-Base chain with ALLOW_ANY_CHAIN), every required env is set, every dependency
    ///         holds code, and Aave's provider still resolves to the verified pool / data provider
    ///         / oracle. A drift means VERIFIED-BASE-FACTS must be re-read before deploying.
    function guard(Config memory c) public view {
        bool isBase = block.chainid == BaseAddresses.CHAIN_ID;
        if (isBase) {
            if (!vm.envOr("CONFIRM_BASE_MAINNET", false)) revert MainnetNotConfirmed();
        } else if (!vm.envOr("ALLOW_ANY_CHAIN", false)) {
            revert UnsupportedChain(block.chainid);
        }
        if (c.treasury == address(0)) revert MissingEnv("TREASURY");
        if (c.registryOwner == address(0)) revert MissingEnv("REGISTRY_OWNER");
        if (c.aerodromeSwapRouter == address(0)) revert MissingEnv("AERODROME_SWAP_ROUTER");

        _requireCode("USDC", c.usdc);
        _requireCode("WETH", c.weth);
        _requireCode("cbBTC", c.cbbtc);
        _requireCode("AERO", c.aero);
        _requireCode("Aave PoolAddressesProvider", c.aaveProvider);
        _requireCode("Permit2", c.permit2);
        _requireCode("Snuggle engine", c.engine);
        _requireCode("Aerodrome SwapRouter", c.aerodromeSwapRouter);
        _requireCode("Morpho Blue", c.morpho);
        // cbZEC is a B20 precompile: eth_getCode returns 0xef (1 byte) — presence, not size.
        if (c.cbzec.code.length == 0) revert NoCode("cbZEC", c.cbzec);

        if (isBase) {
            IPoolAddressesProvider p = IPoolAddressesProvider(c.aaveProvider);
            if (p.getPool() != BaseAddresses.AAVE_POOL) {
                revert AaveProviderDrift("pool", BaseAddresses.AAVE_POOL, p.getPool());
            }
            if (p.getPoolDataProvider() != BaseAddresses.AAVE_POOL_DATA_PROVIDER) {
                revert AaveProviderDrift("dataProvider", BaseAddresses.AAVE_POOL_DATA_PROVIDER, p.getPoolDataProvider());
            }
            if (p.getPriceOracle() != BaseAddresses.AAVE_ORACLE) {
                revert AaveProviderDrift("oracle", BaseAddresses.AAVE_ORACLE, p.getPriceOracle());
            }
            // The engine must answer the index getter shape we build on (FACT 1): a fresh address
            // has no positions, so index 0 must REVERT (an array-returning getter would not).
            (bool ok,) = c.engine.staticcall(
                abi.encodeCall(ISnuggleVault.userPositions, (address(0xdead), 0))
            );
            if (ok) revert UnexpectedToken("engine userPositions(address,uint256) did not revert past end");
        }
    }

    // ---------------------------------------------------------------- deploy

    function deploy(Config memory c) public returns (Deployed memory d) {
        d.factory = new OilskinAccountFactory(c.permit2);
        d.morphoVenue = new MorphoBlueVenue(IMorphoBlue(c.morpho));
        d.lpVenue = new SnuggleLpVenue(ISnuggleVault(c.engine), c.aero, c.treasury, c.performanceBps);
        // Registry FIRST: the collateral venue enforces the registry's entry floor and offer flags
        // itself, so it needs the registry address at construction (and the registry only needs the
        // venue when an asset is registered, after both exist).
        // Owned by the deployer during setup, then handed to REGISTRY_OWNER (2-step).
        d.registry = new CollateralRegistry(c.deployer, c.entryHfFloorWad, c.registryTimelockDelay);
        d.aaveVenue = new AaveV3Venue(IPoolAddressesProvider(c.aaveProvider), ICollateralRegistry(address(d.registry)));
        d.registry.register(c.cbbtc, address(d.aaveVenue), c.chainlinkCbbtcUsd, true, "");
        d.registry.register(c.weth, address(d.aaveVenue), c.chainlinkEthUsd, true, "");
        d.registry.register(c.cbzec, address(d.aaveVenue), c.pyth, false, CBZEC_NOTE);
        d.registry.transferOwnership(c.registryOwner);
        d.swapAdapter = new AerodromeSwapAdapter(IAerodromeSwapRouter(c.aerodromeSwapRouter));
        d.router = new StrategyRouter(d.registry, d.lpVenue, d.swapAdapter, IPermit2(c.permit2), c.usdc);
        if (c.deployPythAdapter) {
            d.pythAdapter = new PythOracleAdapter(
                IPyth(c.pyth),
                c.pythZecUsd,
                IAerodromeCLPool(c.cbzecUsdcPool),
                c.cbzec,
                c.usdc,
                c.pythMaxAge,
                c.pythMaxDeviationBps,
                c.pythTwapWindow
            );
        }
    }

    // ------------------------------------------------------------- internal

    function _requireCode(string memory name, address a) internal view {
        if (a.code.length == 0) revert NoCode(name, a);
    }

    function _log(Deployed memory d) internal view {
        console2.log("OilskinAccountFactory ", address(d.factory));
        console2.log("  implementation      ", d.factory.IMPLEMENTATION());
        console2.log("AaveV3Venue           ", address(d.aaveVenue));
        console2.log("MorphoBlueVenue (off) ", address(d.morphoVenue));
        console2.log("SnuggleLpVenue        ", address(d.lpVenue));
        console2.log("CollateralRegistry    ", address(d.registry));
        console2.log("AerodromeSwapAdapter  ", address(d.swapAdapter));
        console2.log("StrategyRouter        ", address(d.router));
        console2.log("PythOracleAdapter     ", address(d.pythAdapter));
        console2.log("NOTE: REGISTRY_OWNER must call registry.acceptOwnership()");
        console2.log("Registry venue-change timelock (s)", d.registry.TIMELOCK_DELAY());
    }
}
