"use client";

import Link from "next/link";
import { useState } from "react";
import { ZEC_FORMS, ZEC_ORIGINS, originReachesLendingVenue, zecRoutesFrom, type ZecOrigin } from "@zyo/shared";
import { BASE_TOKENS } from "@/lib/chain";
import { CBZEC_V1_CAPABILITIES, COUNTRY_OPTIONS, EXCLUDED_REGIONS, ONBOARD_STEPS, US_STATES, cbZecEligibility } from "@/lib/onboarding";
import CbzecAddressCard from "@/components/CbzecAddressCard";
import WalletAddressCard from "@/components/WalletAddressCard";
import Chip from "@/components/Chip";
import Disclosures from "@/components/Disclosures";
import { TokenMark } from "@/components/TokenMark";
import ZecRouteCard from "@/components/ZecRouteCard";

/**
 * Door 2 (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §4). One question, asked before anything else,
 * because the answer changes every screen after it — and because the route that actually ends in a
 * loan today has never been mentioned on this website. The labels are the user's words for where
 * their coin is, not ours for what it becomes.
 */
const ORIGIN_LABELS: Record<ZecOrigin, { label: string; hint: string }> = {
  "zcash-address": { label: "In my own Zcash wallet", hint: "a zs… , unified or transparent address" },
  exchange: { label: "On an exchange", hint: "Coinbase, or anywhere else you can withdraw from" },
  solana: { label: "Already on Solana", hint: "as a token in a Solana wallet" },
  base: { label: "Already on Base", hint: "as cbZEC in an Ethereum-style wallet" },
};

