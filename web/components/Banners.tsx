"use client";

import { useSwitchChain } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { useSession } from "@/lib/hooks";
import { DEMO_SNAPSHOT_AT, DEMO_SNAPSHOT_SOURCE } from "@/lib/demo";

/**
 * Demo-mode and wrong-network banners. Rendered once, under the nav, on every
 * page. Demo mode: no wallet connected → illustrative data, nothing signed.
 */
export default function Banners() {
  const s = useSession();
  const { switchChain, isPending } = useSwitchChain();
  if (s.wrongNetwork) {
    return (
      <div className="border-b border-status-warn/30 bg-status-warn/10" role="alert">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-3 px-4 py-2.5 text-[13.5px] sm:px-6">
          <span className="font-semibold text-status-warn">Wrong network.</span>
          <span className="text-oil-ink2">
            Oilskin runs on Base only (chain id {CHAIN_ID}). Your wallet is on chain {s.chainId ?? "?"}. Reads and writes are paused until you switch.
          </span>
          <button className="btn-brass ml-auto" onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={isPending}>
            {isPending ? "Switching…" : "Switch to Base"}
          </button>
        </div>
      </div>
    );
  }
  if (s.mode === "demo") {
    return (
      <div className="border-b border-brass/25 bg-brass/10" data-testid="demo-banner">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] sm:px-6">
          <span className="font-semibold text-brass">Demo mode — no wallet connected.</span>
          <span className="text-oil-ink2">
            Illustrative positions. Nothing is signed, no funds move. Market numbers are a snapshot of chain reads from {DEMO_SNAPSHOT_AT.slice(0, 10)} ({DEMO_SNAPSHOT_SOURCE}); connect a wallet for live reads.
          </span>
        </div>
      </div>
    );
  }
  return null;
}
