/**
 * The ZEC form registry — one row per *form* of ZEC (ZEC = Zcash's native coin), described by its
 * properties rather than its brand.
 *
 * Founder's decision, 2026-09-15 (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md`): Oilskin accepts every
 * form of ZEC — cbZEC on Base, bridged ZEC on Solana, any future wrapper, and eventually native
 * Zcash Shielded Assets (ZSA, ZIP 226/227, still Draft, so no row here). cbZEC stops being *the*
 * ZEC and becomes *a* ZEC: one row among several, disabled on its own merits rather than by being
 * the only name in a type.
 *
 * Abbreviations used below, spelled out on first use: LTV = loan-to-value; HF = health factor;
 * PDA = program-derived address (a Solana account a program, not a key, controls); MPC = multi-party
 * computation; TSS = threshold signature scheme; B20 = Base's native precompile token standard;
 * SPL = Solana Program Library (its token standard).
 *
 * THE RULES THIS FILE EXISTS TO ENFORCE (`ZEC-FORMS-AND-DOORS-2026-09-15.md` §2.3):
 *
 * 1. `verifiedIn` is mandatory and is a `docs/VERIFIED-*-FACTS.md` section. A form with no facts
 *    row does not type-check into the registry. This is `CLAUDE.md` rule 3 made structural: the way
 *    a new wrapper is added is read it on chain, write the facts row, then add the form — never the
 *    other way round. `test/zecForms.test.ts` opens each file and matches the heading.
 * 2. A form is never enabled by symbol. `enabled` records that a lending venue accepted this exact
 *    `assetRef` at the dated read in `verifiedIn`; every surface re-reads the venue before acting.
 *    A row with no `collateralVenue` can never be enabled.
 * 3. The counterfeit check follows the form, not the brand — `classifyZecAssetRef` below. Nothing
 *    but the pinned `assetRef` is ever "genuine", on either chain.
 * 4. There is ONE place that lists ZEC forms: this file. `assetRef` and `decimals` are read from the
 *    pinned constants in `base.ts` / `solana.ts`, never retyped.
 *
 * WHERE A FACT IS UNREAD, THIS FILE SAYS SO rather than guessing: `freezeAuthority` and
 * `identityRequirement` both carry an explicit unread state, and `openQuestions` names, per form,
 * what has not been verified. Those lists are Step Z1's checklist
 * (`ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.3).
 */
import { BASE_TOKENS, COUNTERFEIT_PREFIX } from "./base.js";
import { isHexAddress } from "./evm.js";
import { SOLANA_TOKENS, KAMINO_ZCASH_MARKET, isSolanaAddress } from "./solana.js";
import type { CollateralVenueId } from "./collateral.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every form of ZEC Oilskin knows about. Future rows are DATA, not code: a new wrapper adds an id
 * here and a row below, and no consumer needs a new branch.
 * Reserved for when ZIP 226/227 leave Draft and NU7 has a date: "zec-native-zsa".
 */
export type ZecFormId =
  | "cbzec-base" // Coinbase Wrapped ZEC, a B20 precompile on Base
  | "zec-solana-bridged"; // the OmniBridge / NEAR Intents SPL mint on Solana

/** The chain a form lives on. "zcash" is reserved for the native (ZSA) era; no row uses it today. */
export type ZecFormChain = "base" | "solana" | "zcash";

/** How the thing a form represents is held. Chain-observable classification only. */
export type ZecCustody =
  /** A named issuer holds the underlying and can pause or block transfers of the representation. */
  | "custodial"
  /** A bridge program mints the representation; who holds the underlying is a separate, stated fact. */
  | "bridged"
  /** The Zcash chain itself. No row today — ZSAs are not live. */
  | "native";

/**
 * Who can stop a holder's transfer.
 *
 * Three states, not two, and the third is the point: on a Base B20 precompile the blocklist and
 * pause powers demonstrably exist but `owner()` and `paused()` revert, so there is no authority to
 * read. Collapsing that to `null` would let a surface print "nobody can freeze this" about a token
 * whose issuer can seize balances. `kind: "none"` is a positive on-chain read; `"not-readable"` is
 * the absence of one.
 */
export type ZecFreezeAuthority =
  /** Read on chain: the mint carries no freeze authority, so nobody could freeze a balance at that read. */
  | { kind: "none" }
  /** A readable authority holds the power. */
  | { kind: "address"; address: string }
  /** The power exists but no getter exposes who holds it. `capability` states what it can do. */
  | { kind: "not-readable"; capability: string };

/**
 * Whether obtaining this form requires identity verification.
 *
 * "unread" is a first-class answer and the honest one wherever nothing in the repository has
 * measured it. `VERIFIED-SOLANA-FACTS.md` "Not verified by this read" item 5 leaves the NEAR side of
 * the bridge unread, and `ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.3 lists "whether any step asks for
 * identity, measured rather than claimed" as a Step Z1 item — so the Solana row must not assert
 * "none" simply because no one has been asked for a passport.
 */
