import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ZEC_EXIT_FACTS_DOC,
  ZEC_EXIT_OPEN_QUESTIONS,
  describeZecAddress,
  zecAddressShape,
  zecExitReadiness,
  zecExitRefusal,
} from "../dist/index.js";

test("the door is shut, and a missing facts file beats an enabled flag", () => {
  // Precedence is the whole point. A flag is a decision somebody made; the facts file is a
  // precondition, and CLAUDE.md rule 3 does not let a decision override it.
  const noFacts = zecExitReadiness({ factsPresent: false, flagEnabled: true });
  assert.equal(noFacts.ready, false);
  assert.equal(noFacts.blockedBy, "facts-missing");
  assert.match(noFacts.reason, /does not offer a route it has not read/i);
  assert.ok(noFacts.reason.includes(ZEC_EXIT_FACTS_DOC), "the refusal names the document that would unblock it");

  const flagOff = zecExitReadiness({ factsPresent: true, flagEnabled: false });
  assert.equal(flagOff.ready, false);
  assert.equal(flagOff.blockedBy, "flag-off");

  const open = zecExitReadiness({ factsPresent: true, flagEnabled: true });
  assert.deepEqual(open, { ready: true, blockedBy: null, reason: "" });
});

test("a refusal is never blank, and cannot be built for an open door", () => {
  for (const input of [
    { factsPresent: false, flagEnabled: false },
    { factsPresent: false, flagEnabled: true },
    { factsPresent: true, flagEnabled: false },
  ]) {
    const r = zecExitRefusal(zecExitReadiness(input));
    assert.equal(r.error, "zec_exit_unavailable");
    assert.ok(r.reason.trim().length > 40, JSON.stringify(input));
  }
  assert.throws(() => zecExitRefusal(zecExitReadiness({ factsPresent: true, flagEnabled: true })));
});

test("this module cannot reach the network: it holds no endpoint, no rate and no fee", () => {
  // The rule from ZEC-FORMS-AND-DOORS-2026-09-15.md §3.1 — the service proxies a LIVE quote and
  // "never caches a rate into code" — and there is no live quote to proxy until Step Z1 has read
  // what the endpoint returns. Pinning it by reading the source is the only way this stays true
  // when somebody wires the real thing up in a hurry.
  const src = readFileSync(fileURLToPath(new URL("../src/zecExit.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /https?:\/\//, "a URL appeared in the dark module");
  assert.doesNotMatch(src, /\bfetch\s*\(/, "a fetch appeared in the dark module");
  // No numeric rate, fee or basis-point constant. Decimal places named in prose are fine; an
  // assignment of a number to something that sounds like a price is not.
  assert.doesNotMatch(src, /(fee|rate|slippage|bps|minimum|maximum)[A-Za-z]*\s*[:=]\s*\d/i, "a number was typed for something nobody read");
});

test("address reading is a guess, and every sentence it produces says so", () => {
  assert.equal(zecAddressShape("t1dummyaddressdummyaddressdummy12"), "transparent");
  assert.equal(zecAddressShape("t3dummyaddressdummyaddressdummy12"), "transparent");
  assert.equal(zecAddressShape("zs1dummyaddressdummyaddressdummy12"), "sapling");
  assert.equal(zecAddressShape("u1dummyaddressdummyaddressdummy12"), "unified");
  // Anything it cannot place is "unrecognised", which is not the same as invalid and must not be
  // rendered as if it were.
  assert.equal(zecAddressShape("0x0000000000000000000000000000000000000000"), "unrecognised");
  assert.equal(zecAddressShape("zc1dummyaddressdummyaddressdummy12"), "unrecognised");
  assert.equal(zecAddressShape("t1 with a space in it dummy dummy"), "unrecognised");
  assert.equal(zecAddressShape("t1short"), "unrecognised");
  assert.equal(zecAddressShape(""), "unrecognised");
  assert.equal(zecAddressShape(null), "unrecognised");
  assert.equal(zecAddressShape(42), "unrecognised");
  assert.equal(zecAddressShape("__proto__"), "unrecognised");

  // No sentence this produces may claim an address is valid — the checksum has not been checked,
  // and the prefixes themselves are not in a facts file yet.
  for (const c of ["t1dummyaddressdummyaddressdummy12", "zs1dummyaddressdummyaddressdummy12", "u1dummyaddressdummyaddressdummy12", "nonsense"]) {
    const s = describeZecAddress(c);
    assert.doesNotMatch(s, /\bvalid\b/i, s);
    assert.match(s, /in your own wallet before you send/i, s);
  }
  // A transparent address is the one case with a consequence worth stating outright.
  assert.match(describeZecAddress("t1dummyaddressdummyaddressdummy12"), /Anyone can see what lands there/);
});

test("Step Z1's checklist includes the address formats this module had to guess at", () => {
  assert.ok(ZEC_EXIT_OPEN_QUESTIONS.length >= 9);
  const all = ZEC_EXIT_OPEN_QUESTIONS.join(" ");
  for (const need of [/ZIP 316/, /signer set/, /withdrawal delay/i, /no solver fills|nobody fills|no solver/i, /asks who you are/i]) {
    assert.match(all, need, String(need));
  }
});
