// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {Deploy, BaseAddresses} from "./Deploy.s.sol";
import {IPoolAddressesProvider, IAavePoolDataProvider} from "../src/interfaces/IAaveV3.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockB20} from "../test/mocks/MockB20.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockCLPool} from "../test/mocks/MockCLPool.sol";
import {MockSnuggleVault} from "../test/mocks/MockSnuggleVault.sol";
import {MockAerodromeSwapRouter} from "../test/mocks/MockAerodromeSwapRouter.sol";

/// @notice Base Sepolia (chain id 84532) addresses — EVERY one from the "Base Sepolia" section of
///         docs/VERIFIED-BASE-FACTS.md (read 2026-09-07, block 46,512,825). Nothing else may
///         appear here.
library BaseSepoliaAddresses {
    uint256 internal constant CHAIN_ID = 84532;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    /// @dev Aave's own test USDC (the reserve the Sepolia pool lends), NOT Circle's testnet USDC.
    address internal constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    /// @dev Aave's test WBTC (8 decimals, collateral-enabled, not borrowable) stands in for cbBTC,
    ///      which does not exist on Sepolia.
    address internal constant WBTC = 0x54114591963CF60EF3aA63bEfD6eC263D98145a4;

    address internal constant AAVE_POOL_ADDRESSES_PROVIDER = 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    address internal constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address internal constant AAVE_POOL_DATA_PROVIDER = 0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b;
    address internal constant AAVE_ORACLE = 0x943b0dE18d4abf4eF02A85912F8fc07684C141dF;
    /// @dev Owner of the test USDC / WBTC tokens; `isPermissioned()` = false, so anyone may mint.
    address internal constant AAVE_FAUCET = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc;

    address internal constant CHAINLINK_BTC_USD = 0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298;
    address internal constant CHAINLINK_ETH_USD = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;
    address internal constant CHAINLINK_USDC_USD = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165;

    address internal constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    address internal constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Live tick of the MAINNET cbZEC/USDC Slipstream pool (`slot0()` at block 51,002,395,
    ///      2026-09-07 15:15 UTC). The mock pool and the mock swap rate are both derived from this
    ///      one number so they cannot disagree. Override with CBZEC_USDC_TICK after a fresh read.
    int24 internal constant CBZEC_USDC_TICK = -24509;
    int24 internal constant CBZEC_USDC_TICK_SPACING = 200;
    uint24 internal constant CBZEC_USDC_FEE = 2000;
    /// @dev The engine's flash-loan hold, verified on the live engine (AUDIT-FINDINGS-2026-09-03 Part 1).
    uint256 internal constant ENGINE_MIN_HOLD_SECONDS = 60;
}

interface IAaveFaucet {
    function isPermissioned() external view returns (bool);
    function mint(address token, address to, uint256 amount) external returns (uint256);
}

/// @title DeploySepolia — the v1 surface on Base Sepolia with honest substitutes.
///
/// What is real here: Aave v3 (pool, data provider, oracle, WETH / test USDC / test WBTC reserves),
/// the three Chainlink feeds, Pyth, Permit2, Morpho Blue. What does NOT exist on Base Sepolia and
/// is therefore substituted behind the SAME interfaces the mainnet contracts are compiled against:
///
///   • cbZEC              → `MockB20` (8 decimals, live `multiplier()`, blocklist, pause)
///   • cbBTC              → Aave's test WBTC reserve (a real reserve; supply-only, like cbBTC would be)
///   • AERO               → `MockERC20` (the LP venue's reward token; nothing emits it here)
///   • Slipstream pool    → `MockCLPool` at the mainnet cbZEC/USDC tick
///   • MaxFi/Snuggle      → `MockSnuggleVault` (chain-verified semantics: index getter, re-key,
///                          single-sided mint, 60 s hold), pool approved, hold set to 60 s
///   • Slipstream router  → `MockAerodromeSwapRouter` at the pool price, funded with mock cbZEC
///                          and with test USDC minted from Aave's open faucet
///
/// The mocks keep their test switches (`setPaused`, `setGlitch`, `setMultiplier`, …) and those
/// are callable by ANYONE on the public testnet. That is acceptable for a testnet the founder
/// alone exercises and is stated in docs/DEPLOY-SEPOLIA.md; it is one more reason none of this
/// is a mainnet artefact.
///
/// The Oilskin contracts are deployed by the UNCHANGED `Deploy.deploy()` so the order the audit
/// reviewed (registry → venue → assets → two-step ownership → adapter → router) is what runs.
///
/// Env:
///   TREASURY                 fee destination (required; on testnet the deployer's own address is fine)
///   REGISTRY_OWNER           CollateralRegistry owner after `acceptOwnership()` (required)
///   CBZEC_USDC_TICK          override the mainnet tick baked above (int, after a fresh slot0 read)
///   SWAP_LIQUIDITY_USDC      test USDC minted from the faucet into the mock router (6 dp; default
///                            100_000e6 — the faucet accepts ≤ 1,000,000e6 per call, proven by eth_call)
///   SWAP_LIQUIDITY_CBZEC     mock cbZEC minted into the mock router (8 dp; default 1_000e8)
///   PERFORMANCE_BPS / ENTRY_HF_FLOOR_WAD / REGISTRY_TIMELOCK_DELAY / DEPLOY_PYTH_ADAPTER /
///   PYTH_MAX_AGE / PYTH_MAX_DEVIATION_BPS / PYTH_TWAP_WINDOW   as in Deploy.s.sol
///
/// Usage (dry run, then the founder broadcasts himself):
///   TREASURY=0x… REGISTRY_OWNER=0x… forge script script/DeploySepolia.s.sol \
///     --rpc-url base_sepolia --sender <oilskin-sepolia address> -vvvv
contract DeploySepolia is Deploy {
    struct Substitutes {
        MockB20 cbzec;
        MockERC20 aero;
        MockCLPool cbzecUsdcPool;
        MockSnuggleVault engine;
        MockAerodromeSwapRouter swapRouter;
        int24 tick;
    }

    error NotBaseSepolia(uint256 chainId);
    error ReserveShape(string what);
    error FaucetPermissioned();

    bytes32 public constant POOL_CBZEC_USDC = keccak256("aero-cl200-USDC-cbZEC");
    uint256 internal constant Q192 = 2 ** 192;

    function run() external override returns (Deployed memory d) {
        guardSepolia();
        vm.startBroadcast();
        Substitutes memory s = deploySubstitutes(_tick());
        Config memory c = sepoliaConfig(s, msg.sender);
        d = deploy(c);
        fundSubstitutes(s, c.usdc);
        vm.stopBroadcast();
        _log(d);
        _logSubstitutes(s);
    }

    // ---------------------------------------------------------------- guard

    /// @notice Refuses unless the chain is Base Sepolia, every real dependency holds code, Aave's
    ///         provider still resolves to the verified pool / data provider / oracle, the three
    ///         reserves still have the shape the product needs (WETH and WBTC collateral-enabled,
    ///         USDC borrowable), and the faucet is still open. Any drift means the Sepolia section
    ///         of VERIFIED-BASE-FACTS must be re-read before deploying.
    function guardSepolia() public view {
        if (block.chainid != BaseSepoliaAddresses.CHAIN_ID) revert NotBaseSepolia(block.chainid);
        if (vm.envOr("TREASURY", address(0)) == address(0)) revert MissingEnv("TREASURY");
        if (vm.envOr("REGISTRY_OWNER", address(0)) == address(0)) revert MissingEnv("REGISTRY_OWNER");

        _requireCode("WETH", BaseSepoliaAddresses.WETH);
        _requireCode("Aave test USDC", BaseSepoliaAddresses.USDC);
        _requireCode("Aave test WBTC", BaseSepoliaAddresses.WBTC);
        _requireCode("Aave PoolAddressesProvider", BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER);
        _requireCode("Aave faucet", BaseSepoliaAddresses.AAVE_FAUCET);
        _requireCode("Chainlink BTC/USD", BaseSepoliaAddresses.CHAINLINK_BTC_USD);
        _requireCode("Chainlink ETH/USD", BaseSepoliaAddresses.CHAINLINK_ETH_USD);
        _requireCode("Pyth", BaseSepoliaAddresses.PYTH);
        _requireCode("Permit2", BaseSepoliaAddresses.PERMIT2);
        _requireCode("Morpho Blue", BaseSepoliaAddresses.MORPHO_BLUE);

        IPoolAddressesProvider p = IPoolAddressesProvider(BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER);
        if (p.getPool() != BaseSepoliaAddresses.AAVE_POOL) {
            revert AaveProviderDrift("pool", BaseSepoliaAddresses.AAVE_POOL, p.getPool());
        }
        if (p.getPoolDataProvider() != BaseSepoliaAddresses.AAVE_POOL_DATA_PROVIDER) {
            revert AaveProviderDrift(
                "dataProvider", BaseSepoliaAddresses.AAVE_POOL_DATA_PROVIDER, p.getPoolDataProvider()
            );
        }
        if (p.getPriceOracle() != BaseSepoliaAddresses.AAVE_ORACLE) {
            revert AaveProviderDrift("oracle", BaseSepoliaAddresses.AAVE_ORACLE, p.getPriceOracle());
        }

        IAavePoolDataProvider data = IAavePoolDataProvider(BaseSepoliaAddresses.AAVE_POOL_DATA_PROVIDER);
        _requireReserve(data, BaseSepoliaAddresses.WETH, "WETH", true, true);
        _requireReserve(data, BaseSepoliaAddresses.WBTC, "WBTC", true, false);
        _requireReserve(data, BaseSepoliaAddresses.USDC, "USDC", false, true);

        if (IAaveFaucet(BaseSepoliaAddresses.AAVE_FAUCET).isPermissioned()) revert FaucetPermissioned();
    }

    // --------------------------------------------------------------- config

    function sepoliaConfig(Substitutes memory s, address deployer) public view returns (Config memory c) {
        c.usdc = BaseSepoliaAddresses.USDC;
        c.weth = BaseSepoliaAddresses.WETH;
        c.cbbtc = BaseSepoliaAddresses.WBTC;
        c.cbzec = address(s.cbzec);
        c.aero = address(s.aero);
        c.aaveProvider = BaseSepoliaAddresses.AAVE_POOL_ADDRESSES_PROVIDER;
        c.chainlinkCbbtcUsd = BaseSepoliaAddresses.CHAINLINK_BTC_USD;
        c.chainlinkEthUsd = BaseSepoliaAddresses.CHAINLINK_ETH_USD;
        c.pyth = BaseSepoliaAddresses.PYTH;
        // The Pyth price id is chain-agnostic; the Sepolia proxy answers it (VERIFIED-BASE-FACTS, Sepolia).
        c.pythZecUsd = vm.envOr("PYTH_ZEC_USD", BaseAddresses.PYTH_ZEC_USD);
        c.cbzecUsdcPool = address(s.cbzecUsdcPool);
        c.morpho = BaseSepoliaAddresses.MORPHO_BLUE;
        // The Morpho API does not index Base Sepolia and no cbBTC/WETH–USDC market is known there:
        // the venue deploys with no markets and reports enabled() == false.
        c.morphoMarketIds = new bytes32[](0);
        c.permit2 = BaseSepoliaAddresses.PERMIT2;
        c.engine = address(s.engine);
        c.aerodromeSwapRouter = address(s.swapRouter);
        c.treasury = vm.envOr("TREASURY", address(0));
        c.registryOwner = vm.envOr("REGISTRY_OWNER", address(0));
        c.deployer = deployer;
        c.performanceBps = vm.envOr("PERFORMANCE_BPS", uint256(1000));
        c.entryHfFloorWad = vm.envOr("ENTRY_HF_FLOOR_WAD", uint256(1.55e18));
        c.registryTimelockDelay = vm.envOr("REGISTRY_TIMELOCK_DELAY", uint256(2 days));
        c.deployPythAdapter = vm.envOr("DEPLOY_PYTH_ADAPTER", false);
        c.pythMaxAge = vm.envOr("PYTH_MAX_AGE", uint256(60));
        c.pythMaxDeviationBps = vm.envOr("PYTH_MAX_DEVIATION_BPS", uint256(300));
        c.pythTwapWindow = uint32(vm.envOr("PYTH_TWAP_WINDOW", uint256(1800)));
        // `guardSepolia` is the guard here; the mainnet opt-ins stay off.
        c.confirmBaseMainnet = false;
        c.allowAnyChain = false;
    }

    // ---------------------------------------------------------- substitutes

    /// @notice Deploys the stand-ins. Pure function of `tick`: pool price, TWAP tick and both swap
    ///         rates are all derived from it, so the mock pool and the mock router agree exactly
    ///         (zero fee — the real router charges 0.2 %, which only makes the mock generous).
    function deploySubstitutes(int24 tick) public returns (Substitutes memory s) {
        s.tick = tick;
        s.cbzec = new MockB20();
        s.aero = new MockERC20("Aerodrome (Sepolia stand-in)", "AERO", 18);

        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        s.cbzecUsdcPool = new MockCLPool(
            BaseSepoliaAddresses.USDC,
            address(s.cbzec),
            BaseSepoliaAddresses.CBZEC_USDC_TICK_SPACING,
            BaseSepoliaAddresses.CBZEC_USDC_FEE,
            sqrtP
        );
        s.cbzecUsdcPool.setTick(tick);
        s.cbzecUsdcPool.setTwapTick(tick);

        s.engine = new MockSnuggleVault();
        s.engine.addPool(
            POOL_CBZEC_USDC,
            address(s.cbzecUsdcPool),
            BaseSepoliaAddresses.USDC,
            address(s.cbzec),
            BaseSepoliaAddresses.CBZEC_USDC_FEE
        );
        s.engine.setMinHoldTime(BaseSepoliaAddresses.ENGINE_MIN_HOLD_SECONDS);

        // token0 = USDC, token1 = cbZEC (the verified mainnet order). price = sqrtP² / 2¹⁹²
        // is token1-per-token0 in raw units, so USDC → cbZEC multiplies by it and cbZEC → USDC
        // divides by it.
        uint256 sqrtP2 = uint256(sqrtP) * uint256(sqrtP);
        s.swapRouter = new MockAerodromeSwapRouter();
        s.swapRouter.setRate(BaseSepoliaAddresses.USDC, address(s.cbzec), sqrtP2, Q192);
        s.swapRouter.setRate(address(s.cbzec), BaseSepoliaAddresses.USDC, Q192, sqrtP2);
    }

    /// @notice Funds the mock router so the unwind path (cbZEC leg → USDC) can pay out: mock cbZEC
    ///         is minted directly, test USDC comes from Aave's open faucet.
    function fundSubstitutes(Substitutes memory s, address usdc) public {
        uint256 usdcAmount = vm.envOr("SWAP_LIQUIDITY_USDC", uint256(100_000e6));
        uint256 cbzecAmount = vm.envOr("SWAP_LIQUIDITY_CBZEC", uint256(1_000e8));
        s.cbzec.mint(address(s.swapRouter), cbzecAmount);
        IAaveFaucet(BaseSepoliaAddresses.AAVE_FAUCET).mint(usdc, address(s.swapRouter), usdcAmount);
    }

    // ------------------------------------------------------------- internal

    function _tick() internal view returns (int24) {
        int256 t = vm.envOr("CBZEC_USDC_TICK", int256(BaseSepoliaAddresses.CBZEC_USDC_TICK));
        require(t >= TickMath.MIN_TICK && t <= TickMath.MAX_TICK, "CBZEC_USDC_TICK out of range");
        return int24(t);
    }

    function _requireReserve(
        IAavePoolDataProvider data,
        address asset,
        string memory name,
        bool mustBeCollateral,
        bool mustBeBorrowable
    ) internal view {
        (,,,,, bool collateral, bool borrowable,, bool active, bool frozen) = data.getReserveConfigurationData(asset);
        if (!active || frozen) revert ReserveShape(string.concat(name, " inactive or frozen"));
        if (mustBeCollateral && !collateral) revert ReserveShape(string.concat(name, " not collateral"));
        if (mustBeBorrowable && !borrowable) revert ReserveShape(string.concat(name, " not borrowable"));
    }

    function _logSubstitutes(Substitutes memory s) internal pure {
        console2.log("--- Base Sepolia substitutes (NOT mainnet artefacts) ---");
        console2.log("cbZEC (MockB20)           ", address(s.cbzec));
        console2.log("AERO (MockERC20)          ", address(s.aero));
        console2.log("cbZEC/USDC pool (MockCL)  ", address(s.cbzecUsdcPool));
        console2.log("engine (MockSnuggleVault) ", address(s.engine));
        console2.log("swap router (mock)        ", address(s.swapRouter));
        console2.log("pool id                   ", vm.toString(POOL_CBZEC_USDC));
        console2.log("tick                      ", s.tick);
        console2.log("cbBTC stand-in = Aave test WBTC", BaseSepoliaAddresses.WBTC);
        console2.log("USDC = Aave test USDC          ", BaseSepoliaAddresses.USDC);
    }
}
