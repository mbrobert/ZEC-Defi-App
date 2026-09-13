"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSwitchChain } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { useMarket, useSession } from "@/lib/hooks";
import { fmtUsd0 } from "@/lib/format";
import Chip from "./Chip";
import ModeToggle from "./ModeToggle";
import WalletConnect from "./WalletConnect";
import { useMode } from "@/lib/mode";

const TABS = [
  { href: "/dashboard", label: "Dashboard", advancedOnly: false },
  { href: "/new", label: "New position", advancedOnly: false },
  { href: "/spot", label: "Spot", advancedOnly: true },
  { href: "/onboard", label: "ZEC → cbZEC", advancedOnly: false },
  { href: "/solana", label: "ZEC on Solana", advancedOnly: false },
];

export function OilskinMark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#CDA355" />
      <path d="M10 22 C 22 20, 34 26, 54 46" fill="none" stroke="#171204" strokeWidth="6" strokeLinecap="round" />
      <circle cx="30" cy="20.5" r="7.5" fill="#171204" />
    </svg>
  );
}

export default function Nav() {
  const path = usePathname();
  const s = useSession();
  const { market } = useMarket();
  const { switchChain, isPending } = useSwitchChain();
  const { mode } = useMode();
  const btc = market.reserves.cbBTC?.priceUsd;

  return (
    <nav className="sticky top-0 z-40 border-b border-white/10 bg-oil-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 text-[16.5px] font-bold" aria-label="Oilskin home">
          <OilskinMark />
          Oilskin
        </Link>
        <div className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
          {TABS.filter((t) => mode === "advanced" || !t.advancedOnly).map((t) => {
            const on = path === t.href || path.startsWith(`${t.href}/`);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition ${
                  on ? "bg-oil-surface2 text-oil-ink" : "text-oil-ink2 hover:bg-white/5 hover:text-oil-ink"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <ModeToggle />
          {btc !== undefined && (
            <span className="num hidden items-center gap-2 rounded-full border border-oil-line bg-oil-surface px-3 py-1.5 text-[13px] md:flex" title={`cbBTC ${market.source === "live" ? "live oracle read" : "snapshot"}`}>
              <span className="pulse" />
              cbBTC <b>{fmtUsd0(btc)}</b>
              <span className="text-[11px] text-oil-ink3">{market.source === "live" ? "live" : "snapshot"}</span>
            </span>
          )}
          {s.mode === "demo" ? <Chip kind="mute" title="No wallet connected — illustrative data, nothing moves">Demo</Chip> : s.wrongNetwork ? (
            <button className="btn-ghost text-status-warn" onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={isPending}>
              {isPending ? "Switching…" : "Wrong network — switch to Base"}
            </button>
          ) : (
            <Chip kind="good">Base</Chip>
          )}
          <WalletConnect />
        </div>
      </div>
    </nav>
  );
}
