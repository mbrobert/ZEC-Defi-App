// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {Deploy, BaseAddresses} from "../script/Deploy.s.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Proves the deploy script's wiring and its guard against the mocks (no RPC needed).
contract DeployTest is Fixture {
    Deploy script;

    function setUp() public override {
        super.setUp();
        script = new Deploy();
    }

    function _config() internal view returns (Deploy.Config memory c) {
        c.usdc = address(usdc);
        c.weth = address(weth);
        c.cbbtc = address(cbbtc);
        c.cbzec = address(cbzec);
        c.aero = address(aero);
        c.aaveProvider = address(aave);
        c.chainlinkCbbtcUsd = makeAddrView("feed-cbbtc");
        c.chainlinkEthUsd = makeAddrView("feed-eth");
        c.pyth = makeAddrView("pyth");
        c.pythZecUsd = BaseAddresses.PYTH_ZEC_USD;
        c.cbzecUsdcPool = address(poolCbzecUsdc);
        c.cbzecUsdcNpm = address(npmCbzec);
        c.cbzecUsdcGauge = address(gaugeCbzec);
        c.deployDirectLpVenue = true;
        c.morpho = address(morpho);
        c.morphoMarketIds = _morphoIds();
        c.permit2 = address(permit2);
        c.engine = address(engine);
        c.aerodromeSwapRouter = address(aeroRouter);
        c.treasury = treasury;
        c.registryOwner = registryOwner;
        c.deployer = address(script);
        c.performanceBps = 1000;
        c.entryHfFloorWad = 1.25e18;
        c.registryTimelockDelay = REGISTRY_TIMELOCK;
        // The fixture chain is 31337: opt in by default; the mainnet tests set what they need.
        c.allowAnyChain = true;
        c.confirmBaseMainnet = false;
    }

    function makeAddrView(string memory n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(n)))));
    }

    function test_verifiedConstantsAreTheFactsDocument() public pure {
        assertEq(BaseAddresses.CHAIN_ID, 8453);
        assertEq(BaseAddresses.USDC, 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(BaseAddresses.CBZEC, 0xB2000000000000000000008501b13360000cb2EC);
        assertEq(BaseAddresses.AAVE_POOL, 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
        assertEq(BaseAddresses.PERMIT2, 0x000000000022D473030F116dDEE9F6B43aC78BA3);
        assertEq(BaseAddresses.SNUGGLE_ENGINE, 0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55);
        assertEq(BaseAddresses.AERODROME_CBZEC_USDC_POOL, 0x0Fc47C17AF86078d809358db1b4db2DeBC988566);
    }

    function test_guardRefusesUnknownChainWithoutOptIn() public {
        Deploy.Config memory c = _config();
        c.allowAnyChain = false;
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, block.chainid));
        script.guard(c);
    }

    function test_guardRefusesMainnetWithoutConfirmation() public {
        Deploy.Config memory c = _config();
        vm.chainId(8453);
        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.guard(c);
    }

    function test_guardCatchesAaveProviderDrift() public {
        Deploy.Config memory c = _config();
        vm.chainId(8453);
        c.confirmBaseMainnet = true;
        c.registryOwner = address(aave); // a contract owner: past the S-LOW-1 check, on to the drift check
        // The mock provider resolves to itself, not to the verified pool: the guard must refuse.
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.AaveProviderDrift.selector, "pool", BaseAddresses.AAVE_POOL, address(aave))
        );
        script.guard(c);
    }

    /// Audit wave 2, S-LOW-1. The header of Deploy.s.sol said "TREASURY must not be the broadcaster"
    /// and "REGISTRY_OWNER — a Safe on mainnet"; the guard enforced neither, and the Sepolia runbook
    /// exports `TREASURY=$DEPLOYER` and a personal `REGISTRY_OWNER` into the same shell a mainnet
    /// run would inherit. Both are named reverts on chain 8453 now; a contract owner is enough.
    function test_FIX_S1_mainnetGuardRefusesTheBroadcasterAsTreasury() public {
        Deploy.Config memory c = _config();
        vm.chainId(8453);
        c.confirmBaseMainnet = true;
        c.treasury = c.deployer;
        vm.expectRevert(abi.encodeWithSelector(Deploy.TreasuryIsBroadcaster.selector, c.deployer));
        script.guard(c);
    }

    function test_FIX_S1b_mainnetGuardRefusesAnEoaRegistryOwner() public {
        Deploy.Config memory c = _config();
        vm.chainId(8453);
        c.confirmBaseMainnet = true;
        c.registryOwner = makeAddr("an-eoa-safe-is-not");
        vm.expectRevert(abi.encodeWithSelector(Deploy.RegistryOwnerNotAContract.selector, c.registryOwner));
        script.guard(c);
        // A contract owner (any code — a Safe on mainnet) passes this check and reaches the next one.
        c.registryOwner = address(aave);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.AaveProviderDrift.selector, "pool", BaseAddresses.AAVE_POOL, address(aave))
        );
        script.guard(c);
    }

    /// Off mainnet (a local chain, Sepolia's own script) the deployer may be its own treasury and
    /// an EOA may own the registry: the checks are mainnet-only by design.
    function test_FIX_S1c_theChecksAreMainnetOnly() public {
        Deploy.Config memory c = _config();
        c.treasury = c.deployer;
        c.registryOwner = makeAddr("eoa-owner-on-a-test-chain");
        script.guard(c); // passes
    }

    function test_configFromEnvReadsTheTwoOptIns() public {
        vm.setEnv("CONFIRM_BASE_MAINNET", "true");
        vm.setEnv("ALLOW_ANY_CHAIN", "true");
        Deploy.Config memory c = script.configFromEnv();
        assertTrue(c.confirmBaseMainnet);
        assertTrue(c.allowAnyChain);
        vm.setEnv("CONFIRM_BASE_MAINNET", "false");
        vm.setEnv("ALLOW_ANY_CHAIN", "false");
        c = script.configFromEnv();
        assertFalse(c.confirmBaseMainnet);
        assertFalse(c.allowAnyChain);
    }

    function test_guardRequiresEnvAndCode() public {
        Deploy.Config memory c = _config();
        c.aerodromeSwapRouter = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "AERODROME_SWAP_ROUTER"));
        script.guard(c);
        c = _config();
        c.treasury = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "TREASURY"));
        script.guard(c);
        c = _config();
        c.permit2 = makeAddrView("nothing-here");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NoCode.selector, "Permit2", c.permit2));
        script.guard(c);
        c = _config();
        script.guard(c); // everything present → passes
    }

    function test_deployWiresEverything() public {
        Deploy.Config memory c = _config();
        Deploy.Deployed memory d = script.deploy(c);
        assertEq(d.factory.accountOf(alice) != address(0), true);
        assertEq(address(d.aaveVenue.PROVIDER()), address(aave));
        assertTrue(d.morphoVenue.enabled(), "built over the two verified markets");
        assertEq(d.morphoVenue.marketIdOf(address(cbbtc)), morphoIdCbbtc);
        assertEq(d.morphoVenue.marketIdOf(address(weth)), morphoIdWeth);
        assertEq(address(d.morphoVenue.REGISTRY()), address(d.registry));
        assertEq(d.registry.venueOf(address(cbbtc)), address(d.aaveVenue), "Aave stays the registry's venue");
        assertEq(d.registry.venueOf(address(weth)), address(d.aaveVenue));
        assertEq(d.lpVenue.performanceBps(), 1000);
        assertEq(d.lpVenue.treasury(), treasury);
        assertEq(d.lpVenue.REWARD_TOKEN(), address(aero));
        assertEq(d.registry.entryHfFloorWad(), 1.25e18);
        assertTrue(d.registry.isEnabled(address(cbbtc)));
        assertTrue(d.registry.isEnabled(address(weth)));
        CollateralRegistry.AssetConfig memory z = d.registry.config(address(cbzec));
        assertFalse(z.enabled);
        assertEq(z.note, "no collateral market on Base yet");
        assertEq(z.decimals, 8);
        // floor(7800 × 100 / 125) = 6240, under Aave's LTV 7300; no product cap above it.
        assertEq(d.registry.maxOfferedLtvBps(address(cbbtc)), 6240);
        assertEq(d.registry.maxOfferedLtvBps(address(cbzec)), 0);
        assertEq(d.registry.owner(), address(script), "deployer owns until the Safe accepts");
        assertEq(d.registry.pendingOwner(), registryOwner);
        assertEq(address(d.router.REGISTRY()), address(d.registry));
        assertEq(address(d.router.LP_VENUE()), address(d.lpVenue));
        assertEq(address(d.router.SWAP()), address(d.swapAdapter));
        assertEq(d.router.USDC(), address(usdc));
        assertEq(address(d.pythAdapter), address(0), "v1.1 adapter not deployed by default");
        // 2026-09-11: the direct Slipstream venue over the cbZEC/USDC pool, bound to the pool's own
        // manager and gauge, its adapter bound to the same pool, both handed to the router.
        assertEq(address(d.router.LP_VENUE_DIRECT()), address(d.directLpVenue));
        assertEq(address(d.router.SWAP_DIRECT()), address(d.poolSwapAdapter));
        assertEq(address(d.directLpVenue.POOL()), address(poolCbzecUsdc));
        assertEq(address(d.directLpVenue.NPM()), address(npmCbzec));
        assertEq(address(d.directLpVenue.GAUGE()), address(gaugeCbzec));
        assertEq(address(d.directLpVenue.SWAP()), address(d.poolSwapAdapter));
        assertEq(address(d.poolSwapAdapter.POOL()), address(poolCbzecUsdc));
        assertEq(d.directLpVenue.REWARD_TOKEN(), address(aero));
        assertEq(d.directLpVenue.treasury(), treasury);
        assertEq(d.directLpVenue.performanceBps(), 1000);
    }

    function test_deployWithoutTheDirectVenueLeavesTheRouterOnTheEngineOnly() public {
        Deploy.Config memory c = _config();
        c.deployDirectLpVenue = false;
        Deploy.Deployed memory d = script.deploy(c);
        assertEq(address(d.directLpVenue), address(0));
        assertEq(address(d.poolSwapAdapter), address(0));
        assertEq(address(d.router.LP_VENUE_DIRECT()), address(0));
        assertEq(address(d.router.SWAP_DIRECT()), address(0));
    }

    function test_guardNamesAPoolThatNoLongerNamesTheRecordedManagerOrGauge() public {
        Deploy.Config memory c = _config();
        c.cbzecUsdcGauge = makeAddrView("some-other-gauge");
        vm.etch(c.cbzecUsdcGauge, hex"6001");
        vm.expectRevert(abi.encodeWithSelector(Deploy.SlipstreamDrift.selector, "pool.gauge", c.cbzecUsdcGauge, address(gaugeCbzec)));
        script.guard(c);
        c = _config();
        c.deployDirectLpVenue = false;
        c.cbzecUsdcGauge = address(0);
        script.guard(c); // not deployed → not checked
    }

    function test_deployOptionalPythAdapter() public {
        Deploy.Config memory c = _config();
        c.deployPythAdapter = true;
        c.pythMaxAge = 60;
        c.pythMaxDeviationBps = 300;
        c.pythTwapWindow = 1800;
        Deploy.Deployed memory d = script.deploy(c);
        assertEq(address(d.pythAdapter.POOL()), address(poolCbzecUsdc));
        assertEq(d.pythAdapter.PRICE_ID(), BaseAddresses.PYTH_ZEC_USD);
    }
}
