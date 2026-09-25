/**
 * The Solana keeper's configuration — the cross-chain knobs added 2026-09-25 (the Fast-versus-Standard
 * policy the Base burner applies), validated by name like every other variable, with the shared defaults
 * when unset, and never a secret in the loggable description.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { CCTP_FINALITY_POLICY_DEFAULTS } from "@zyo/shared";
import { ConfigError } from "../src/config.js";
import { describeSolanaConfig, loadSolanaConfig } from "../src/solana/config.js";

const BASE_ENV = {
  OILSKIN_SOLANA_PROGRAM_ID: Keypair.generate().publicKey.toBase58(),
  SOLANA_STORE_PATH: "/var/tmp/oilskin-solana-store.json",
  SOLANA_SIM_PAYER: Keypair.generate().publicKey.toBase58(),
};

describe("the Solana keeper config — the CCTP finality policy", () => {
  it("defaults to the shared policy when nothing is set, and the description carries it", () => {
    const c = loadSolanaConfig({ ...BASE_ENV });
    assert.deepEqual(c.cctpFinality, CCTP_FINALITY_POLICY_DEFAULTS);
    assert.deepEqual(describeSolanaConfig(c).cctpFinality, CCTP_FINALITY_POLICY_DEFAULTS);
  });

  it("each knob is read by name", () => {
    const c = loadSolanaConfig({ ...BASE_ENV, CCTP_MAX_FAST_FEE_BPS: "25", CCTP_FEE_HEADROOM_PCT: "100", CCTP_ALLOWANCE_HEADROOM_PCT: "25", CCTP_ALLOWANCE_MAX_AGE_S: "120" });
    assert.deepEqual(c.cctpFinality, { maxFastFeeBps: 25, feeHeadroomPct: 100, allowanceHeadroomPct: 25, allowanceMaxAgeS: 120 });
  });

  it("a bad value is refused by the variable's name: a fractional ceiling, a ceiling of a whole amount, negative headroom, an allowance headroom of 100 %, a zero age", () => {
    const bad = (over: Record<string, string>, re: RegExp) => assert.throws(() => loadSolanaConfig({ ...BASE_ENV, ...over }), (e: unknown) => e instanceof ConfigError && re.test(e.message));
    bad({ CCTP_MAX_FAST_FEE_BPS: "1.5" }, /CCTP_MAX_FAST_FEE_BPS.*integer/);
    bad({ CCTP_MAX_FAST_FEE_BPS: "10000" }, /CCTP_MAX_FAST_FEE_BPS.*≤ 9999/);
    bad({ CCTP_FEE_HEADROOM_PCT: "-1" }, /CCTP_FEE_HEADROOM_PCT.*≥ 0/);
    bad({ CCTP_ALLOWANCE_HEADROOM_PCT: "100" }, /CCTP_ALLOWANCE_HEADROOM_PCT.*≤ 99/);
    bad({ CCTP_ALLOWANCE_MAX_AGE_S: "0" }, /CCTP_ALLOWANCE_MAX_AGE_S.*≥ 1/);
    bad({ CCTP_ALLOWANCE_MAX_AGE_S: "abc" }, /CCTP_ALLOWANCE_MAX_AGE_S.*number/);
  });
});