export type ZecIdentityRequirement = "required" | "none" | "unread";

/** Lending venues that can accept a ZEC form as collateral. The EVM ids come from `collateral.ts`. */
export type ZecLendingVenueId = CollateralVenueId | "kamino-zcash";

/** A pointer at the facts-file section that proves a row. Both parts are matched by the test. */
export interface ZecFactsRef {
  /** Repository-relative path; must be a `docs/VERIFIED-*-FACTS.md`. */
  file: string;
  /** The section heading text, verbatim and without its leading `#`s. */
  section: string;
}

export interface ZecForm {
  id: ZecFormId;
  chain: ZecFormChain;
  /** What the product calls this form on screen. Step 3 of the plan replaces bare "cbZEC" with it. */
  label: string;
  /** What the chain calls it. Not a key — two chains may both say "ZEC". */
  symbol: string;
  /** The real key: an EVM address on Base, an SPL mint on Solana. Pinned, never retyped. */
  assetRef: string;
  decimals: number;
  custody: ZecCustody;
  freezeAuthority: ZecFreezeAuthority;
  identityRequirement: ZecIdentityRequirement;
  /**
   * The document supporting a non-"unread" `identityRequirement`. Required whenever the requirement
   * is stated, null when it is "unread" — so a claim can never be made without naming its source.
   */
  identitySource: string | null;
  /** Lending venue that accepted this exact `assetRef` as collateral at the dated read, or null. */
  collateralVenue: ZecLendingVenueId | null;
  /**
   * An address prefix scammers share with this form's real `assetRef`. Present only where it has
   * been observed; null means the only rule is exact match. Never a second copy of a constant.
   */
  lookalikePrefix: string | null;
  /** See rule 2 in the module comment: a venue accepted it at the dated read; surfaces re-read. */
  enabled: boolean;
  /** Shown verbatim when `enabled` is false. Never softened. */
  disabledReason?: string;
  /** Stated before the button, always. */
  riskNotes: readonly string[];
  /** What has NOT been verified about this form. Step Z1's checklist; shown, not hidden. */
  openQuestions: readonly string[];
  /** Facts-file section that proves the chain-read fields above. Mandatory (rule 1). */
  verifiedIn: ZecFactsRef;
}

// ---------------------------------------------------------------------------
// The registry — two rows today
// ---------------------------------------------------------------------------

