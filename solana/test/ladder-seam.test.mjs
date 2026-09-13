// The Solana ladder seam: the committed generated/ladder.rs must equal what @zyo/shared says, rung for rung.
// Runs with node:test, no Rust toolchain and no validator needed (so CI can run it on every push).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { EMERGENCY_HF_MIN_BPS, ENTRY_HF_FLOOR, HF_HYSTERESIS_MIN_BPS, HF_HYSTERESIS_SCALE_BPS, HF_HYSTERESIS_SPAN_BPS, HF_LADDER, LADDER_RUNG_FACTORS_PCT, LOAN_DUST_UNITS, MIN_LADDER_ENTRY_HF, hysteresisFor } from "@zyo/shared";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "..", "programs", "oilskin", "src", "generated", "ladder.rs"), "utf8");
const constU64 = (name) => {
  const m = rs.match(new RegExp(`pub const ${name}: u64 = (\\d+);`));
  assert.ok(m, `${name} missing from ladder.rs`);
  return Number(m[1]);
};

test("scalar constants match shared, in basis points of 1.0", () => {
  assert.equal(constU64("ENTRY_HF_FLOOR_BPS"), Math.round(ENTRY_HF_FLOOR * 10_000));
  // the floor ladder's hysteresis (hysteresisFor(1.25) = 0.02), not HF_HYSTERESIS, which is only the scale
  assert.equal(constU64("HF_HYSTERESIS_BPS"), Math.round(hysteresisFor(ENTRY_HF_FLOOR) * 10_000));
  assert.ok(!/MAX_OFFERED_LTV_CAP_BPS/.test(rs), "no product-wide LTV cap: the venue's own LTV and the floor are the only ceilings (2026-09-12)");
  assert.equal(constU64("LOAN_DUST_UNITS"), Number(LOAN_DUST_UNITS));
});

test("every rung is present with shared's threshold, disarm and severity, in shared's order", () => {
  HF_LADDER.forEach((r, i) => {
    const re = new RegExp(`pub const RUNG_${r.id.toUpperCase()}: Rung = Rung \\{ id: (\\d+), hf_bps: (\\d+), disarm_hf_bps: (\\d+), severity: (\\d+) \\};`);
    const m = rs.match(re);
    assert.ok(m, `rung ${r.id} missing`);
    assert.equal(Number(m[1]), i, `${r.id} id`);
    assert.equal(Number(m[2]), Math.round(r.hf * 10_000), `${r.id} hf`);
    assert.equal(Number(m[3]), Math.round(r.disarmHf * 10_000), `${r.id} disarm`);
    assert.equal(Number(m[4]), r.severity, `${r.id} severity`);
    assert.ok(rs.includes(`pub const RUNG_ID_${r.id.toUpperCase()}: u8 = ${i};`), `${r.id} id constant`);
  });
  const ladder = rs.match(/pub const LADDER: \[Rung; (\d+)\] = \[([^\]]+)\];/);
  assert.ok(ladder);
  assert.equal(Number(ladder[1]), HF_LADDER.length);
  assert.deepEqual(
    ladder[2].split(",").map((s) => s.trim()),
    HF_LADDER.map((r) => `RUNG_${r.id.toUpperCase()}`)
  );
});

test("the generator's --check agrees (the committed file is exactly what it would write)", () => {
  const outp = execFileSync(process.execPath, [join(here, "..", "scripts", "gen-ladder.mjs"), "--check"], { encoding: "utf8" });
  assert.match(outp, /ladder seam OK/);
});

test("no rung is disarmable below its own threshold, and rungs strictly descend (the shape the keeper relies on)", () => {
  let prev = Infinity;
  const h = hysteresisFor(ENTRY_HF_FLOOR);
  for (const r of HF_LADDER) {
    assert.ok(r.disarmHf > r.hf);
    assert.equal(Math.round((r.disarmHf - r.hf) * 100) / 100, h, `${r.id}: disarm = rung + the floor ladder's hysteresis`);
    assert.ok(r.hf < prev);
    prev = r.hf;
  }
  assert.ok(HF_LADDER[0].hf < ENTRY_HF_FLOOR, "warn must sit below the entry floor");
});

test("the per-position derivation constants are shared's (the program derives each account's ladder from its recorded entry, §14.2)", () => {
  const arr = rs.match(/pub const LADDER_RUNG_FACTORS_PCT: \[u64; (\d+)\] = \[([^\]]+)\];/);
  assert.ok(arr, "LADDER_RUNG_FACTORS_PCT missing");
  assert.equal(Number(arr[1]), LADDER_RUNG_FACTORS_PCT.length);
  assert.deepEqual(arr[2].split(",").map((x) => Number(x.trim())), [...LADDER_RUNG_FACTORS_PCT]);
  assert.equal(constU64("EMERGENCY_HF_MIN_BPS"), EMERGENCY_HF_MIN_BPS);
  assert.equal(constU64("HF_HYSTERESIS_MIN_BPS"), HF_HYSTERESIS_MIN_BPS);
  assert.equal(constU64("HF_HYSTERESIS_SCALE_BPS"), HF_HYSTERESIS_SCALE_BPS);
  assert.equal(constU64("HF_HYSTERESIS_SPAN_BPS"), HF_HYSTERESIS_SPAN_BPS);
  assert.equal(constU64("MIN_LADDER_ENTRY_HF_BPS"), Math.round(MIN_LADDER_ENTRY_HF * 10_000));
});
