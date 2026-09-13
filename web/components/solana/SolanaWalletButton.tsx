"use client";

import dynamic from "next/dynamic";

// Rendered on the client only: the adapter reads window.* wallets, which a server render cannot see.
const WalletMultiButton = dynamic(async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton, { ssr: false, loading: () => <span className="btn btn-ghost opacity-60">Solana wallet…</span> });

export default function SolanaWalletButton() {
  return <WalletMultiButton className="btn btn-brass" data-testid="solana-wallet-button" />;
}
