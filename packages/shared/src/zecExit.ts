/**
 * Door 1 — the exit (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3). SHIPPED DARK.
 *
 * What it will be: after a position is unwound and the user is holding USDC in their own account,
 * they may choose to send it out as ZEC (ZEC = Zcash's native coin) to a Zcash address they control,
 * rather than leaving it as USDC. The route is NEAR Intents — USDC in, an intent, a solver fills it,
 * native ZEC out.
 *
 * WHY IT IS DARK, AND WHAT DARK MEANS HERE
 *
 * §3.3 is blunt about it: nothing about NEAR Intents is in a `docs/VERIFIED-*-FACTS.md` file. Not
 * the endpoints, not their request or response shapes, not a fee, not the signer set, not the
 * withdrawal delay, not the minimum, not what happens to an intent nobody fills.
 * `docs/VERIFIED-SOLANA-FACTS.md`'s "Not verified by this read" item 5 leaves that whole leg
 * unmeasured, and Step Z1 is the pass that measures it.
 *
 * So this module is the SHAPE of the feature and nothing else. It holds no endpoint, no rate, no
 * fee and no timing. `zecExitReadiness()` reports why it cannot run, and every caller — the yield
 * service's route, the web's exit library, the UI — asks it first and refuses. There is no code path
 * here that reaches the network, and `zecExit.test.ts` proves the module contains no URL at all.
 * Under `CLAUDE.md` rule 3 there is no other honest order: read it, write the facts row, then build.
 *
 * `NEXT_PUBLIC_ZEC_EXIT_ENABLED` is the second lock, in the web app. Both have to open: the flag is
 * the founder's switch, and the facts file is the precondition the flag cannot override
 * (`zecExitReadiness()` returns `"facts-missing"` regardless of any flag).
 *
 * WHAT IS TRUE OF DOOR 1 WHATEVER STEP Z1 FINDS
 *
 * - Oilskin never holds the funds and never signs (`CLAUDE.md` rule 1). The app builds a transfer
 *   the user signs in their own wallet. If the route needs a deposit address, it is fetched live and
 *   shown in full — never abbreviated, never auto-submitted.
 * - It happens AFTER every contract call is finished. It is a destination choice on money the user
 *   has already withdrawn, which is what makes it a door and not part of the room, and why it adds
 *   nothing to the audited surface (§3.1: zero Solidity, zero Anchor).
 * - The transparent hop is disclosed before the button, by mechanism. The web's
 *   `BridgeCustodyNote` with `direction="out"` is that disclosure, and it is the same component
 *   Door 2 uses — §3.2 item 2 requires one copy block, not two that can drift.
 */

// ---------------------------------------------------------------------------
// Readiness — the thing every caller asks first
// ---------------------------------------------------------------------------

/**
 * The facts file Step Z1 must produce before any of this may run. Named, not globbed, so that
 * "Door 1 is ready" is a statement about a document somebody wrote and dated, and so the name is
 * greppable from both the service and the web.
 */
export const ZEC_EXIT_FACTS_DOC = "docs/VERIFIED-ZEC-ROUTES";

export type ZecExitBlocker =
  /** No `docs/VERIFIED-ZEC-ROUTES-<date>.md` exists, so nothing about the route has been read. */
  | "facts-missing"
  /** The facts exist but the operator has not switched the feature on. */
  | "flag-off";

export interface ZecExitReadiness {
  ready: boolean;
  blockedBy: ZecExitBlocker | null;
  /** Shown to the user verbatim when the feature is refused. Never softened, never blank. */
  reason: string;
}

/**
 * Whether Door 1 may run, and if not, why — in that order of precedence: a missing facts file beats
 * an enabled flag every time, because a flag is a decision and the facts file is a prerequisite.
 *
 * `factsPresent` is passed in rather than read here: this module runs in a browser, in the yield
 * service and in tests, and only one of those has a filesystem. The service checks the repository;
 * the web is told by its build.
 */
export function zecExitReadiness(input: { factsPresent: boolean; flagEnabled: boolean }): ZecExitReadiness {
  if (!input.factsPresent) {
    return {
      ready: false,
      blockedBy: "facts-missing",
      reason: `Sending your USDC out as ZEC is not available. Nothing about that route has been checked yet — not what it costs, not how long it takes, not who holds your coin along the way — and Oilskin does not offer a route it has not read. The check is written down as Step Z1; when it is done it lands in ${ZEC_EXIT_FACTS_DOC}-<date>.md and this turns on.`,
    };
  }
  if (!input.flagEnabled) {
    return {
      ready: false,
      blockedBy: "flag-off",
      reason: "Sending your USDC out as ZEC is built but switched off in this deployment.",
    };
  }
  return { ready: true, blockedBy: null, reason: "" };
}

// ---------------------------------------------------------------------------
// Destination addresses
// ---------------------------------------------------------------------------

/**
 * What a Zcash address looks like it is. NOT validation, and the name says so.
 *
 * This reads a prefix and a character set. It does NOT check a checksum, a bech32 human-readable
 * part, or a network byte, because doing that correctly means reading ZIP 316 and the Zcash source
 * and writing the result into a facts file first — which is Step Z1's job, and is listed in
 * `ZEC_EXIT_OPEN_QUESTIONS` below. Until then, the prefixes here are marked unverified and no
 * surface may tell a user their address is valid. The strongest honest sentence is "this looks like
 * a unified address; check it in your own wallet, because we have not verified it".
 *
 * That gap is survivable only because of rule 1: Oilskin never builds or signs the transfer. The
 * user's own wallet does, and a wallet does check the checksum.
 */