export const ZEC_FORMS: Readonly<Record<ZecFormId, ZecForm>> = {
  "cbzec-base": {
    id: "cbzec-base",
    chain: "base",
    label: "cbZEC on Base",
    symbol: BASE_TOKENS.cbZEC.symbol,
    assetRef: BASE_TOKENS.cbZEC.address,
    decimals: BASE_TOKENS.cbZEC.decimals,
    custody: "custodial",
    freezeAuthority: {
      kind: "not-readable",
      capability:
        "The issuer can block an address, burn a blocked balance (seize, not merely freeze), pause the token, and rebase every balance through a live multiplier. Who holds those powers is not readable: owner() and paused() revert on the B20 precompile.",
    },
    identityRequirement: "required",
    identitySource: "docs/CBZEC-2026-09.md",
    collateralVenue: null,
    lookalikePrefix: COUNTERFEIT_PREFIX,
    enabled: false,
    disabledReason:
      "No lending market accepts cbZEC as collateral on Base: it is not an Aave v3 reserve and no Morpho Blue market exists for it. Oilskin does not create that market itself (decision D3, 2026-09-12) — it waits for an external market to list cbZEC. ZEC holders can borrow today through the Solana lane instead.",
    riskNotes: [
      "Custodial wrapper: cbZEC exists only because Coinbase holds the ZEC behind it, and getting in or out goes through a Coinbase account.",
      "B20 precompile, not a plain ERC-20: balances can rebase through a live multiplier() and transfers can be blocked, seized or paused by the issuer. Oilskin can read the multiplier and simulate a zero-amount transfer from your own address; the issuer's policy itself is not readable and can change after the read.",
      "The 1:1 value to ZEC is an issuer promise, not a mechanism. Decentralised-exchange depth is thin, so the two can trade apart under stress and a ZEC/USD oracle would overvalue cbZEC.",
      "Scammers deploy look-alike addresses sharing cbZEC's 0xb2000 vanity prefix; only the pinned address is genuine.",
    ],
    openQuestions: [
      "The issuer's live policy state (blocklist membership, pause) — owner() and paused() revert on the precompile, so only multiplier() and a simulated transfer can be read.",
      "The identity-verification and jurisdiction claims come from docs/CBZEC-2026-09.md, whose own banner records that its ~120 source links were lost when the original research file was recycled. They have not been re-attached and are not in a VERIFIED-*-FACTS.md file.",
    ],
    verifiedIn: {
      file: "docs/VERIFIED-BASE-FACTS.md",
      section: "Tokens (all verified: `symbol()`, `decimals()`, `totalSupply()`)",
    },
  },

  "zec-solana-bridged": {
    id: "zec-solana-bridged",
    chain: "solana",
    label: "Bridged ZEC on Solana",
    symbol: SOLANA_TOKENS.ZEC.symbol,
    assetRef: SOLANA_TOKENS.ZEC.mint,
    decimals: SOLANA_TOKENS.ZEC.decimals,
    custody: "bridged",
    freezeAuthority: { kind: "none" },
    identityRequirement: "unread",
    identitySource: null,
    collateralVenue: "kamino-zcash",
    lookalikePrefix: null,
    enabled: true,
    riskNotes: [
      "A bridge program mints this token. Nobody can freeze a holder's balance — the mint carries no freeze authority — but the program that mints it can be upgraded, so the supply is as sound as that program's governance.",
      "The mint authority is a program-derived address (PDA) of that bridge program, and the bridge program's own upgrade authority is another PDA whose controlling multisig, threshold and timelock are not known.",
      "Kamino's ZCASH market is the only venue that lends against it, and that market's owner can change every reserve parameter. Kamino's own stop-loss and take-profit orders are switched off on it, so a keeper is the only automated protection a position can have there.",
      "Kamino caps this collateral at 40 % loan-to-value (LTV), which binds before Oilskin's own entry health-factor (HF) floor does.",
    ],
    openQuestions: [
      "The off-Solana side of the bridge — the OmniBridge signer set, the multi-party-computation / threshold-signature-scheme (MPC/TSS) custody of the locked ZEC, and the withdrawal delay — is entirely unread: docs/VERIFIED-SOLANA-FACTS.md, 'Not verified by this read (probe before use)', item 5.",
      "Whether any step of obtaining this form asks for identity has not been measured — which is why identityRequirement is 'unread' rather than 'none'. Step Z1 measures it.",
      "What controls the bridge program's upgrade-authority PDA: which multisig program, which signers, what threshold, any timelock.",
    ],
    verifiedIn: {
      file: "docs/VERIFIED-SOLANA-FACTS.md",
      section: "Bridged ZEC — the mint, its authority, and who mints",
    },
  },
};

/** Registry order: the order surfaces list forms in. */
export const ZEC_FORM_IDS: readonly ZecFormId[] = ["cbzec-base", "zec-solana-bridged"];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function isZecFormId(value: unknown): value is ZecFormId {
  return typeof value === "string" && (ZEC_FORM_IDS as readonly string[]).includes(value);
}

export function zecForms(): ZecForm[] {
  return ZEC_FORM_IDS.map((id) => ZEC_FORMS[id]);
}

export function zecFormById(id: unknown): ZecForm | undefined {
  return isZecFormId(id) ? ZEC_FORMS[id] : undefined;
}

export function zecFormsOnChain(chain: ZecFormChain): ZecForm[] {
  return zecForms().filter((f) => f.chain === chain);
}

/**
 * Forms a user can actually borrow against today. Disabled rows are still SHOWN — with their
 * `disabledReason` verbatim — because "where is your ZEC?" must answer honestly for every form,
 * including the ones that do not end in a loan.
 */
export function enabledZecForms(): ZecForm[] {
  return zecForms().filter((f) => f.enabled);
}

/**
 * Find a form by its on-chain key. EVM addresses match case-insensitively (they are hex); Solana
 * mints match exactly (base58 is case-significant).
 */
