import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BANNED_WORDS, FOOTER_LINES, RISKS, risksFor } from "../lib/copy";

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
    for (const w of BANNED_WORDS) {
      const re = new RegExp(`\\b${w.replace(/[-\s]/g, "[-\\s]")}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        const lineText = text.split("\n")[line - 1];
        // The only permitted occurrence is the BANNED_WORDS definition itself.
        if (/BANNED_WORDS\s*:/.test(lineText)) continue;
        offenders.push(`${relative(ROOT, f)}:${line}: "${w}" in: ${lineText.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
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
