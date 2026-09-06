"use client";

import Link from "next/link";
import { COLLATERAL_ASSETS, FEES, ltvPresets } from "@zyo/shared";
import { useMarket, useSession } from "@/lib/hooks";
import { fmtPct } from "@/lib/format";
import { TokenMark } from "@/components/TokenMark";
import Chip from "@/components/Chip";

const PATHS = [
  {
    href: "/onboard",
    kicker: "I hold ZEC on Coinbase",
    title: "ZEC → cbZEC on Base",
    body: "Three steps through your Coinbase account. Jurisdiction check first, identity-verification facts stated, the real cbZEC address pinned.",
    cta: "Start onboarding",
  },
  {
    href: "/new",
    kicker: "I hold cbBTC or WETH on Base",
    title: "Borrow USDC, deploy it",
    body: "Supply collateral on Aave v3, borrow USDC at the live rate, and deploy into an Aerodrome pool that clears the yield gate — or just hold the USDC.",
    cta: "Open a position",
  },
  {
    href: "/spot",
    kicker: "I want to swap",
    title: "Spot via CoW",
    body: "cbZEC, cbBTC, WETH and USDC through CoW Protocol batch auctions. Quote, sign an intent, settle when a solver fills it.",
    cta: "Get a quote",
  },
];

export default function Home() {
  const s = useSession();
  const { market, source } = useMarket();

  return (
    <div className="space-y-12">
      <section className="pt-6 text-center">
        <p className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-brass">Your collateral. Working. From an account you own.</p>
        <h1 className="mx-auto max-w-3xl text-[34px] leading-tight md:text-[46px]">Borrow against cbBTC or WETH on Base and put the USDC to work</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[17px] text-oil-ink2">
          One transaction from your wallet: supply → borrow → deploy. Positions sit in your own OilskinAccount, earnings are claimable to your wallet, and every risk number is read from the venue at the moment you sign.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href="/new" className="btn-brass btn-lg">
            Open a position
          </Link>
          <Link href="/dashboard" className="btn-ghost btn-lg">
            {s.mode === "demo" ? "See the demo dashboard" : "Your dashboard"}
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {PATHS.map((p) => (
          <Link key={p.href} href={p.href} className="card group p-6 transition hover:border-oil-ink3">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-oil-ink3">{p.kicker}</div>
            <h3 className="mt-1.5 text-[17px]">{p.title}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-oil-ink2">{p.body}</p>
            <div className="mt-4 text-[13.5px] font-semibold text-brass group-hover:underline">{p.cta} →</div>
          </Link>
        ))}
      </section>

      <section className="card p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px]">What the venue says today</h2>
          <span className="text-[12px] text-oil-ink3">
            Aave v3 · {source === "live" ? "live read" : `snapshot ${market.readAt.slice(0, 10)}`}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(["cbBTC", "WETH", "cbZEC"] as const).map((sym) => {
            const asset = COLLATERAL_ASSETS[sym];
            const r = market.reserves[sym];
            const presets = r ? ltvPresets(r.liquidationThresholdBps) : null;
            const top = presets?.find((p) => p.id === "top");
            return (
              <div key={sym} className="rounded-xl border border-oil-line bg-oil-bg2 p-4">
                <div className="flex items-center gap-2.5">
                  <TokenMark symbol={sym} size={26} />
                  <span className="font-semibold">{sym}</span>
                  {asset.enabled && r ? <Chip kind="good">collateral</Chip> : <Chip kind="mute">not yet</Chip>}
                </div>
                {r && top ? (
                  <dl className="num mt-3 grid grid-cols-2 gap-y-1 text-[13px]">
                    <dt className="text-oil-ink3">Liquidation threshold</dt>
                    <dd className="text-right">{fmtPct(r.liquidationThresholdBps / 100, 0)}</dd>
                    <dt className="text-oil-ink3">Top LTV we offer</dt>
                    <dd className="text-right">{fmtPct(top.ltvBps / 100, 0)}</dd>
                    <dt className="text-oil-ink3">Entry HF at top</dt>
                    <dd className="text-right">{top.entryHf?.toFixed(2)}</dd>
                  </dl>
                ) : (
                  <p className="mt-3 text-[12.5px] leading-relaxed text-oil-ink2">{asset.disabledReason}</p>
                )}
              </div>
            );
          })}
        </div>
        <p className="num mt-4 text-[13px] text-oil-ink2">
          USDC borrow rate now <b className="text-oil-ink">{fmtPct(market.usdcBorrowAprPct)}</b> variable · performance fee {FEES.performanceBps / 100}% of realised yield, never on principal.
        </p>
      </section>

      <section className="card p-6">
        <h3 className="mb-2 text-[15px]">Simple or Advanced — your choice, top right</h3>
        <p className="text-[13.5px] leading-relaxed text-oil-ink2">
          <b className="text-oil-ink">Simple</b> is the guided path: connect, pick collateral, pick a setting, take the one recommendation the live numbers support, sign — every step explained in one plain sentence, every preventable mistake caught before your wallet opens (wrong network, not enough ETH for the fee, more than you hold, a counterfeit token, a typed address). <b className="text-oil-ink">Advanced</b> is the full suite: every pool with the model&rsquo;s numbers and why it was refused, custom band width and rebalance delay, price tolerance, spot swaps via CoW, claim / unwind / keeper controls, and raw position data.
        </p>
      </section>

      <section className="card p-6">
        <h3 className="mb-2 text-[15px]">Honest by design</h3>
        <p className="text-[13.5px] leading-relaxed text-oil-ink2">
          Every liquidation threshold, LTV cap and health factor on this site is computed from a live chain read — the top LTV per asset is floor(threshold ÷ entry-HF floor) and never a typed number, and the lending venue itself refuses a borrow under that floor. A pool is offered only when its emissions, net of every fee and net of the loss from the price moving, beat the live USDC borrow rate under <b className="text-oil-ink">both</b> of the models we price it with; when they disagree we do not offer it. The keeper acts only through one permission you grant on your own account, that expires, and that you can revoke. Everything it does, you can do yourself.
        </p>
      </section>
    </div>
  );
}
