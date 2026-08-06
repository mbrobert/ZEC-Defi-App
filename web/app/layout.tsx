import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZEC Yield Orchestrator",
  description:
    "Earn yield on native ZEC — lend on Rhea Finance, run concentrated-liquidity strategies on Base, receive rewards back in your Zcash wallet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-ink-border">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 text-lg font-bold text-white">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zec font-black text-ink-bg">
                Z
              </span>
              Yield Orchestrator
            </Link>
            <div className="flex items-center gap-6 text-sm">
              <Link href="/deposit" className="text-ink-muted transition hover:text-white">
                Deposit
              </Link>
              <Link href="/dashboard" className="text-ink-muted transition hover:text-white">
                Dashboard
              </Link>
              <span className="rounded-full border border-ink-border px-3 py-1 text-xs text-ink-muted">
                Base · NEAR · Zcash
              </span>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        <footer className="border-t border-ink-border py-8 text-center text-xs text-ink-muted">
          Non-custodial strategy orchestration. Withdrawals are always open — even when paused.
        </footer>
      </body>
    </html>
  );
}
