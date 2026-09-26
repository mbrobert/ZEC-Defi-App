/**
 * The short's valuation, fail-closed (design §4–§5): the Foundry scene's numbers reproduced value for value
 * (the same reads `protect` judges), every rule P0–P5 refusing by name, and the live read of 2026-09-25 — an
 * account with many positions — refused as the design says it must be.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeAccountMarginSummary, decodePosition, decodePx, decodeSpotBalance, decodeWithdrawable } from "@zyo/shared";
import { evaluatePerps, spotToE6, type PerpsValuationParams } from "../src/perps/valuation.js";
import { A0, A_10, A_20, A_40, D0, ENTRY0, HF0, MARK, MARK_10, MARK_20, MARK_40, NTL, PARAMS, RESERVE0, SZ, rung0, sceneSnapshot } from "./perpsFixtures.js";

const P: PerpsValuationParams = { independentMaxAgeS: 120, oracleDeviationBps: 200, requireIndependent: true };

// docs/research/hyperevm-reads-2026-09-25.json → precompiles.liveZecShort (block 46,887,687)
const LIVE = {
  position: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffebc8000000000000000000000000000000000000000000000000000000128020c7650000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000",
  spot: "0x00000000000000000000000000000000000000000000000000000000093c725e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  withdrawable: "0x0000000000000000000000000000000000000000000000000000015fcd369984",
  summary: "0x00000000000000000000000000000000000000000000000000000792a2960056000000000000000000000000000000000000000000000000000006034d1a8de300000000000000000000000000000000000000000000000000001c5a21b56f9d00000000000000000000000000000000000000000000000000001801297fc037",
  mark: "0x0000000000000000000000000000000000000000000000000000000000ead2e9",
};

describe("evaluatePerps — the Foundry scene, value for value", () => {
  it("the open: 5.00 ZEC against $3,900 at 1538.9417 → distance 4350 bps, equivalent HF 1.7699, the reserve and the entry as recorded", () => {
    const v = evaluatePerps(sceneSnapshot(), P);
    assert.equal(v.kind, "OK");
    if (v.kind !== "OK") return;
    assert.equal(v.distanceBps, D0);
    assert.equal(v.hfBps, HF0);
    assert.equal(v.hf, 1.7699);
    assert.equal(v.ntlE6, NTL);
    assert.equal(v.size, SZ);
    assert.equal(v.szi, -SZ);
    assert.equal(v.spotE6, RESERVE0);
    assert.deepEqual(v.entry, ENTRY0);
    assert.equal(v.independent, true);
    assert.equal(v.mmrBps, 500);
  });

  it("+10 % is inside the top-up rung's band, +20 % the de-risk rung's, +40 % under the close rung — on the account's own ladder", () => {
    const at = (mark: bigint, a: bigint) => {
      const v = evaluatePerps(sceneSnapshot({ mark, a }), P);
      assert.equal(v.kind, "OK");
      return v.kind === "OK" ? v.hfBps : NaN;
    };
    const h10 = at(MARK_10, A_10);
    const h20 = at(MARK_20, A_20);
    const h40 = at(MARK_40, A_40);
    assert.ok(h10 < rung0("repay").hfBps && h10 >= rung0("derisk").hfBps, `+10 %: ${h10}`);
    assert.ok(h20 < rung0("derisk").hfBps && h20 >= rung0("emergency").hfBps, `+20 %: ${h20}`);
    assert.ok(h40 < rung0("emergency").hfBps, `+40 %: ${h40}`);
    assert.ok(at(MARK, A0) >= rung0("warn").hfBps, "the open is above warn");
  });

  it("a wiped account value is a distance of zero and HF 1.00 — every rung fires; it is not UNKNOWN", () => {
    const v = evaluatePerps(sceneSnapshot({ mark: MARK_40, a: -1_000_000n }), P);
    assert.equal(v.kind, "OK");
    if (v.kind === "OK") {
      assert.equal(v.distanceBps, 0);
      assert.equal(v.hfBps, 10_000);
    }
  });
});

describe("evaluatePerps — refusals by name", () => {
  it("P5: the live 2026-09-25 read (0x7717…, −51.76 ZEC on a $31 M book of many positions) is refused as OtherPositionsOpen, exactly as protect would", () => {
    const snap = sceneSnapshot({ independentMark: null });
    snap.position = decodePosition(LIVE.position);
    snap.spot = decodeSpotBalance(LIVE.spot);
    snap.withdrawableE6 = decodeWithdrawable(LIVE.withdrawable);
    snap.summary = decodeAccountMarginSummary(LIVE.summary);
    snap.markRaw = decodePx(LIVE.mark);
    snap.oracleRaw = 15_387_700n;
    assert.equal(snap.position.szi, -5176n);
    assert.equal(snap.markRaw, 15_389_417n);
    const v = evaluatePerps(snap, { ...P, requireIndependent: false });
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") {
      assert.equal(v.reasons.length, 1);
      assert.match(v.reasons[0]!, /P5 .*31173438173085.*OtherPositionsOpen/);
    }
    assert.equal(spotToE6(snap.spot.total, 8, 6), 1_549_563n, "1.54956382 USDC on HyperCore, in 10^6");
  });

  it("P0: a precompile that did not answer is named and nothing else is judged", () => {
    const v = evaluatePerps(sceneSnapshot({ missing: ["position"], readFailures: [{ what: "position(0x800)", reason: "CallExecutionError: execution reverted" }] }), P);
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") {
      assert.equal(v.reasons.length, 1);
      assert.match(v.reasons[0]!, /P0 position\(0x800\) did not answer/);
    }
  });

  it("P1: a venue parameter that moved, or an isolated-only market", () => {
    const moved = evaluatePerps(sceneSnapshot({ assetInfo: { maxLeverage: 5 } }), P);
    assert.equal(moved.kind, "UNKNOWN");
    if (moved.kind === "UNKNOWN") assert.match(moved.reasons.join(";"), /P1 venue parameters moved.*maxLeverage 5.*VenueParamsChanged/);
    const iso = evaluatePerps(sceneSnapshot({ assetInfo: { onlyIsolated: true } }), P);
    assert.equal(iso.kind, "UNKNOWN");
    if (iso.kind === "UNKNOWN") assert.match(iso.reasons.join(";"), /P1 .*isolated-only/);
  });

  it("P2: mark and oracle apart by more than the venue's own bound", () => {
    const v = evaluatePerps(sceneSnapshot({ oracle: (MARK * 9n) / 10n }), P);
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") assert.match(v.reasons.join(";"), /P2 mark .* disagree by 1111 bps .*MarkOracleDeviation/);
    const fine = evaluatePerps(sceneSnapshot({ oracle: (MARK * 96n) / 100n }), P);
    assert.equal(fine.kind, "OK", "4 % is inside the 5 % bound");
  });

  it("P3: the independent mark missing, stale, or off — and not required on a declared testnet", () => {
    const missing = evaluatePerps(sceneSnapshot({ independentMark: null, readFailures: [{ what: "independent mark (test)", reason: "HTTP 503" }] }), P);
    assert.equal(missing.kind, "UNKNOWN");
    if (missing.kind === "UNKNOWN") assert.match(missing.reasons.join(";"), /P3 no independent mark \(HTTP 503\)/);
    const stale = evaluatePerps(sceneSnapshot({ independentAtS: Number(1_789_000_100n) - 121 }), P);
    assert.equal(stale.kind, "UNKNOWN");
    if (stale.kind === "UNKNOWN") assert.match(stale.reasons.join(";"), /P3 .* is 121s old/);
    const off = evaluatePerps(sceneSnapshot({ independentMark: (MARK * 103n) / 100n }), P);
    assert.equal(off.kind, "UNKNOWN");
    if (off.kind === "UNKNOWN") assert.match(off.reasons.join(";"), /P3 independent mark 15851099 \(test\) disagrees with the precompile's 15389417 by 299 bps \(max 200\)/, "3 % as the integer rule floors it");
    const testnet = evaluatePerps(sceneSnapshot({ independentMark: null }), { ...P, requireIndependent: false });
    assert.equal(testnet.kind, "OK");
    if (testnet.kind === "OK") assert.equal(testnet.independent, false);
  });

  it("P4: a long, or an isolated-margined position, is not this product", () => {
    const long = evaluatePerps(sceneSnapshot({ szi: SZ }), P);
    assert.equal(long.kind, "UNKNOWN");
    if (long.kind === "UNKNOWN") assert.match(long.reasons.join(";"), /P4 the position is a LONG of 500/);
    const iso = evaluatePerps(sceneSnapshot({ isolated: true }), P);
    assert.equal(iso.kind, "UNKNOWN");
    if (iso.kind === "UNKNOWN") assert.match(iso.reasons.join(";"), /P4 .*isolated-margined/);
  });

  it("P5: a summary notional that is not this short's — another position shares the account value", () => {
    const v = evaluatePerps(sceneSnapshot({ ntl: NTL * 2n }), P);
    assert.equal(v.kind, "UNKNOWN");
    if (v.kind === "UNKNOWN") assert.match(v.reasons.join(";"), /P5 the account's total notional 15389417000 is not this short's 7694708500/);
    const tol = evaluatePerps(sceneSnapshot({ ntl: NTL + NTL / 10_000n }), P);
    assert.equal(tol.kind, "OK", "inside the venue's own tolerance of a basis point plus one");
  });

  it("NO_POSITION when the size is zero and nothing else is open; UNKNOWN when something else is", () => {
    const none = evaluatePerps(sceneSnapshot({ szi: 0n, ntl: 0n, spotE6: 1_000_000n }), P);
    assert.deepEqual(none, { kind: "NO_POSITION", spotE6: 1_000_000n });
    const other = evaluatePerps(sceneSnapshot({ szi: 0n, ntl: 1_000_000_000n }), P);
    assert.equal(other.kind, "UNKNOWN");
    if (other.kind === "UNKNOWN") assert.match(other.reasons.join(";"), /P5 no 214 position but the account carries 1000000000 of other notional/);
  });

  it("the params the valuation rests on are the venue's immutables, not typed here", () => {
    assert.equal(PARAMS.minEntryDistanceBps, 4285, "L = 2 at mmr 5 %: (0.5 − 0.05) / 1.05 = 42.85 %");
    assert.equal(PARAMS.mmrBps, 500);
  });
});
