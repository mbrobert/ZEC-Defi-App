/**
 * The routes a ZEC holder's coin can take to reach a form Oilskin can work with — Door 2, the entry
 * (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §4).
 *
 * The door is not the room. Everything here happens BEFORE any Oilskin contract is involved: the
 * user moves their own coin, signs in their own wallet, and arrives holding one of the forms in
 * `zecForms.ts`. Oilskin never builds, signs or broadcasts a transaction for any leg described here
 * (`CLAUDE.md` rule 1), and never holds the funds.
 *
 * Abbreviations on first use: ZEC = Zcash's native coin; SPL = Solana Program Library (its token
 * standard); MPC = multi-party computation; TSS = threshold signature scheme; USDC = the borrow
 * asset; HF = health factor; PDA = program-derived address.
 *
 * WHAT THIS FILE MAY AND MAY NOT SAY
 *
 * It may describe a mechanism, because a mechanism is checkable. It may NOT state a fee, a delay, a
 * minimum, or how long anything takes: `docs/VERIFIED-SOLANA-FACTS.md` leaves the whole off-Solana
 * side of the bridge unread, and `ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.3 (Step Z1) is the pass that
 * will measure it. Under `CLAUDE.md` rule 3 a number that has not been read does not get typed, not
 * even as "about". So every route carries `unverified` — the questions it cannot answer yet — and
 * every surface renders that list rather than hiding it. When Step Z1 lands and
 * `docs/VERIFIED-ZEC-ROUTES-<date>.md` exists, those entries move from `unverified` into measured
 * fields with a `verifiedIn` pointer, the same way `zecForms.ts` works.
 *
 * It also may not soften what is and is not deployed. Oilskin has deployed nothing on any chain
 * (`docs/DEPLOYMENTS.md`, `docs/STATUS.md`). A route that ends at a lending venue ends there: the
 * venue is live, the program that would run the ladder against it is not.
 */
import { ZEC_FORMS, type ZecForm, type ZecFormId } from "./zecForms.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where the user's ZEC is right now — the one question Door 2 asks
 * (`ZEC-FORMS-AND-DOORS-2026-09-15.md` §2.5, §4 item 1).
 */
export type ZecOrigin =
  /** In a Zcash wallet the user controls, at a `zs…`/unified or transparent address. */
  | "zcash-address"
  /** Already an SPL token in a Solana wallet. */
  | "solana"
  /** Already a token on Base. */
  | "base"
  /** On a centralised exchange account. */
  | "exchange";

export const ZEC_ORIGINS: readonly ZecOrigin[] = ["zcash-address", "exchange", "solana", "base"];

/** How a route ends, which is the only thing most users are actually asking about. */
export type ZecRouteOutcome =
  /** A lending venue accepts the resulting form, so the route can end in a USDC loan. */
  | "reaches-a-lending-venue"
  /** The form arrives fine, but no venue lends against it — the route stops there, and says why. */
  | "no-lending-venue"
  /**
   * The route does not end anywhere itself — it puts the user at the start of another route, whose
   * outcome is that route's to state. Claiming the next leg's result here would claim it without
   * the next leg's unknowns, and on this table the next leg is the one carrying all of them.
   */
  | "hands-off";

export interface ZecRoute {
  id: string;
  from: ZecOrigin;
  /** The form the user is holding when the route ends, or null when it hands off to another. */
  to: ZecFormId | null;
  /** One line, the answer before the detail. */
  headline: string;
  /** What actually happens, in order, in the words a first-time user needs. */
  steps: readonly string[];
  /**
   * True when some group of signers holds the user's coin part-way through. Drives the one shared
   * bridge disclosure both doors use — §3.2 item 2 is explicit that there must be ONE copy block,
   * not two that can drift.
   */
  custodyGap: boolean;
  outcome: ZecRouteOutcome;
  /**
   * Why the route stops, when it does not reach a venue. Read from the form's own `disabledReason`
   * so there is never a second copy of it (`zecForms.ts` rule 4). Null when the route does reach one.
   */
  stopsBecause: string | null;
  /** Questions this route cannot answer yet. Rendered, never hidden. Step Z1's checklist. */
  unverified: readonly string[];
}

// ---------------------------------------------------------------------------
// What Step Z1 has not measured
// ---------------------------------------------------------------------------

/**
 * The bridge questions no read in this repository has answered. `ZEC-FORMS-AND-DOORS-2026-09-15.md`
 * §3.3 lists them as the contents of `docs/VERIFIED-ZEC-ROUTES-<date>.md`; until that file exists
 * this array IS the honest answer, and a surface shows it beside the route rather than beside a
 * plausible-looking estimate.
 */
