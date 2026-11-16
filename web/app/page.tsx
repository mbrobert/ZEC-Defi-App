"use client";

import Link from "next/link";
import { ENTRY_HF_FLOOR, FEES, HF_MARKS, offeredLtvBounds } from "@zyo/shared";
import { COLLATERAL_ASSETS } from "@/lib/chain";
import { useMarket, useSession } from "@/lib/hooks";
import { fmtPct } from "@/lib/format";
import { TokenMark } from "@/components/TokenMark";
import Chip from "@/components/Chip";
import HeroInstrument from "@/components/HeroInstrument";
import Spotlight from "@/components/Spotlight";

/** Three starting points, by what the visitor holds. A list, because the three are alternatives, not steps. */
const PATHS = [
  {
    href: "/onboard",
    who: "I hold ZEC",
    title: "Every route your ZEC can take",
    body: "Say where your coin is — a Zcash wallet, an exchange, Solana, Base — and see every route from there: who holds it on the way, what has not been measured, and which ones end in a loan. One of them does not, and it says so.",
    cta: "See the routes",
  },
  {
    href: "/new",
    who: "I hold cbBTC or WETH on Base",
    title: "Borrow USDC, deploy it",
    body: "Supply collateral on Aave v3, borrow USDC at the live rate, read the forecast for every pool — both models, the loss from the price moving, the break-evens — and deploy into one, or just hold the USDC.",
    cta: "Open a position",
  },
  {
    href: "/spot",
    who: "I want to swap",
    title: "Spot via CoW",
    body: "cbZEC, cbBTC, WETH and USDC through CoW Protocol batch auctions. Quote, sign an intent, settle when a solver fills it.",
    cta: "Get a quote",
  },
];

/** What the product commits to, each in one sentence a reader can check against the page it describes. */
const COMMITMENTS = [
  {
    title: "Numbers are read, not typed",
    body: "Every liquidation threshold, LTV (loan-to-value) cap and health factor on this site is computed from a chain read — the top LTV per asset is floor(threshold ÷ entry floor) — and the lending venue itself refuses a borrow under that floor.",
  },
  {
    title: "The forecast is shown, not enforced",
    body: "Every curated pool comes with its emissions net of every fee and net of the loss from the price moving, set against the live USDC borrow rate under both of the models we price it with. You read it and acknowledge it before you deposit, including when it is negative. What is refused is refused for safety only: a stale price feed, a paused venue, a disabled asset, a borrow the pool cannot fund.",
  },
  {
    title: "The keeper works inside one permission",
    body: "It acts only through a grant you sign on your own account, that expires, and that you can revoke. Everything it does, you can do yourself.",
  },
];