export function zecFormByAssetRef(assetRef: unknown): ZecForm | undefined {
  if (typeof assetRef !== "string") return undefined;
  return zecForms().find((f) =>
    f.chain === "solana" ? f.assetRef === assetRef : f.assetRef.toLowerCase() === assetRef.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Counterfeit detection, per form
// ---------------------------------------------------------------------------

/**
 * genuine     — exactly this form's pinned `assetRef`
 * counterfeit — well-formed for the chain and shares this form's observed look-alike prefix, but is
 *               not the pinned `assetRef`
 * unrelated   — well-formed for the chain, some other asset
 * invalid     — not an address of this chain's shape at all
 */
export type ZecAssetRefClass = "genuine" | "counterfeit" | "unrelated" | "invalid";

/**
 * Classify a candidate address against one form. Generalises `classifyCbZecAddress` in `base.ts`
 * from the single cbZEC row to every form: the check follows the form, not the brand
 * (`ZEC-FORMS-AND-DOORS-2026-09-15.md` §2.3 rule 3).
 *
 * The safety property holds on both chains and does not depend on knowing a prefix: nothing but the
 * pinned `assetRef` is ever "genuine". `lookalikePrefix` only upgrades the *warning* from
 * "unrelated" to "counterfeit" where such an attack has actually been observed; a form with no
 * observed prefix says "unrelated" rather than inventing a rule nobody read.
 */
export function classifyZecAssetRef(form: ZecForm, candidate: unknown): ZecAssetRefClass {
  const wellFormed = form.chain === "solana" ? isSolanaAddress(candidate) : isHexAddress(candidate);
  if (!wellFormed || typeof candidate !== "string") return "invalid";
  if (form.chain === "solana") {
    if (candidate === form.assetRef) return "genuine";
  } else if (candidate.toLowerCase() === form.assetRef.toLowerCase()) {
    return "genuine";
  }
  const prefix = form.lookalikePrefix;
  if (prefix !== null) {
    const compare = form.chain === "solana" ? candidate : candidate.toLowerCase();
    const against = form.chain === "solana" ? prefix : prefix.toLowerCase();
    if (compare.startsWith(against)) return "counterfeit";
  }
  return "unrelated";
}

/** True only for the pinned `assetRef` of that form, in that chain's casing rules. */
export function isGenuineZecAssetRef(form: ZecForm, candidate: unknown): boolean {
  return classifyZecAssetRef(form, candidate) === "genuine";
}

// ---------------------------------------------------------------------------
// Invariants — the shape rules, callable so both the test and any future
// registry-loading surface check the same list.
// ---------------------------------------------------------------------------

/**
 * Every structural rule from the module comment that a type cannot express. Returns the failures as
 * plain sentences (empty = the registry is well-formed) rather than throwing, so a surface can
 * report them without white-screening. `test/zecForms.test.ts` additionally opens each `verifiedIn`
 * file and matches its heading — that check needs the filesystem and stays in the test.
 */
export function zecFormRegistryFaults(): string[] {
  const faults: string[] = [];
  const seenRefs = new Map<string, ZecFormId>();
  for (const id of ZEC_FORM_IDS) {
    const f = ZEC_FORMS[id];
    if (f.id !== id) faults.push(`${id}: row's own id is "${f.id}"`);
    if (!f.enabled && !(f.disabledReason ?? "").trim()) faults.push(`${id}: disabled with no disabledReason`);
    if (f.enabled && f.collateralVenue === null) faults.push(`${id}: enabled with no collateralVenue`);
    if (f.enabled && f.disabledReason !== undefined) faults.push(`${id}: enabled but carries a disabledReason`);
    if (!f.verifiedIn.file.startsWith("docs/VERIFIED-") || !f.verifiedIn.file.endsWith("-FACTS.md")) {
      faults.push(`${id}: verifiedIn.file "${f.verifiedIn.file}" is not a docs/VERIFIED-*-FACTS.md`);
    }
    if (!f.verifiedIn.section.trim()) faults.push(`${id}: verifiedIn.section is empty`);
    if (f.identityRequirement === "unread" && f.identitySource !== null) {
      faults.push(`${id}: identityRequirement is "unread" but names a source`);
    }
    if (f.identityRequirement !== "unread" && !(f.identitySource ?? "").trim()) {
      faults.push(`${id}: identityRequirement is "${f.identityRequirement}" with no identitySource`);
    }
    if (f.riskNotes.length === 0) faults.push(`${id}: no riskNotes`);
    const wellFormed = f.chain === "solana" ? isSolanaAddress(f.assetRef) : isHexAddress(f.assetRef);
    if (!wellFormed) faults.push(`${id}: assetRef "${f.assetRef}" is not well-formed for chain "${f.chain}"`);
    if (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 18) {
      faults.push(`${id}: decimals ${String(f.decimals)} is out of range`);
    }
    const key = f.chain === "solana" ? f.assetRef : f.assetRef.toLowerCase();
    const prior = seenRefs.get(key);
    if (prior !== undefined) faults.push(`${id}: shares assetRef with ${prior}`);
    seenRefs.set(key, id);
  }
  const listed = new Set<string>(ZEC_FORM_IDS);
  for (const id of Object.keys(ZEC_FORMS)) {
    if (!listed.has(id)) faults.push(`${id}: in ZEC_FORMS but missing from ZEC_FORM_IDS`);
  }
  return faults;
}

/**
 * The venue account a form's collateral is actually held in, where the chain pins one. Solana's
 * bridged ZEC has a Kamino reserve; Base's cbZEC has no venue at all (D3). Exposed so a surface can
 * re-read the venue instead of trusting `enabled` (rule 2).
 */
export function kaminoReserveForZecForm(form: ZecForm): string | null {
  return form.collateralVenue === "kamino-zcash" ? KAMINO_ZCASH_MARKET.reserves.ZEC.address : null;
}
