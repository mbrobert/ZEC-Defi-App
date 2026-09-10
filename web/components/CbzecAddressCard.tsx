"use client";

import { useState } from "react";
import { COUNTERFEIT_PREFIX, classifyCbZecAddress } from "@zyo/shared";
import { BASE_CHAIN, CBZEC_ADDRESS } from "@/lib/chain";
import Chip from "./Chip";

/**
 * The pinned cbZEC address with a counterfeit checker. Scammers deploy
 * look-alikes sharing the `0xb2000…` prefix; anything with that prefix that is
 * not the pinned address is called out as counterfeit (classifier in
 * @zyo/shared, tested there and here).
 */
export default function CbzecAddressCard() {
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const cls = input.trim() ? classifyCbZecAddress(input.trim()) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(CBZEC_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the address is selectable text */
    }
  }

  return (
    <div className="card p-5" data-testid="cbzec-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px]">The real cbZEC on Base</h3>
        <Chip kind="brass">pinned · 8 decimals · B20</Chip>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="mono select-all rounded-lg border border-oil-line bg-oil-bg2 px-3 py-2 text-brass" data-testid="cbzec-address">
          {CBZEC_ADDRESS}
        </code>
        <button className="btn-ghost" onClick={copy} type="button">
          {copied ? "Copied" : "Copy"}
        </button>
        <a className="btn-quiet text-[13px]" href={`${BASE_CHAIN.explorerUrl}/token/${CBZEC_ADDRESS}`} target="_blank" rel="noreferrer">
          Basescan ↗
        </a>
      </div>
      <div className="note note-warn mt-4" role="note">
        <b className="text-oil-ink">Counterfeit warning.</b> A cluster of fake &ldquo;ZEC&rdquo; tokens shares the <code className="mono">{COUNTERFEIT_PREFIX}…</code> prefix. Only the address above is Coinbase Wrapped ZEC. Check every character — the prefix alone proves nothing.
      </div>
      <label className="label mt-4" htmlFor="cbzec-check">
        Paste the token address your wallet shows
      </label>
      <input
        id="cbzec-check"
        className="input font-mono text-[13px]"
        placeholder="0x…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {cls && (
        <div className="mt-2" data-testid="cbzec-verdict" data-verdict={cls}>
          {cls === "genuine" && <Chip kind="good">Genuine — this is the pinned cbZEC</Chip>}
          {cls === "counterfeit" && <Chip kind="crit">Counterfeit — shares the prefix but is NOT cbZEC. Do not buy or send.</Chip>}
          {cls === "unrelated" && <Chip kind="warn">Not cbZEC — a different token entirely</Chip>}
          {cls === "invalid" && <Chip kind="mute">Not an address</Chip>}
        </div>
      )}
    </div>
  );
}
