/**
 * One route from "where is your ZEC?" to a form Oilskin can work with — Door 2's card
 * (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §4).
 *
 * Everything on it comes from `@zyo/shared`'s route table and form registry: the steps, the reason a
 * route stops, and the list of what has not been measured. Nothing is written here, so this card
 * cannot drift from the registry the keeper and the yield service read.
 *
 * The order on screen is deliberate and is the product rule from `CLAUDE.md`: the risk before the
 * button. The custody note and the unmeasured list sit above the link out, not behind a disclosure
 * triangle under it.
 */
import Link from "next/link";
import { zecRouteForm, type ZecRoute } from "@zyo/shared";
import Chip from "@/components/Chip";
import BridgeCustodyNote from "@/components/BridgeCustodyNote";

export default function ZecRouteCard({ route }: { route: ZecRoute }) {
  const form = zecRouteForm(route);
  const reaches = route.outcome === "reaches-a-lending-venue";

  return (
    <article className="card p-5" data-testid="zec-route" data-route={route.id} data-outcome={route.outcome}>
      <div className="flex flex-wrap items-center gap-2">
        {reaches ? (
          <Chip kind="good">Ends in a loan</Chip>
        ) : route.outcome === "no-lending-venue" ? (
          <Chip kind="mute">No loan at the end</Chip>
        ) : (
          <Chip kind="info">Puts you on another route</Chip>
        )}
        {route.custodyGap && <Chip kind="warn">Custody gap</Chip>}
        {form && <span className="text-[12.5px] text-oil-ink3">you end up holding {form.label}</span>}
      </div>

      <h3 className="mt-2 text-[15px]">{route.headline}</h3>

      <ol className="mt-3 space-y-2 text-[13.5px] leading-relaxed text-oil-ink2">
        {route.steps.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span aria-hidden className="grid h-5 w-5 flex-none place-items-center rounded-full border border-oil-line text-[11px] font-semibold">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>

      {route.custodyGap && (
        <div className="mt-4">
          <BridgeCustodyNote direction="in" />
        </div>
      )}

      {route.stopsBecause && (
        <div className="note note-warn mt-4" data-testid="route-stops">
          <div className="mb-1">
            <Chip kind="mute">Why it stops here</Chip>
          </div>
          {/* The registry's own sentence, verbatim. Never softened, never paraphrased on screen. */}
          <p className="text-[13.5px] leading-relaxed">{route.stopsBecause}</p>
        </div>
      )}

      {route.unverified.length > 0 && (
        <div className="mt-4" data-testid="route-unverified">
          <h4 className="text-[13px] font-semibold">What nobody here has measured yet</h4>
          <p className="mt-1 text-[12.5px] text-oil-ink3">
            Not a disclaimer — a list of the questions this route cannot answer. Anything Oilskin has actually read is written down with the date it
            was read; these are the ones that are not.
          </p>
          <ul className="mt-2 space-y-1.5 text-[12.5px] text-oil-ink2">
            {route.unverified.map((u) => (
              <li key={u} className="flex gap-2">
                <span aria-hidden>—</span>
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {form && (
        <p className="mono mt-4 text-[11.5px] text-oil-ink3">
          {form.chain === "solana" ? "mint" : "address"} {form.assetRef}
        </p>
      )}

      {route.id === "exchange-to-cbzec" && (
        <p className="mt-3 text-[13px]">
          <Link href="#coinbase-door" className="text-brass">
            The Coinbase door, step by step ↓
          </Link>
        </p>
      )}
    </article>
  );
}
