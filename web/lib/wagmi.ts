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
import { base } from "wagmi/chains";
import { CHAIN_ID } from "@zyo/shared";
import { ENV } from "./env";

if (base.id !== CHAIN_ID) throw new Error("wagmi base chain id does not match @zyo/shared CHAIN_ID");

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

export const wagmiConfig = createConfig({
  chains: [base],
  connectors,
  transports: {
    [base.id]: http(ENV.baseRpcUrl, { batch: true, timeout: 8_000, retryCount: 1 }),
  },
  ssr: true,
  multiInjectedProviderDiscovery: true,
});

export const BASE_CHAIN = base;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