export default function Home() {
  const s = useSession();
  const { market, source } = useMarket();

  return (
    <div className="space-y-14 pb-4">
      <section className="grid items-center gap-x-12 gap-y-9 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:pt-8">
        <div>
          <h1 className="max-w-[18ch] text-[38px] leading-[1.04] sm:text-[52px]">Borrow against cbBTC or WETH on Base and put the USDC to work</h1>
          <p className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-oil-ink2">
            One transaction from your wallet: supply, borrow, deploy. The position sits in an account your wallet owns, and you choose one number — how far the price can fall before anything has to happen.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/new" className="btn-brass btn-lg">
              Open a position
            </Link>
            <Link href="/dashboard" className="btn-ghost btn-lg">
              {s.mode === "demo" ? "See the demo dashboard" : "Your dashboard"}
            </Link>
          </div>
          <p className="mt-6 max-w-[54ch] text-[13px] leading-relaxed text-oil-ink3">
            Holding ZEC rather than cbBTC or WETH? <Link href="/onboard" className="font-semibold text-oil-ink2 underline decoration-oil-line underline-offset-4 hover:text-brass">Start from where your ZEC is</Link>.
          </p>
        </div>
        <HeroInstrument market={market} source={source} />
      </section>

      <section aria-labelledby="start-h">
        <h2 id="start-h" className="mb-4 text-[22px]">
          Start from what you hold
        </h2>
        <Spotlight className="overflow-hidden rounded-card border border-oil-line bg-oil-surface">
          {PATHS.map((p) => (
            <Link key={p.href} href={p.href} className="rowlink group">
              <div>
                <div className="text-[13px] text-oil-ink3">{p.who}</div>
                <h3 className="mt-0.5 text-[18px]">{p.title}</h3>
              </div>
              <p className="max-w-[68ch] text-[13.5px] leading-relaxed text-oil-ink2">{p.body}</p>
              <span className="whitespace-nowrap text-[13.5px] font-semibold text-brass underline-offset-4 group-hover:underline">{p.cta}</span>
            </Link>
          ))}
        </Spotlight>
      </section>

      <section className="card p-6" aria-labelledby="venue-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="venue-h" className="text-[18px]">
            What the venue says today
          </h2>
          <span className="text-[12px] text-oil-ink3">
            Aave v3 · {source === "live" ? "live read" : `snapshot ${market.readAt.slice(0, 10)}`}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(["cbBTC", "WETH", "cbZEC"] as const).map((sym) => {
            const asset = COLLATERAL_ASSETS[sym];
            const r = market.reserves[sym];
            // The slider's stop on this asset (BUILD-PLAN D7): the lowest entry HF offered and the cap that sets it.
            const bounds = r ? offeredLtvBounds(r.liquidationThresholdBps, Number.isFinite(r.ltvBps) ? r.ltvBps : 0, ENTRY_HF_FLOOR) : null;
            const top = bounds && bounds.maxLtvBps > 0 ? bounds : null;
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
                    <dt className="text-oil-ink3">Most you can borrow</dt>
                    <dd className="text-right">{fmtPct(top.maxLtvBps / 100, 0)} LTV</dd>
                    <dt className="text-oil-ink3">Lowest health factor</dt>
                    <dd className="text-right">
                      {top.minHf.toFixed(2)} <span className="text-oil-ink3">({top.binding === "entry_hf_floor" ? "registry floor" : "Aave's max LTV"})</span>
                    </dd>
                    <dt className="text-oil-ink3">Marks</dt>
                    <dd className="text-right">{HF_MARKS.map((m) => `${m.label} ${m.hf.toFixed(2)}`).join(", ")}</dd>
                  </dl>
                ) : (
                  <p className="mt-3 text-[12.5px] leading-relaxed text-oil-ink2">{asset.disabledReason}</p>
                )}
              </div>
            );
          })}
        </div>
        <p className="num mt-4 text-[13px] text-oil-ink2">
          USDC borrow rate now <b className="text-oil-ink">{fmtPct(market.usdcBorrowAprPct)}</b> variable. Performance fee {FEES.performanceBps / 100}% of realised yield, never on principal.
        </p>
      </section>

      <section aria-labelledby="honest-h" className="grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div>
          <h2 id="honest-h" className="text-[22px]">
            Honest by design
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-oil-ink2">Three things this site holds itself to. Each one is checkable on the page it describes.</p>
        </div>
        <dl className="divide-y divide-oil-line border-y border-oil-line">
          {COMMITMENTS.map((c) => (
            <div key={c.title} className="grid gap-x-8 gap-y-1 py-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
              <dt className="font-display text-[16px] font-semibold">{c.title}</dt>
              <dd className="max-w-[68ch] text-[13.5px] leading-relaxed text-oil-ink2">{c.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card p-6" aria-labelledby="modes-h">
        <h2 id="modes-h" className="mb-2 text-[18px]">
          Simple or Advanced, your choice, top right
        </h2>
        <div className="grid gap-x-10 gap-y-4 text-[13.5px] leading-relaxed text-oil-ink2 md:grid-cols-2">
          <p>
            <b className="text-oil-ink">Simple</b> is the guided path: connect, pick collateral, pick a setting, read the forecast for each pool at its best setting, sign. Every step is explained in one plain sentence, and every preventable mistake is caught before your wallet opens: wrong network, not enough ETH for the fee, more than you hold, a counterfeit token, a typed address.
          </p>
          <p>
            <b className="text-oil-ink">Advanced</b> is the full suite: every pool at every setting with both models&rsquo; numbers, custom band width and rebalance delay, price tolerance, spot swaps via CoW, claim, unwind and keeper controls, and raw position data.
          </p>
        </div>
      </section>
    </div>
  );
}