export default function OnboardPage() {
  const [country, setCountry] = useState("");
  const [usState, setUsState] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [origin, setOrigin] = useState<ZecOrigin | null>(null);
  // The Coinbase door answers "on an exchange" and gives the Base holder their token check. A user
  // who told us their ZEC is on Solana or in a Zcash wallet is not walking through it, and a
  // jurisdiction form for a door they are not using is noise in front of the one they are.
  const showCoinbaseDoor = origin === null || origin === "exchange" || origin === "base";
  const elig = country ? cbZecEligibility(country, country === "US" ? usState || undefined : undefined) : null;
  const canProceed = elig?.status === "eligible" || (elig?.status === "unverified" && acknowledged);

  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header>
        <h1 className="text-[26px]">Where is your ZEC?</h1>
        <p className="mt-2 text-[14.5px] text-oil-ink2">
          Oilskin works with every form of ZEC it can reach — cbZEC on Base, bridged ZEC on Solana, whatever comes next. They are not the same thing
          and they do not lead to the same places, so the honest first question is where your coin is right now. Below is every route from there, what
          each one costs you in trust, and which of them end in a loan today. One of them does not, and it says so.
        </p>
      </header>

      <section className="card p-5" data-testid="zec-origin">
        <h2 className="text-[16px]">1 &middot; Pick where it is</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {ZEC_ORIGINS.map((o) => {
            const on = origin === o;
            return (
              <button
                key={o}
                type="button"
                className={`opt text-left ${on ? "sel" : ""}`}
                aria-pressed={on}
                data-origin={o}
                onClick={() => setOrigin(on ? null : o)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{ORIGIN_LABELS[o].label}</span>
                  {originReachesLendingVenue(o) ? <Chip kind="good">Can end in a loan</Chip> : <Chip kind="mute">No loan from here</Chip>}
                </div>
                <div className="mt-0.5 text-[12px] text-oil-ink3">{ORIGIN_LABELS[o].hint}</div>
              </button>
            );
          })}
        </div>
        {origin === null && (
          <p className="mt-3 text-[12.5px] text-oil-ink3">
            Pick one and the routes from it appear, in full. Nothing is hidden behind the choice — the Coinbase door is written out below either way.
          </p>
        )}
      </section>

      {origin !== null && (
        <section className="space-y-3" data-testid="zec-routes" data-origin={origin}>
          <h2 className="text-[16px]">2 &middot; {originReachesLendingVenue(origin) ? "From here you can borrow" : "From here you cannot borrow — but here is what you can do"}</h2>
          {zecRoutesFrom(origin).map((r) => (
            <ZecRouteCard key={r.id} route={r} />
          ))}
        </section>
      )}

      {/* The Coinbase door, in detail. Shown by default and for the two origins it answers; the
          user who is already on Solana does not need a jurisdiction check for a door they are not
          using. */}
      {showCoinbaseDoor && (
      <>
      <section id="coinbase-door">
        <h2 className="text-[18px]">The Coinbase door, in detail</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          cbZEC is Coinbase Wrapped ZEC: 1:1 backed by ZEC in Coinbase custody, Base only. There is exactly one door into it and it is
          Coinbase&rsquo;s — so we check the door before anything else.
        </p>
      </section>

      {/* Jurisdiction check — up front */}
      <section className="card p-5" data-testid="jurisdiction">
        <h2 className="text-[16px]">Where are you?</h2>
        <p className="mt-1 text-[13px] text-oil-ink2">Coinbase excludes cbZEC wrap/unwrap in 100+ jurisdictions. Only the US outside New York is confirmed.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="country">
              Country / region
            </label>
            <select id="country" className="input" value={country} onChange={(e) => { setCountry(e.target.value); setUsState(""); setAcknowledged(false); }}>
              <option value="">Choose…</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {country === "US" && (
            <div>
              <label className="label" htmlFor="state">
                State
              </label>
              <select id="state" className="input" value={usState} onChange={(e) => setUsState(e.target.value)}>
                <option value="">Choose…</option>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {elig && (
          <div className={`note mt-4 ${elig.status === "eligible" ? "" : elig.status === "excluded" ? "note-crit" : "note-warn"}`} data-testid="eligibility" data-status={elig.status}>
            <div className="mb-1">
              {elig.status === "eligible" && <Chip kind="good">Eligible</Chip>}
              {elig.status === "excluded" && <Chip kind="crit">Excluded</Chip>}
              {elig.status === "unverified" && <Chip kind="warn">Unverified</Chip>}
              {elig.status === "unknown" && <Chip kind="mute">Unknown</Chip>}
            </div>
            {elig.reason}
            {elig.status === "unverified" && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-oil-ink">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="accent-brass" />I checked in the Coinbase app and cbZEC on Base is offered to me.
              </label>
            )}
            {(elig.status === "excluded" || elig.status === "unknown") && (
              <p className="mt-2 text-oil-ink">
                You can still <Link href="/spot" className="text-brass">buy cbZEC on Base via spot</Link> (from existing supply, limited by pool depth) and use cbBTC or WETH as collateral — those paths do not go through Coinbase.
              </p>
            )}
          </div>
        )}
        <details className="mt-3 text-[12.5px] text-oil-ink3">
          <summary className="cursor-pointer">Published exclusion list</summary>
          <ul className="mt-1.5 list-disc pl-5">
            {EXCLUDED_REGIONS.map((r) => (
              <li key={r.code}>{r.label}</li>
            ))}
            <li>…and more: Coinbase has not published the full list (the UK is unverified).</li>
          </ul>
        </details>
      </section>

      {/* The three steps */}
      <section className={`space-y-3 ${canProceed ? "" : "opacity-60"}`} aria-disabled={!canProceed} data-testid="steps">
        <h2 className="text-[16px]">The three steps</h2>
        {!canProceed && <p className="text-[13px] text-oil-ink3">Shown for reference — complete the check above before sending anything.</p>}
        {ONBOARD_STEPS.map((s) => (
          <div key={s.n} className="card flex gap-4 p-5">
            <div className="grid h-8 w-8 flex-none place-items-center rounded-full bg-brass font-bold text-brass-on">{s.n}</div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px]">{s.title}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-oil-ink2">{s.body}</p>
              {s.n === 2 && <WalletAddressCard />}
              <ul className="mt-2 space-y-1 text-[12.5px] text-oil-ink3">
                {s.facts.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden>—</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-[16px]">Check the token before you touch it</h2>
        <CbzecAddressCard />
      </section>

      <section className="card p-5">
        <h2 className="text-[16px]">What you can do with cbZEC in v1</h2>
        <ul className="mt-3 space-y-2 text-[13.5px]">
          {(
            [
              ["Spot", CBZEC_V1_CAPABILITIES.spot],
              ["LP farming", CBZEC_V1_CAPABILITIES.lp],
              ["Collateral", CBZEC_V1_CAPABILITIES.collateral],
            ] as const
          ).map(([label, cap]) => (
            <li key={label} className="flex flex-wrap items-start gap-2">
              {cap.available ? <Chip kind="good">{label}</Chip> : <Chip kind="mute">{label}</Chip>}
              <span className="text-oil-ink2">{cap.note}</span>
            </li>
          ))}
        </ul>
        {/* The Collateral row above already prints the registry's reason verbatim — it is read from
            the ZEC form registry, not written in this page. What is worth adding is where the reason
            comes from, so a reader can check it rather than take our word for it. */}
        <p className="mt-3 text-[12.5px] text-oil-ink3">
          Collateral status is the registry entry for {ZEC_FORMS["cbzec-base"].label}, not a plan: it changes when a Base lending market lists the token, which is not something Oilskin does for it.
        </p>
      </section>
      </>
      )}

      {/* Already on Base */}
      <section className="card p-5" data-testid="already-on-base">
        <h2 className="text-[16px]">Already on Base?</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">If your wallet already holds any of these on Base, skip Coinbase entirely.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {(["cbBTC", "WETH", "cbZEC"] as const).map((sym) => (
            <Link key={sym} href={sym === "cbZEC" ? "/spot" : `/new?collateral=${sym}`} className="opt flex items-center gap-2.5">
              <TokenMark symbol={sym} size={26} />
              <div>
                <div className="font-semibold">{sym}</div>
                {/* Not "collateral in v1.1" — that promise was reversed by decision D3 of
                    2026-09-12 and this line outlived it by three days. The registry answers. */}
                <div className="text-[12px] text-oil-ink3">{sym === "cbZEC" ? (CBZEC_V1_CAPABILITIES.collateral.available ? "spot now · collateral on Base" : "spot now · not collateral on Base") : "collateral on Aave v3"}</div>
              </div>
            </Link>
          ))}
        </div>
        <p className="mono mt-3 text-oil-ink3">
          cbBTC {BASE_TOKENS.cbBTC.address} · WETH {BASE_TOKENS.WETH.address}
        </p>
      </section>

      <Disclosures scope="onboard" open />
    </div>
  );
}