export const BRIDGE_UNVERIFIED: readonly string[] = [
  "What the bridge charges, and how far a quote can move between seeing it and signing it — not read, in either direction.",
  "How long a transfer takes, and whether the wait is bounded at all.",
  "The smallest and largest amount the route will take.",
  "Whether any step asks who you are. Nobody here has tried it, so the answer is unknown rather than no.",
  "What happens to a transfer nobody fills, and after how long you get the coin back — if you do.",
];

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function form(id: ZecFormId): ZecForm {
  return ZEC_FORMS[id];
}

/**
 * The route that actually ends in a loan today, and the only one that does. It is also the route the
 * website has never mentioned, which is what `ZEC-FORMS-AND-DOORS-2026-09-15.md` §4 calls "the
 * cheapest real win in this document": the path already worked, and onboarding was written for
 * someone who already held a token on Base.
 */
const ZCASH_TO_SOLANA: ZecRoute = {
  id: "zcash-to-solana",
  from: "zcash-address",
  to: "zec-solana-bridged",
  headline: "Bridge it into Solana, where a lending market takes ZEC as collateral.",
  steps: [
    "You ask the bridge for a deposit address and send ZEC to it from your own Zcash wallet. Oilskin does not build or sign that transfer, and never holds the coin — check the address in full before you send, because a Zcash transfer cannot be undone.",
    "Your ZEC leaves Zcash's shielded Orchard pool and sits at a transparent Zcash address that the bridge's signers control. This is the part of the trip where somebody else is holding it.",
    "The bridge mints the matching amount as a token on Solana, to your Solana wallet. That token is the collateral — the ZEC itself stays where the signers put it.",
    "From there, Kamino's ZCASH market lends USDC against it. Oilskin's Solana program — the one that would run the health ladder on a position your own wallet owns — is built and proven against a local validator, and is not deployed on Solana. Until it is, this route ends at the market, not at a running position.",
  ],
  custodyGap: true,
  outcome: "reaches-a-lending-venue",
  stopsBecause: null,
  unverified: [...BRIDGE_UNVERIFIED, ...form("zec-solana-bridged").openQuestions],
};

const ALREADY_ON_SOLANA: ZecRoute = {
  id: "already-on-solana",
  from: "solana",
  to: "zec-solana-bridged",
  headline: "Nothing to move. Check the mint, then borrow against it.",
  steps: [
    "Confirm the token in your wallet is the pinned mint below and not a look-alike. Anyone can create a token and call it ZEC; only this one is the collateral Kamino accepts.",
    "Kamino's ZCASH market lends USDC against it. Oilskin's Solana program — the one that would run the health ladder on a position your own wallet owns — is built and proven against a local validator, and is not deployed on Solana. Until it is, this route ends at the market, not at a running position.",
  ],
  custodyGap: false,
  outcome: "reaches-a-lending-venue",
  stopsBecause: null,
  // The coin is already here, so the bridge's own unknowns are behind the user — but who controls
  // the mint, and who holds the ZEC backing it, are still unread and still their exposure.
  unverified: form("zec-solana-bridged").openQuestions,
};

const CBZEC_ON_BASE: ZecRoute = {
  id: "cbzec-on-base",
  from: "base",
  to: "cbzec-base",
  headline: "cbZEC is registered here, but no Base market lends against it.",
  steps: [
    "Confirm the token is the pinned cbZEC address and not one of the look-alikes that share its 0xb2000 prefix.",
    "You can swap it for USDC on Base. You cannot borrow against it here, for the reason below.",
  ],
  custodyGap: false,
  outcome: "no-lending-venue",
  stopsBecause: form("cbzec-base").disabledReason ?? null,
  unverified: form("cbzec-base").openQuestions,
};

const EXCHANGE_TO_CBZEC: ZecRoute = {
  id: "exchange-to-cbzec",
  from: "exchange",
  to: "cbzec-base",
  headline: "Coinbase can send it to Base as cbZEC — which does not end in a loan.",
  steps: [
    "Deposit ZEC into a Coinbase account, which requires identity verification and is not offered in over a hundred jurisdictions.",
    'In the Coinbase app, "Send ZEC on Base" to a wallet address you control. You receive cbZEC.',
    "From there it is the Base route: swappable, not borrowable, for the reason below.",
  ],
  custodyGap: false,
  outcome: "no-lending-venue",
  stopsBecause: form("cbzec-base").disabledReason ?? null,
  unverified: form("cbzec-base").openQuestions,
};

