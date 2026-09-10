/**
 * wagmi v2 config — Base only.
 *
 * Wallet UI: RainbowKit (chosen over ConnectKit because it is the more
 * actively maintained of the two on wagmi v2, ships first-class Coinbase
 * Wallet support including Smart Wallet via `preference`, renders every
 * EIP-6963-announced wallet under "Installed" without extra code, and has a
 * built-in wrong-network state on its ConnectButton that we mirror in
 * NetworkGuard). Theme is customised to the Oilcloth palette in Providers.
 *
 * Discovery: wagmi's `multiInjectedProviderDiscovery` (EIP-6963) is on by
 * default; MetaMask, Rabby, Coinbase extension etc. announce themselves and
 * are connected through the standard `injected` connector.
 *
 * WalletConnect: only enabled when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is
 * set — RainbowKit refuses an empty project id, and the Coinbase + injected
 * paths do not need it.
 */
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { coinbaseWallet, injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { mock } from "wagmi/connectors";
import { base, baseSepolia } from "wagmi/chains";
import { CHAINS } from "@zyo/shared";
import { CHAIN_ID, VIEM_CHAIN } from "./chain";
import { ENV } from "./env";

// The chain follows NEXT_PUBLIC_CHAIN_ID through lib/chain.ts (slice 6): Base, or Base Sepolia for a rehearsal.
if (VIEM_CHAIN.id !== CHAIN_ID) throw new Error("wagmi chain id does not match lib/chain CHAIN_ID");

export const APP_NAME = "Oilskin";

const hasWalletConnect = ENV.walletConnectProjectId.length > 0;

const walletGroups = [
  {
    groupName: "Recommended",
    wallets: hasWalletConnect
      ? [coinbaseWallet, metaMaskWallet, injectedWallet, walletConnectWallet, rainbowWallet]
      : [coinbaseWallet, injectedWallet],
  },
];

coinbaseWallet.preference = "all"; // EOA extension + Smart Wallet

export const connectors = connectorsForWallets(walletGroups, {
  appName: APP_NAME,
  appDescription: "Borrow USDC against cbBTC or WETH on Base and deploy it — from an account you own.",
  projectId: hasWalletConnect ? ENV.walletConnectProjectId : "oilskin-no-walletconnect",
});

/**
 * Test-only wallet (wagmi's own `mock` connector — no real chain interaction,
 * no signing capability tied to real assets). Address matches web/lib/demo.ts's
 * DEMO_ACCOUNT ("obviously synthetic; not anyone's address"), kept as its own
 * constant here rather than importing demo.ts into this foundational config
 * module. Deliberately NOT passed through connectorsForWallets, so it never
 * appears in RainbowKit's real connect modal — only reachable by calling
 * wagmi's connect() with this instance directly (see
 * components/E2EMockWalletConnector.tsx). Only added to the connector list at
 * all when ENV.mockWallet is on; never present in a normal/production build.
 */
export const E2E_MOCK_ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
export const e2eMockConnector = mock({ accounts: [E2E_MOCK_ACCOUNT], features: { defaultConnected: false } });

export const wagmiConfig = createConfig({
  chains: [VIEM_CHAIN],
  connectors: ENV.mockWallet ? [...connectors, e2eMockConnector] : connectors,
  // One transport per table wagmi's types know about; only VIEM_CHAIN is in `chains`, so only its
  // transport is ever used. The active chain gets ENV.baseRpcUrl, the other its public default.
  transports: {
    [base.id]: http(CHAIN_ID === base.id ? ENV.baseRpcUrl : CHAINS[8453].rpcDefault, { batch: true, timeout: 8_000, retryCount: 1 }),
    [baseSepolia.id]: http(CHAIN_ID === baseSepolia.id ? ENV.baseRpcUrl : CHAINS[84532].rpcDefault, { batch: true, timeout: 8_000, retryCount: 1 }),
  },
  ssr: true,
  multiInjectedProviderDiscovery: true,
});

export const BASE_CHAIN = VIEM_CHAIN;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
