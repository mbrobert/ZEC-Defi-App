import Link from "next/link";

const steps = [
  {
    n: "01",
    title: "Deposit native ZEC",
    body: "Send ZEC from your own wallet to your personal deposit address. No wrapping, no manual bridging.",
  },
  {
    n: "02",
    title: "Earn on Rhea Finance",
    body: "Your ZEC is supplied as collateral on Rhea (NEAR). Simple mode stops here — supply APY, zero leverage.",
  },
  {
    n: "03",
    title: "Optional: run the full strategy",
    body: "Borrow USDC, cbBTC, or WETH against your ZEC and deploy it into curated MaxFi / SnuggleFi concentrated-liquidity positions on Base — with your exact range, rebalance, and compounding settings.",
  },
  {
    n: "04",
    title: "Rewards, your way",
    body: "Auto-compound into the position, or have rewards converted and delivered as native ZEC straight to your Zcash wallet via NEAR Intents.",
  },
];

export default function Home() {
  return (
    <div className="space-y-16">
      <section className="pt-8 text-center">
        <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-zec">
          Your ZEC. Working.
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight text-white md:text-5xl">
          Yield on native ZEC — from simple lending to full DeFi strategies
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-ink-muted">
          One deposit. Two modes. Start with hands-off lending on Rhea Finance, upgrade to a
          managed concentrated-liquidity strategy on Base whenever you are ready — and take
          profits in ZEC, back in your own wallet.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link href="/deposit" className="btn-primary">
            Start earning
          </Link>
          <Link href="/dashboard" className="btn-ghost">
            View dashboard
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {steps.map((s) => (
          <div key={s.n} className="card p-6">
            <div className="mb-2 text-sm font-bold text-zec">{s.n}</div>
            <h3 className="mb-2 font-semibold text-white">{s.title}</h3>
            <p className="text-sm leading-relaxed text-ink-muted">{s.body}</p>
          </div>
        ))}
      </section>

      <section className="card p-6">
        <h3 className="mb-3 font-semibold text-white">Honest by design</h3>
        <p className="text-sm leading-relaxed text-ink-muted">
          Borrowing against ZEC carries liquidation risk — the app shows your health factor at
          every step and the agent warns, deleverages, or unwinds according to thresholds you
          can see. Concentrated liquidity carries impermanent-loss risk — range presets are
          explained in plain language before you commit. Principal never routes through the
          reward path, and your withdrawal right is never pausable.
        </p>
      </section>
    </div>
  );
}
