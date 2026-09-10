"use client";

import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useBalance, useDisconnect } from "wagmi";
import { shortAddress } from "@zyo/shared";
import { BASE_CHAIN, BASE_TOKENS, CHAIN_ID } from "@/lib/chain";
import { ENV } from "@/lib/env";
import Chip from "./Chip";

/** Brass, the one accent — varied deterministically per address so wallets are visually distinct. No new dependency, no colour outside the Oilcloth palette. */
const AVATAR_SHADES = ["#CDA355", "#DDB56A", "#B0863A"];

function avatarShade(address: string): string {
  const n = Number.parseInt(address.slice(2, 4), 16) || 0;
  return AVATAR_SHADES[n % AVATAR_SHADES.length];
}

function AddressAvatar({ address }: { address: string }) {
  return (
    <span
      aria-hidden
      data-testid="wallet-avatar"
      className="grid h-5 w-5 flex-none place-items-center rounded-full text-[9px] font-bold text-brass-on"
      style={{ background: avatarShade(address) }}
    >
      {address.slice(2, 4).toUpperCase()}
    </span>
  );
}

function UsdcBalance({ address }: { address: `0x${string}` }) {
  const offline = ENV.forceDemo;
  const { data, isFetching } = useBalance({
    address,
    token: BASE_TOKENS.USDC.address,
    chainId: CHAIN_ID,
    query: { enabled: !offline },
  });
  const label = offline ? "—" : isFetching ? "…" : !data ? "—" : `${Number(data.formatted).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  return (
    <span className="num text-[12.5px] text-oil-ink2" data-testid="wallet-usdc-balance">
      {label}
    </span>
  );
}

/** The RainbowKit connect control, restyled to the Oilcloth theme: one primary button when disconnected, a pill (avatar, address, chain, USDC balance) with its own copy/Basescan/disconnect menu when connected. */
export default function WalletConnect() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { disconnect } = useDisconnect();

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selectable text remains */
    }
  }

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        if (!mounted) {
          return <span aria-hidden style={{ opacity: 0, pointerEvents: "none" }} />;
        }
        if (!account || !chain) {
          return (
            <button type="button" className="btn-brass" data-testid="wallet-connect-button" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        }
        const address = account.address as `0x${string}`;
        return (
          <div className="relative">
            <button
              type="button"
              className="btn-ghost gap-2"
              data-testid="wallet-pill"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <AddressAvatar address={address} />
              <span data-testid="wallet-address">{shortAddress(address)}</span>
              <Chip kind={chain.unsupported ? "warn" : "good"} title={chain.unsupported ? "Not Base — reads and writes are paused" : "Connected to Base"}>
                <span data-testid="wallet-chain-badge">{chain.unsupported ? (chain.name ?? "Wrong network") : "Base"}</span>
              </Chip>
              <UsdcBalance address={address} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="card absolute right-0 top-[calc(100%+6px)] z-50 min-w-[190px] p-1.5" role="menu" data-testid="wallet-menu">
                  <button type="button" className="btn-quiet w-full justify-start" role="menuitem" data-testid="wallet-menu-copy" onClick={() => copyAddress(address)}>
                    {copied ? "Copied" : "Copy address"}
                  </button>
                  <a
                    className="btn-quiet w-full justify-start"
                    role="menuitem"
                    data-testid="wallet-menu-basescan"
                    href={`${BASE_CHAIN.explorerUrl}/address/${address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Basescan ↗
                  </a>
                  <button
                    type="button"
                    className="btn-quiet w-full justify-start text-status-crit"
                    role="menuitem"
                    data-testid="wallet-menu-disconnect"
                    onClick={() => {
                      setMenuOpen(false);
                      disconnect();
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
