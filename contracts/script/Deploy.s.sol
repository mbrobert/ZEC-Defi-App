// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {RewardRouter} from "../src/RewardRouter.sol";
import {SnuggleAdapter} from "../src/adapters/SnuggleAdapter.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {MockSnuggleVault} from "../test/mocks/MockSnuggleVault.sol";

/// @notice Deploys the vault + router + engine adapters.
///
/// Env vars:
///   OWNER            — admin (defaults to broadcaster; use a multisig in prod)
///   OPERATOR         — agent hot wallet
///   REFERRAL         — referral address passed to the engines (treasury)
///   MAXFI_ENGINE     — MaxFi vault proxy   (default: Base mainnet deployment)
///   SNUGGLE_ENGINE   — SnuggleFi vault proxy (0 = deploy a mock for testing)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast
contract Deploy is Script {
    /// @dev Verified MaxFi vault proxy on Base (maxfi.tech/security, 2026-08-05).
    address constant MAXFI_VAULT_PROXY_BASE = 0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55;

    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant BASE_CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        address owner = vm.envOr("OWNER", msg.sender);
        address operator = vm.envOr("OPERATOR", msg.sender);
        address referral = vm.envOr("REFERRAL", owner);
        address maxfiEngine = vm.envOr("MAXFI_ENGINE", MAXFI_VAULT_PROXY_BASE);
        address snuggleEngine = vm.envOr("SNUGGLE_ENGINE", address(0));

        vm.startBroadcast();

        PositionVault vault = new PositionVault(owner);
        RewardRouter router = new RewardRouter(owner, vault);

        if (snuggleEngine == address(0)) {
            snuggleEngine = address(new MockSnuggleVault());
            console2.log("deployed MOCK Snuggle engine", snuggleEngine);
        }

        SnuggleAdapter maxfiAdapter =
            new SnuggleAdapter(address(vault), ISnuggleVault(maxfiEngine), referral, owner);
        SnuggleAdapter snuggleAdapter =
            new SnuggleAdapter(address(vault), ISnuggleVault(snuggleEngine), referral, owner);

        vault.setOperator(operator, true);
        vault.setRewardRouter(address(router));
        vault.setAdapterAllowed(address(maxfiAdapter), true);
        vault.setAdapterAllowed(address(snuggleAdapter), true);
        vault.setTokenAllowed(BASE_USDC, true);
        vault.setTokenAllowed(BASE_CBBTC, true);
        vault.setTokenAllowed(BASE_WETH, true);

        router.setOperator(operator, true);
        // Conservative initial per-tx routing caps: 25k USDC, 0.5 cbBTC, 10 WETH.
        router.setMaxRoutePerTx(BASE_USDC, 25_000e6);
        router.setMaxRoutePerTx(BASE_CBBTC, 5e7);
        router.setMaxRoutePerTx(BASE_WETH, 10e18);

        // ⚠️ Per-pool exposure caps default to 0 (unlimited). Before opening to
        // users, set a cap per curated pool with vault.setMaxDepositPerPool(
        // enginePoolId, cap) sized to a safe fraction of that pool's TVL
        // (rule of thumb: ≤ 1–2% of pool liquidity) to bound price impact.
        // enginePoolIds come from packages/shared pools.ts / EnumeratePools.

        vm.stopBroadcast();

        console2.log("PositionVault   ", address(vault));
        console2.log("RewardRouter    ", address(router));
        console2.log("MaxFi adapter   ", address(maxfiAdapter));
        console2.log("Snuggle adapter ", address(snuggleAdapter));
        console2.log("MaxFi engine    ", maxfiEngine);
        console2.log("NOTE: enumerate engine poolIds with script/EnumeratePools.s.sol");
    }
}

/// @notice Reads the engine's approved pool registry so the UI/agent can map
///         our curated list to real bytes32 poolIds.
/// Usage:
///   forge script script/Deploy.s.sol:EnumeratePools --rpc-url $BASE_RPC_URL
contract EnumeratePools is Script {
    function run() external view {
        ISnuggleVault engine = ISnuggleVault(
            vm.envOr("ENGINE", address(0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55))
        );
        uint256 n = engine.poolIdsCount();
        console2.log("approved pools:", n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = engine.poolIds(i);
            (address pool, address t0, address t1, uint24 fee,, bool active,,) =
                engine.approvedPools(id);
            console2.log("--- pool", i);
            console2.logBytes32(id);
            console2.log("  pool ", pool);
            console2.log("  t0   ", t0);
            console2.log("  t1   ", t1);
            console2.log("  fee  ", fee);
            console2.log("  live ", active);
        }
    }
}
