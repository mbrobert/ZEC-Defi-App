"use client";

import { useState } from "react";
import { useSession } from "@/lib/hooks";

/**
 * "Send ZEC on Base" needs a Base address typed into Coinbase — the single
 * place a user can send funds to the wrong address. So: show the connected
 * wallet's own address, copy it for them, and tell them how to check it.
 */
export default function WalletAddressCard() {
  const s = useSession();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(s.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selectable text remains */
    }
  }
  if (s.mode === "demo") {
    return (
      <div className="note mt-3" data-testid="wallet-address-card">
        <b className="text-oil-ink">Connect your wallet first</b> (top right) and this box will show the exact Base address to paste into Coinbase, with a copy button — so you never type an address by hand.
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-xl border border-brass/40 bg-brass/10 p-3.5" data-testid="wallet-address-card">
      <div className="text-[12.5px] font-semibold text-oil-ink">The address to paste into Coinbase — your connected wallet on Base</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="mono select-all rounded-lg border border-oil-line bg-oil-bg2 px-3 py-2 text-brass">{s.address}</code>
        <button className="btn-ghost" onClick={copy} type="button">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ul className="mt-2 space-y-0.5 text-[12.5px] text-oil-ink2">
        <li>· Paste it — never retype it. After pasting, check the first 4 and last 4 characters match: {s.address.slice(0, 6)}… …{s.address.slice(-4)}.</li>
        <li>· Choose the <b>Base</b> network in Coinbase. cbZEC exists on Base only; ZEC sent to this address on any other network is not recoverable by Oilskin.</li>
        <li>· Send a small test amount first if this is your first time.</li>
      </ul>
    </div>
  );
}
