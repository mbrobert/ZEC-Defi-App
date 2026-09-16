import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BANNED_WORDS, FOOTER_LINES, RISKS, TERMS_OF_ART, bannedWordsIn, risksFor } from "../lib/copy";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("banned words never appear in product source (app/, components/, lib/)", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  assert.ok(files.length > 20, "scanned a real tree");
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const hit of bannedWordsIn(text)) {
      const line = text.slice(0, hit.index).split("\n").length;
      const lineText = text.split("\n")[line - 1];
      // The two permitted occurrences are the lists' own definitions.
      if (/BANNED_WORDS\s*:|TERMS_OF_ART\s*:/.test(lineText)) continue;
      offenders.push(`${relative(ROOT, f)}:${line}: "${hit.word}" in: ${lineText.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a banned word inside a term of art is allowed; the bare word is not", () => {
  // The founder's instruction of 2026-09-15: a word that names an actual feature is not a claim.
  // Zcash's shielded pool is what the pool is called, and a user who cannot be told its name cannot
  // go and read about it.
  assert.deepEqual(bannedWordsIn("Your ZEC leaves Zcash's shielded pool."), []);
  assert.deepEqual(bannedWordsIn("Withdrawals go to shielded addresses only."), []);
  assert.deepEqual(bannedWordsIn("Zcash Shielded Assets (ZIP 226) are still Draft."), []);
  assert.deepEqual(bannedWordsIn("Never paste a private key here."), []);

  // and the ban itself is intact — the whole point of allowing the phrase is that the word alone
  // is still a claim we have not earned.
  assert.deepEqual(
    bannedWordsIn("Your position is shielded.").map((h) => h.word),
    ["shielded"],
  );
  assert.deepEqual(
    bannedWordsIn("A private, non-custodial vault.").map((h) => h.word),
    ["private", "non-custodial"],
  );
  // A term of art does not license the word elsewhere in the same sentence.
  assert.deepEqual(
    bannedWordsIn("It leaves the shielded pool, and the transfer is shielded.").map((h) => h.word),
    ["shielded"],
  );

  // Every allowance names something outside Oilskin that its own makers call that. If a phrase is
  // ever added that names something of ours, this is where the reviewer is meant to stop.
  assert.ok(TERMS_OF_ART.length <= 10, "the allowance stays small enough to read in one go");
  for (const t of TERMS_OF_ART) {
    assert.ok(BANNED_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(t)), `${t} contains no banned word — it does not belong here`);
    assert.doesNotMatch(t, /oilskin/i, `${t} names something of ours`);
  }
});

test("the disclosure list covers every BASE-PIVOT item-19 topic", () => {
  const ids = RISKS.map((r) => r.id);
  for (const need of ["custodial-entry", "kyc", "jurisdiction", "b20", "peg", "own-market", "liquidation", "il", "keeper", "contracts", "demo"]) {
    assert.ok(ids.includes(need), `missing disclosure: ${need}`);
  }
  assert.ok(RISKS.every((r) => r.title.length > 3 && r.body.length > 40 && r.scope.length > 0));
});

test("review shows the full list; every surface has at least the demo + contract notes it needs", () => {
  const review = risksFor("review").map((r) => r.id);
  for (const id of ["custodial-entry", "kyc", "jurisdiction", "b20", "peg", "own-market", "liquidation", "il", "keeper", "engine", "contracts", "demo"]) assert.ok(review.includes(id), id);
  assert.ok(risksFor("dashboard").some((r) => r.id === "liquidation"));
  assert.ok(risksFor("spot").some((r) => r.id === "spot"));
  assert.ok(risksFor("onboard").some((r) => r.id === "jurisdiction"));
  assert.ok(risksFor("footer").some((r) => r.id === "demo"));
});

test("copy never claims an audit, guarantees, or custody words it cannot back", () => {
  const text = [...RISKS.map((r) => r.body), ...FOOTER_LINES].join(" ");
  assert.doesNotMatch(text, /\baudited\b/i);
  assert.doesNotMatch(text, /guarantee/i);
  assert.doesNotMatch(text, /risk-free|no risk/i);
});
