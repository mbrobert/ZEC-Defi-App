// The Solana ladder seam: the committed generated/ladder.rs must equal what @zyo/shared says, rung for rung.
// Runs with node:test, no Rust toolchain and no validator needed (so CI can run it on every push).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ENTRY_HF_FLOOR, HF_HYSTERESIS, HF_LADDER, MAX_OFFERED_LTV_CAP_BPS, LOAN_DUST_UNITS } from "@zyo/shared";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "..", "programs", "oilskin", "src", "generated", "ladder.rs"), "utf8");
const constU64 = (name) => {
  const m = rs.match(new RegExp(`pub const ${name}: u64 = (\\d+);`));
  assert.ok(m, `${name} missing from ladder.rs`);
  return Number(m[1]);
};

test("scalar constants match shared, in basis points of 1.0", () => {
  assert.equal(constU64("ENTRY_HF_FLOOR_BPS"), Math.round(ENTRY_HF_FLOOR * 10_000));
  assert.equal(constU64("HF_HYSTERESIS_BPS"), Math.round(HF_HYSTERESIS * 10_000));
  assert.equal(constU64("MAX_OFFERED_LTV_CAP_BPS"), MAX_OFFERED_LTV_CAP_BPS);
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
  for (const r of HF_LADDER) {
    assert.ok(r.disarmHf > r.hf);
    assert.ok(r.hf < prev);
    prev = r.hf;
  }
  assert.ok(HF_LADDER[0].hf < ENTRY_HF_FLOOR, "warn must sit below the entry floor");
});
