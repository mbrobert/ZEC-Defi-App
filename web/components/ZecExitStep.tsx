/**
 * Door 1's destination step — the choice, once an unwind has finished and the USDC is in the user's
 * own account, to send it out as ZEC (ZEC = Zcash's native coin) instead of leaving it as USDC
 * (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3).
 *
 * SHIPPED DARK: with `NEXT_PUBLIC_ZEC_EXIT_ENABLED` unset this renders nothing at all — not a
 * disabled button, not a "coming soon". §6 of the plan is explicit that nothing is user-visible
 * before the flag flips, and a greyed-out control is user-visible.
 *
 * When the flag is on, what is drawn is the disclosure and the destination field, in that order —
 * the risk before the button, and the same `BridgeCustodyNote` Door 2 uses, with `direction="out"`.
 * The quote itself comes from the yield service, which refuses while Step Z1's facts file is
 * missing; this component prints that refusal verbatim rather than hiding it behind a spinner.
 */
"use client";

import { useState } from "react";
import { describeZecAddress, zecAddressShape } from "@zyo/shared";
import BridgeCustodyNote from "@/components/BridgeCustodyNote";
import Chip from "@/components/Chip";
import { zecExitClosedReason, zecExitOffered } from "@/lib/exit";

export default function ZecExitStep() {
  // Dark means absent. Read the flag before anything else and render nothing.
  if (!zecExitOffered()) return null;
  return <ZecExitStepOpen />;
}

function ZecExitStepOpen() {
  const [destination, setDestination] = useState("");
  const shape = zecAddressShape(destination);
  const closed = zecExitClosedReason();

  return (
    <section className="card p-5" data-testid="zec-exit">
      <h2 className="text-[16px]">Send it out as ZEC instead?</h2>
      <p className="mt-1 text-[13.5px] text-oil-ink2">
        Your USDC is in your own account. You can leave it there, or send it out as ZEC to a Zcash address you control. This happens after every
        contract call is finished — it is a choice about where money you have already withdrawn goes.
      </p>

      {/* The risk before the button, and the same block Door 2 shows on the way in. */}
      <div className="mt-4">
        <BridgeCustodyNote direction="out" />
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="zec-destination">
          Your Zcash address
        </label>
        <input
          id="zec-destination"
          className="input mono"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="the address you want the ZEC to arrive at"
          spellCheck={false}
          autoComplete="off"
        />
        {destination.trim().length > 0 && (
          <p className="mt-2 flex flex-wrap items-start gap-2 text-[12.5px] text-oil-ink2" data-testid="zec-destination-note" data-shape={shape}>
            <Chip kind={shape === "unrecognised" ? "warn" : "info"}>{shape === "unrecognised" ? "Not recognised" : shape}</Chip>
            <span>{describeZecAddress(destination)}</span>
          </p>
        )}
      </div>

      {closed && (
        <p className="note note-warn mt-4" data-testid="zec-exit-closed">
          {closed}
        </p>
      )}
    </section>
  );
}
