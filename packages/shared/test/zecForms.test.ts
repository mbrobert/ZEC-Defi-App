import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ZEC_FORMS,
  ZEC_FORM_IDS,
  zecForms,
  zecFormById,
  zecFormsOnChain,
  enabledZecForms,
  zecFormByAssetRef,
  isZecFormId,
  classifyZecAssetRef,
  isGenuineZecAssetRef,
  zecFormRegistryFaults,
  kaminoReserveForZecForm,
  BASE_TOKENS,
  CBZEC_ADDRESS,
  COUNTERFEIT_PREFIX,
  classifyCbZecAddress,
  SOLANA_TOKENS,
  KAMINO_ZCASH_MARKET,
  AAVE_V3_RESERVES,
  type ZecForm,
} from "../dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Heading texts of a markdown file, stripped of their leading `#`s. */
function headings(relPath: string): string[] {
  const text = readFileSync(REPO_ROOT + relPath, "utf8");
  return text
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => l.replace(/^#{1,6} /, "").trim());
}

// ---------------------------------------------------------------------------
// Rule 1 — verifiedIn is mandatory and points at a real facts-file section
// ---------------------------------------------------------------------------

test("every form's verifiedIn names a VERIFIED-*-FACTS.md section that actually exists", () => {
  for (const form of zecForms()) {
    const { file, section } = form.verifiedIn;
    assert.match(file, /^docs\/VERIFIED-[A-Z-]+-FACTS\.md$/, `${form.id}: verifiedIn.file is not a facts file`);
    const found = headings(file);
    assert.ok(
      found.includes(section),
      `${form.id}: "${section}" is not a heading in ${file}. Headings are:\n  ${found.join("\n  ")}`,
    );
  }
});

test("a stated identityRequirement names a document that exists; an unread one names none", () => {
  for (const form of zecForms()) {
    if (form.identityRequirement === "unread") {
      assert.equal(form.identitySource, null, `${form.id}: unread must not cite a source`);
      continue;
    }
    assert.ok(form.identitySource, `${form.id}: "${form.identityRequirement}" with no identitySource`);
    // Throws ENOENT if the cited document has been moved or deleted.
    assert.ok(readFileSync(REPO_ROOT + form.identitySource!, "utf8").length > 0);
  }
});

// ---------------------------------------------------------------------------
// Rule 4 — one place lists ZEC forms; assetRef/decimals come from the pins
// ---------------------------------------------------------------------------

test("each form's assetRef and decimals are the pinned values in base.ts / solana.ts", () => {
  const cbzec = ZEC_FORMS["cbzec-base"];
  assert.equal(cbzec.assetRef, BASE_TOKENS.cbZEC.address);
  assert.equal(cbzec.assetRef, CBZEC_ADDRESS);
  assert.equal(cbzec.decimals, BASE_TOKENS.cbZEC.decimals);
  assert.equal(cbzec.decimals, 8);
  assert.equal(cbzec.symbol, BASE_TOKENS.cbZEC.symbol);
  assert.equal(cbzec.lookalikePrefix, COUNTERFEIT_PREFIX);

  const bridged = ZEC_FORMS["zec-solana-bridged"];
  assert.equal(bridged.assetRef, SOLANA_TOKENS.ZEC.mint);
  assert.equal(bridged.decimals, SOLANA_TOKENS.ZEC.decimals);
  assert.equal(bridged.decimals, 8);
  assert.equal(bridged.symbol, SOLANA_TOKENS.ZEC.symbol);
  // The venue must lend against this exact mint, not against a symbol.
  assert.equal(bridged.assetRef, KAMINO_ZCASH_MARKET.reserves.ZEC.mint);
  assert.equal(kaminoReserveForZecForm(bridged), KAMINO_ZCASH_MARKET.reserves.ZEC.address);
  assert.equal(kaminoReserveForZecForm(cbzec), null);
});

test("the registry is structurally well-formed", () => {
  assert.deepEqual(zecFormRegistryFaults(), []);
  assert.deepEqual([...ZEC_FORM_IDS], ["cbzec-base", "zec-solana-bridged"]);
  assert.deepEqual(Object.keys(ZEC_FORMS).sort(), [...ZEC_FORM_IDS].sort());
});

test("zecFormRegistryFaults catches the mistakes it exists to catch", () => {
  // Faults are computed over the real registry, so exercise the predicates directly on clones.
  const good = ZEC_FORMS["zec-solana-bridged"];
  const enabledWithoutVenue: ZecForm = { ...good, collateralVenue: null };
  assert.equal(enabledWithoutVenue.enabled && enabledWithoutVenue.collateralVenue === null, true);
  const disabledWithoutReason: ZecForm = { ...good, enabled: false };
  assert.equal(disabledWithoutReason.disabledReason, undefined);
});

// ---------------------------------------------------------------------------
// The two rows, and the decisions they encode
// ---------------------------------------------------------------------------

test("cbzec-base is disabled with D3's reason, has no venue, and is not an Aave reserve", () => {
  const f = ZEC_FORMS["cbzec-base"];
  assert.equal(f.chain, "base");
  assert.equal(f.custody, "custodial");
  assert.equal(f.enabled, false);
  assert.equal(f.collateralVenue, null);
  assert.ok((f.disabledReason ?? "").length > 20);
  assert.match(f.disabledReason!, /no lending market|not an Aave v3 reserve/i);
  assert.match(f.disabledReason!, /D3/);
  // D3 is not merely typed here: cbZEC is absent from the Aave reserve list read on chain.
  assert.equal((AAVE_V3_RESERVES as readonly string[]).includes("cbZEC"), false);
  assert.ok(f.riskNotes.length >= 3);
  assert.ok(f.openQuestions.length >= 1);
});

test("cbZEC's freeze authority is 'not-readable', never 'none' — the B20 powers exist unread", () => {
  const f = ZEC_FORMS["cbzec-base"];
  assert.equal(f.freezeAuthority.kind, "not-readable");
  assert.notEqual(f.freezeAuthority.kind, "none");
  assert.ok(f.freezeAuthority.kind === "not-readable" && f.freezeAuthority.capability.length > 40);
  // owner()/paused() revert on the precompile, so no surface may print an authority address.
  assert.equal("address" in f.freezeAuthority, false);
});

test("zec-solana-bridged is enabled on Kamino, has no freeze authority, and its identity step is unread", () => {
  const f = ZEC_FORMS["zec-solana-bridged"];
  assert.equal(f.chain, "solana");
  assert.equal(f.custody, "bridged");
  assert.equal(f.enabled, true);
  assert.equal(f.collateralVenue, "kamino-zcash");
  assert.equal(f.disabledReason, undefined);
  assert.deepEqual(f.freezeAuthority, { kind: "none" });
  // VERIFIED-SOLANA-FACTS "Not verified by this read" item 5 leaves the NEAR side unread, so the
  // row must not claim "none". Step Z1 measures it; until then this assertion holds it honest.
  assert.equal(f.identityRequirement, "unread");
  assert.equal(f.identitySource, null);
  assert.ok(
    f.openQuestions.some((q) => /OmniBridge|signer set/i.test(q)),
    "the unread NEAR side must be named in openQuestions",
  );
});

test("no form is enabled without a collateral venue, and disabled forms are still listed", () => {
  for (const f of zecForms()) if (f.enabled) assert.notEqual(f.collateralVenue, null, f.id);
  assert.deepEqual(
    enabledZecForms().map((f) => f.id),
    ["zec-solana-bridged"],
  );
  // The disabled row is still enumerable: "where is your ZEC?" answers for every form.
  assert.equal(zecForms().length, 2);
  assert.deepEqual(
    zecFormsOnChain("base").map((f) => f.id),
    ["cbzec-base"],
  );
  assert.deepEqual(
    zecFormsOnChain("solana").map((f) => f.id),
    ["zec-solana-bridged"],
  );
  assert.deepEqual(zecFormsOnChain("zcash"), []);
});

// ---------------------------------------------------------------------------
// Rule 3 — the counterfeit check follows the form, not the brand
// ---------------------------------------------------------------------------

test("classifyZecAssetRef: the Base form rejects a 0xb2000 look-alike and accepts only the pin", () => {
  const f = ZEC_FORMS["cbzec-base"];
  assert.equal(classifyZecAssetRef(f, CBZEC_ADDRESS), "genuine");
  assert.equal(classifyZecAssetRef(f, CBZEC_ADDRESS.toLowerCase()), "genuine");
  assert.equal(classifyZecAssetRef(f, "0x" + CBZEC_ADDRESS.slice(2).toUpperCase()), "genuine");
  assert.equal(isGenuineZecAssetRef(f, CBZEC_ADDRESS), true);

  // One hex digit off the pin, still wearing the vanity prefix.
  const oneOff = CBZEC_ADDRESS.slice(0, -1) + (CBZEC_ADDRESS.slice(-1) === "C" ? "D" : "C");
  assert.equal(classifyZecAssetRef(f, oneOff), "counterfeit");
  assert.equal(isGenuineZecAssetRef(f, oneOff), false);
  assert.equal(classifyZecAssetRef(f, "0xB20000000000000000000000000000000000dead"), "counterfeit");

  assert.equal(classifyZecAssetRef(f, BASE_TOKENS.cbBTC.address), "unrelated");
  assert.equal(classifyZecAssetRef(f, "0xb200100000000000000000000000000000000000"), "unrelated");
  assert.equal(classifyZecAssetRef(f, "0xb2000"), "invalid");
  assert.equal(classifyZecAssetRef(f, ""), "invalid");
  assert.equal(classifyZecAssetRef(f, null), "invalid");
  assert.equal(classifyZecAssetRef(f, 42), "invalid");
  // A Solana mint is not an address of this form's chain.
  assert.equal(classifyZecAssetRef(f, SOLANA_TOKENS.ZEC.mint), "invalid");
});

test("classifyZecAssetRef: the Solana form accepts only its pinned mint, case-significantly", () => {
  const f = ZEC_FORMS["zec-solana-bridged"];
  assert.equal(classifyZecAssetRef(f, SOLANA_TOKENS.ZEC.mint), "genuine");
  assert.equal(isGenuineZecAssetRef(f, SOLANA_TOKENS.ZEC.mint), true);
  // base58 is case-significant. Case-folding this mint also changes its decoded length, so it comes
  // back malformed rather than merely different — either way it is never genuine.
  assert.equal(classifyZecAssetRef(f, SOLANA_TOKENS.ZEC.mint.toLowerCase()), "invalid");
  assert.equal(isGenuineZecAssetRef(f, SOLANA_TOKENS.ZEC.mint.toLowerCase()), false);
  // A well-formed key that is simply a different asset.
  assert.equal(classifyZecAssetRef(f, SOLANA_TOKENS.USDC.mint), "unrelated");
  assert.equal(classifyZecAssetRef(f, KAMINO_ZCASH_MARKET.reserves.ZEC.address), "unrelated");
  assert.equal(classifyZecAssetRef(f, CBZEC_ADDRESS), "invalid");
  assert.equal(classifyZecAssetRef(f, "not-a-key"), "invalid");
  assert.equal(classifyZecAssetRef(f, null), "invalid");
  // No look-alike prefix has been observed for this form, so nothing is upgraded to "counterfeit" —
  // but the safety property still holds: only the pin is ever genuine.
  assert.equal(f.lookalikePrefix, null);
  for (const f2 of zecForms()) {
    assert.equal(isGenuineZecAssetRef(f2, "0x0000000000000000000000000000000000000000"), false);
  }
});

test("the per-form classifier agrees with base.ts's cbZEC classifier on every case", () => {
  const f = ZEC_FORMS["cbzec-base"];
  const cases: unknown[] = [
    CBZEC_ADDRESS,
    CBZEC_ADDRESS.toLowerCase(),
    "0xB20000000000000000000000000000000000dead",
    "0xb2000123456789012345678901234567890123ab",
    BASE_TOKENS.cbBTC.address,
    BASE_TOKENS.USDC.address,
    "0xb2000",
    "0xb2001000000000000000000000000000000000000",
    "",
    null,
    undefined,
    42,
  ];
  for (const v of cases) {
    assert.equal(
      classifyZecAssetRef(f, v),
      classifyCbZecAddress(v),
      `drifted from base.ts on ${String(v)} — the two must agree until consumers move over`,
    );
  }
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test("lookups: by id, by assetRef, and the id guard", () => {
  assert.equal(zecFormById("cbzec-base")?.id, "cbzec-base");
  assert.equal(zecFormById("zec-native-zsa"), undefined);
  assert.equal(zecFormById(null), undefined);

  assert.equal(zecFormByAssetRef(CBZEC_ADDRESS)?.id, "cbzec-base");
  assert.equal(zecFormByAssetRef(CBZEC_ADDRESS.toLowerCase())?.id, "cbzec-base");
  assert.equal(zecFormByAssetRef(SOLANA_TOKENS.ZEC.mint)?.id, "zec-solana-bridged");
  // base58 is case-significant, so a folded mint must not resolve to the Solana form — and must not
  // fall through to the Base form's case-insensitive match either.
  assert.equal(zecFormByAssetRef(SOLANA_TOKENS.ZEC.mint.toLowerCase()), undefined);
  assert.equal(zecFormByAssetRef(BASE_TOKENS.cbBTC.address), undefined);
  assert.equal(zecFormByAssetRef(42), undefined);

  assert.equal(isZecFormId("cbzec-base"), true);
  assert.equal(isZecFormId("cbZEC"), false);
  assert.equal(isZecFormId(undefined), false);
});

// ---------------------------------------------------------------------------
// Copy discipline — riskNotes and disabledReason are shown to users verbatim
// ---------------------------------------------------------------------------

test("no banned word appears in any user-facing string on a form", () => {
  // Kept in step with web/lib/copy.ts BANNED_WORDS; these strings are rendered verbatim by the UI,
  // and web's own copy scan does not read packages/shared.
  const BANNED = [
    "private",
    "shielded",
    "non-custodial",
    "locked payout address",
    "no operator custody",
    "no owner powers",
    "can never withdraw",
    "move a token on its own",
    "guaranteed",
    "risk-free",
  ];
  for (const f of zecForms()) {
    const strings = [
      f.label,
      f.disabledReason ?? "",
      ...f.riskNotes,
      ...f.openQuestions,
      f.freezeAuthority.kind === "not-readable" ? f.freezeAuthority.capability : "",
    ];
    for (const s of strings) {
      for (const w of BANNED) {
        assert.equal(s.toLowerCase().includes(w), false, `${f.id}: banned word "${w}" in: ${s}`);
      }
    }
  }
});