export type ZecAddressShape = "transparent" | "sapling" | "unified" | "unrecognised";

/**
 * Prefix → shape. **UNVERIFIED.** Taken from common usage, not from a ZIP read into a facts file,
 * which is exactly the thing `CLAUDE.md` rule 3 forbids relying on — hence `zecAddressShape`
 * refusing to call itself validation, the feature shipping dark, and the entry in
 * `ZEC_EXIT_OPEN_QUESTIONS`. Step Z1 replaces this table with a read one or deletes it.
 */
const UNVERIFIED_PREFIXES: readonly { prefix: string; shape: ZecAddressShape }[] = [
  { prefix: "t1", shape: "transparent" },
  { prefix: "t3", shape: "transparent" },
  { prefix: "zs", shape: "sapling" },
  { prefix: "u1", shape: "unified" },
];

/** Longest first, so "t1" cannot shadow a longer prefix added later. */
const PREFIXES_BY_LENGTH = [...UNVERIFIED_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * A guess at what the user pasted, for the sole purpose of telling them what it looks like. Returns
 * "unrecognised" for anything this cannot place, including addresses that may be perfectly valid.
 */
export function zecAddressShape(candidate: unknown): ZecAddressShape {
  if (typeof candidate !== "string") return "unrecognised";
  const v = candidate.trim();
  // Conservative on both ends: no whitespace, no punctuation, a plausible length band, and only the
  // characters Zcash's two encodings draw from between them. Being too strict here costs a user a
  // second look; being too loose would let the UI nod at something it cannot read.
  if (!/^[0-9A-Za-z]{20,120}$/.test(v)) return "unrecognised";
  const hit = PREFIXES_BY_LENGTH.find((p) => v.startsWith(p.prefix));
  return hit ? hit.shape : "unrecognised";
}

/** The sentence a surface shows about a pasted address. Never says "valid". */
export function describeZecAddress(candidate: unknown): string {
  switch (zecAddressShape(candidate)) {
    case "transparent":
      return "This looks like a transparent Zcash address. Anyone can see what lands there. Oilskin has not checked its checksum — confirm it in your own wallet before you send.";
    case "sapling":
      return "This looks like a Sapling address. Oilskin has not checked its checksum — confirm it in your own wallet before you send.";
    case "unified":
      return "This looks like a unified Zcash address. Oilskin has not checked its checksum — confirm it in your own wallet before you send.";
    case "unrecognised":
      return "Oilskin does not recognise this as a Zcash address. That does not make it wrong — Oilskin reads the first characters and nothing else — but check it in your own wallet before you send anything to it.";
  }
}

// ---------------------------------------------------------------------------
// The quote, as a shape only
// ---------------------------------------------------------------------------

/**
 * What a quote from the route will look like when there is one. Every field is required and none has
 * a default: a quote with a missing fee is not a quote with a zero fee.
 *
 * Deliberately absent: any endpoint, any cached rate, any hard-coded fee or slippage. §3.1 requires
 * the service to proxy a LIVE quote and "never cache a rate into code", and there is no live quote
 * to proxy until Step Z1 has read what the endpoint actually returns.
 */
export interface ZecExitQuote {
  /** USDC the user spends, in base units (6 decimals), as a decimal string — never a float. */
  usdcInAtomic: string;
  /** ZEC the user receives, in zatoshi (8 decimals), as a decimal string. */
  zecOutZatoshi: string;
  /** Everything the route takes, in USDC base units, as the route itself reported it. */
  feeUsdcAtomic: string;
  /** Where the user's ZEC is going — echoed back so the UI can show what it is quoting for. */
  destination: string;
  /** Unix seconds after which this quote may not be acted on. */
  expiresAtS: number;
  /** The route's own identifier for this quote, whatever shape it turns out to be. */
  quoteRef: string;
  /** Which read produced the field shapes above. Mandatory, same discipline as `zecForms.ts`. */
  verifiedIn: string;
}

/** A refusal, which is the only thing the route can return today. */
export interface ZecExitRefusal {
  error: "zec_exit_unavailable";
  blockedBy: ZecExitBlocker;
  reason: string;
}

export function zecExitRefusal(readiness: ZecExitReadiness): ZecExitRefusal {
  if (readiness.blockedBy === null) throw new Error("zecExitRefusal called on a ready door");
  return { error: "zec_exit_unavailable", blockedBy: readiness.blockedBy, reason: readiness.reason };
}

// ---------------------------------------------------------------------------
// Step Z1's checklist, as data
// ---------------------------------------------------------------------------

/**
 * Everything `docs/VERIFIED-ZEC-ROUTES-<date>.md` has to answer before this door opens, from
 * `ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.3, plus the two this module itself added by needing them.
 * Shown by the UI in the dark state, so a reader can see what is missing rather than a grey button.
 */
export const ZEC_EXIT_OPEN_QUESTIONS: readonly string[] = [
  "The quote and intent endpoints, and the exact shape of what they take and return — observed, not read off a documentation page.",
  "Fee and slippage on a live USDC → ZEC quote, and on the reverse.",
  "The signer set behind the route: how many, who, what threshold, and whether any of that can be read on a chain or is only published.",
  "The withdrawal delay, measured rather than quoted.",
  "The smallest and largest transfer the route will take.",
  "Whether any step asks who you are, measured rather than claimed.",
  "What happens to an intent no solver fills, and after how long.",
  "The Zcash address formats themselves — the prefixes and checksum rules in ZIP 316 and the Zcash source. Until those are read, this build can only say what an address LOOKS like, never that it is valid.",
  "Whether a refund, if there is one, returns to the address the funds came from or somewhere else.",
];
