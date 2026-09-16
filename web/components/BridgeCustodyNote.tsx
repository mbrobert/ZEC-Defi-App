/**
 * The ONE bridge-custody disclosure, used by both doors.
 *
 * `docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.2 item 2 and §4 item 2 are explicit that Door 1 (the
 * exit) and Door 2 (the entry) share one copy block rather than keeping two that can drift. This is
 * that block; `direction` is the only thing that differs between them.
 *
 * It describes the mechanism and stops. Naming Zcash's shielded Orchard pool is a fact about where
 * the coin was, and `lib/copy.ts` TERMS_OF_ART allows that name for exactly that reason — the ban is
 * on a product claiming a quality, not on saying what an external thing is called. Describing the
 * trip itself with that adjective would be the claim, and is still refused.
 *
 * It also never states how long the gap lasts or what it costs. Nothing about this bridge has been
 * read into a `docs/VERIFIED-*-FACTS.md` file yet — that is Step Z1 (§3.3) — so the route's own
 * `unverified` list is rendered beside this note rather than a number nobody measured.
 */
import Chip from "@/components/Chip";

export default function BridgeCustodyNote({ direction }: { direction: "in" | "out" }) {
  return (
    <div className="note note-warn" data-testid="bridge-custody" data-direction={direction}>
      <div className="mb-1">
        <Chip kind="warn">Someone else holds it in between</Chip>
      </div>
      <p className="text-[13.5px] leading-relaxed">
        {direction === "in"
          ? "Your ZEC leaves Zcash's shielded Orchard pool and sits at a transparent Zcash address that the bridge's signers control. Only once it is sitting there does the matching token appear in your wallet on the other chain."
          : "Your ZEC arrives at a transparent Zcash address on Zcash. Moving it back into the shielded pool is a step you take yourself, afterwards, and nothing in Oilskin does it for you."}
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed">
        For that stretch, a group of bridge signers is holding the coin — not you, and not Oilskin. If that group failed or refused, the ZEC in
        flight would be at risk, and there is nothing on either chain that could get it back for you. How many signers there are, who they are, and
        how many of them it takes to move the coin has not been read; it is listed below with everything else about this route that is unmeasured.
      </p>
      <p className="mt-2 text-[12.5px] text-oil-ink3">
        Oilskin does not build or sign any part of this transfer, and never receives the funds. You send from your own wallet, to an address you
        check in full first.
      </p>
    </div>
  );
}
