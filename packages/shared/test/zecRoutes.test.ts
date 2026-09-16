import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_UNVERIFIED,
  ZEC_FORMS,
  ZEC_ORIGINS,
  ZEC_ROUTES,
  isZecOrigin,
  originReachesLendingVenue,
  zecRouteById,
  zecRouteFaults,
  zecRouteForm,
  zecRoutesFrom,
} from "../dist/index.js";

test("the route table is well-formed — zecRouteFaults() is empty", () => {
  assert.deepEqual(zecRouteFaults(), []);
});

test("every origin has an answer, because the question is asked of everyone", () => {
  // "Where is your ZEC?" is the first thing Door 2 asks. An origin with no route would leave a real
  // user on a screen with nothing on it, which is worse than an honest "this one does not work".
  for (const origin of ZEC_ORIGINS) {
    assert.ok(zecRoutesFrom(origin).length > 0, `${origin} has no route`);
  }
  assert.equal(isZecOrigin("zcash-address"), true);
  assert.equal(isZecOrigin("ethereum"), false);
  assert.equal(isZecOrigin("__proto__"), false);
});

test("exactly the origins that can end in a loan say they can", () => {
  // The single fact most users are actually asking for, and the one it would be most tempting to
  // blur. Base cannot, today, and the screen has to say so rather than offer a hopeful maybe.
  assert.equal(originReachesLendingVenue("zcash-address"), true);
  assert.equal(originReachesLendingVenue("solana"), true);
  assert.equal(originReachesLendingVenue("base"), false);
  assert.equal(originReachesLendingVenue("exchange"), false);
});

test("a route may only claim a lending venue when the form it delivers has one", () => {
  for (const r of ZEC_ROUTES) {
    const form = zecRouteForm(r);
    if (r.outcome === "reaches-a-lending-venue") {
      assert.ok(form, `${r.id}: no form`);
      // `enabled` is set from a dated read of the venue (zecForms.ts rule 2), so this ties the
      // claim a user sees back to something that was read on a chain rather than typed.
      assert.equal(form!.enabled, true, `${r.id}: ${form!.id} is not enabled`);
      assert.notEqual(form!.collateralVenue, null, `${r.id}: ${form!.id} has no venue`);
      assert.equal(r.stopsBecause, null);
    }
    if (r.outcome === "no-lending-venue") {
      assert.ok(form, `${r.id}: no form`);
      assert.equal(form!.enabled, false);
      // Verbatim, and the same object — not a second copy that could be softened later.
      assert.equal(r.stopsBecause, form!.disabledReason);
    }
    if (r.outcome === "hands-off") assert.equal(r.to, null);
  }
});

test("the one route with a custody gap says so, and the ones without do not pretend to a gap they do not have", () => {
  const bridged = zecRouteById("zcash-to-solana")!;
  assert.equal(bridged.custodyGap, true);
  // The disclosure this drives is the mechanism, not an adjective. The route may NAME Zcash's
  // shielded pool — that is what the pool is called, and web's copy scanner allows the name as a
  // term of art — but it may not describe the trip, or Oilskin, with a quality neither has earned.
  const prose = bridged.steps.join(" ");
  assert.match(prose, /transparent Zcash address that the bridge's signers control/);
  assert.match(prose, /somebody else is holding it/);
  assert.match(prose, /shielded Orchard pool/, "the pool is named, because a user cannot look up a thing we will not name");
  const claimWords = ["safe", "guaranteed", "risk-free", "anonymous", "untraceable", "non-custodial"];
  for (const w of claimWords) {
    assert.doesNotMatch(prose, new RegExp(`\\b${w}\\b`, "i"), `${w} in the bridge route's copy`);
  }
  // "shielded" only ever as part of the pool's name, never on its own about the transfer.
  assert.equal((prose.match(/shielded/gi) ?? []).length, (prose.match(/shielded Orchard pool|shielded pool/gi) ?? []).length);
  assert.doesNotMatch(prose, /\bprivate\b/i);
  for (const r of ZEC_ROUTES) {
    if (r.id === "zcash-to-solana") continue;
    assert.equal(r.custodyGap, false, `${r.id}`);
  }
});

test("no route states a fee, a delay or a size — none of them has been read", () => {
  // CLAUDE.md rule 3. Step Z1 (ZEC-FORMS-AND-DOORS-2026-09-15.md §3.3) is the pass that measures
  // them; until docs/VERIFIED-ZEC-ROUTES-<date>.md exists, BRIDGE_UNVERIFIED is the honest answer
  // and the surface renders it. A percentage or a duration appearing in this table would mean
  // somebody typed a number nobody read.
  for (const r of ZEC_ROUTES) {
    const prose = [r.headline, ...r.steps].join(" ");
    assert.doesNotMatch(prose, /\d+(\.\d+)?\s*%/, `${r.id}: states a percentage`);
    assert.doesNotMatch(prose, /\b\d+(\.\d+)?\s*(seconds?|minutes?|hours?|days?)\b/i, `${r.id}: states a duration`);
    assert.doesNotMatch(prose, /\$\s?\d/, `${r.id}: states an amount`);
  }
  assert.ok(BRIDGE_UNVERIFIED.length >= 5);
  const bridged = zecRouteById("zcash-to-solana")!;
  for (const u of BRIDGE_UNVERIFIED) assert.ok(bridged.unverified.includes(u), u.slice(0, 40));
  // and it inherits the form's own unread questions rather than keeping a second list
  for (const q of ZEC_FORMS["zec-solana-bridged"].openQuestions) assert.ok(bridged.unverified.includes(q), q.slice(0, 40));
});

test("no route implies Oilskin has deployed anything, because it has not", () => {
  // docs/DEPLOYMENTS.md holds no address on any row. The two routes that reach Kamino name the
  // venue as live and the Oilskin program as not deployed, in the same breath, so a reader cannot
  // come away thinking the ladder is running for them today.
  for (const r of ZEC_ROUTES) {
    if (r.outcome !== "reaches-a-lending-venue") continue;
    const prose = r.steps.join(" ");
    assert.match(prose, /is not deployed on Solana/, `${r.id}`);
    assert.match(prose, /ends at the market, not at a running position/, `${r.id}`);
  }
});

test("lookups", () => {
  assert.equal(zecRouteById("zcash-to-solana")?.from, "zcash-address");
  assert.equal(zecRouteById("nope"), undefined);
  assert.equal(zecRouteById("__proto__"), undefined);
  assert.equal(zecRouteById(42), undefined);
  assert.equal(zecRouteForm(zecRouteById("cbzec-on-base")!)?.id, "cbzec-base");
  assert.equal(zecRouteForm(zecRouteById("exchange-to-zcash")!), undefined);
});
