"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SOLANA_ENV } from "@/lib/solana/env";

/**
 * The Solana wallet session beside the Base one. Wallet Standard wallets (Phantom, Solflare, Backpack, …)
 * announce themselves to the adapter, so no per-wallet adapter list ships in the bundle. Nothing connects until
 * the user clicks; the Connection is created for the named cluster and used only by the Solana surfaces.
 */
export default function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={SOLANA_ENV.rpcUrl} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