const EXCHANGE_TO_ZCASH: ZecRoute = {
  id: "exchange-to-zcash",
  from: "exchange",
  to: null,
  headline: "Or withdraw ZEC to your own Zcash wallet, and take the Solana route from there.",
  steps: [
    "Withdraw ZEC from the exchange to a Zcash address you control. Most exchanges send to transparent addresses only.",
    'From there this is the "in my own Zcash wallet" route, which is the one that reaches a lending market.',
  ],
  custodyGap: false,
  outcome: "hands-off",
  stopsBecause: null,
  unverified: [],
};

export const ZEC_ROUTES: readonly ZecRoute[] = [ZCASH_TO_SOLANA, ALREADY_ON_SOLANA, CBZEC_ON_BASE, EXCHANGE_TO_CBZEC, EXCHANGE_TO_ZCASH];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function isZecOrigin(value: unknown): value is ZecOrigin {
  return typeof value === "string" && (ZEC_ORIGINS as readonly string[]).includes(value);
}

/**
 * Every route from one origin, in the order to show them. Origins with more than one route list the
 * one that reaches a lending venue first — an ordering, not a recommendation: both are shown in
 * full, with what each costs the user in custody and in unknowns.
 */
export function zecRoutesFrom(origin: ZecOrigin): ZecRoute[] {
  return ZEC_ROUTES.filter((r) => r.from === origin);
}

export function zecRouteById(id: unknown): ZecRoute | undefined {
  return typeof id === "string" ? ZEC_ROUTES.find((r) => r.id === id) : undefined;
}

/** The form a route delivers, or undefined when it hands off to another route. */
export function zecRouteForm(route: ZecRoute): ZecForm | undefined {
  return route.to === null ? undefined : ZEC_FORMS[route.to];
}

/**
 * Does any route from this origin end at a lending venue? Drives the one-line answer the "where is
 * your ZEC?" step gives before any detail, so a user learns in one screen whether their starting
 * position can end in a loan at all.
 */
export function originReachesLendingVenue(origin: ZecOrigin): boolean {
  return zecRoutesFrom(origin).some((r) => r.outcome === "reaches-a-lending-venue");
}

/**
 * Structural faults in the route table, as sentences (empty = well-formed). Same contract as
 * `zecFormRegistryFaults()` and `zecFormRowFaults()`: returned, not thrown, so a surface reports a
 * fault instead of white-screening on it. `test/zecRoutes.test.ts` asserts it is empty.
 */
export function zecRouteFaults(): string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  for (const r of ZEC_ROUTES) {
    if (seen.has(r.id)) faults.push(`${r.id}: duplicate route id`);
    seen.add(r.id);
    if (r.steps.length === 0) faults.push(`${r.id}: no steps`);
    if (!r.headline.trim()) faults.push(`${r.id}: no headline`);
    const target = zecRouteForm(r);
    if (r.to !== null && target === undefined) faults.push(`${r.id}: unknown form "${String(r.to)}"`);
    // The rule that matters: a route may only claim it reaches a venue when the form it delivers
    // actually has one. `enabled` is set from a dated read of that venue, so this ties the claim
    // shown to a user back to something that was read on a chain.
    if (r.outcome === "hands-off" && r.to !== null) faults.push(`${r.id}: hands off yet names a delivered form`);
    if (r.outcome === "reaches-a-lending-venue") {
      if (target === undefined) faults.push(`${r.id}: claims a lending venue but delivers no form`);
      else if (!target.enabled || target.collateralVenue === null) {
        faults.push(`${r.id}: claims a lending venue but ${target.id} has none`);
      }
      if (r.stopsBecause !== null) faults.push(`${r.id}: reaches a venue yet carries a stopsBecause`);
    }
    if (r.outcome === "no-lending-venue") {
      if (target === undefined) faults.push(`${r.id}: stops for lack of a venue but delivers no form`);
      else if (target.enabled) faults.push(`${r.id}: says no venue but ${target.id} is enabled`);
      if (!(r.stopsBecause ?? "").trim()) faults.push(`${r.id}: stops with no reason given`);
      if (target !== undefined && r.stopsBecause !== target.disabledReason) {
        faults.push(`${r.id}: stopsBecause is not ${target.id}'s own disabledReason`);
      }
    }
    // A route that hands the user to a signer set and does not say so would be the one real
    // disclosure failure available here, so it is checked rather than trusted.
    if (r.custodyGap && !r.unverified.some((u) => /bridge|signer/i.test(u))) {
      faults.push(`${r.id}: has a custody gap but names no unread bridge question`);
    }
  }
  for (const origin of ZEC_ORIGINS) {
    if (zecRoutesFrom(origin).length === 0) faults.push(`${origin}: no route at all — the question would have no answer`);
  }
  return faults;
}
