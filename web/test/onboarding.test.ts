import { test } from "node:test";
import assert from "node:assert/strict";
import { CBZEC_ADDRESS, classifyCbZecAddress, isCounterfeitCbZec } from "@zyo/shared";
import { CBZEC_V1_CAPABILITIES, COUNTRY_OPTIONS, EXCLUDED_REGIONS, ONBOARD_STEPS, US_STATES, cbZecEligibility } from "../lib/onboarding";

test("jurisdiction: US ex-NY eligible, NY excluded, state required", () => {
  assert.equal(cbZecEligibility("US", "TX").status, "eligible");
  assert.equal(cbZecEligibility("US", "CA").status, "eligible");
  assert.equal(cbZecEligibility("US", "NY").status, "excluded");
  assert.equal(cbZecEligibility("US").status, "unknown");
});

test("jurisdiction: published exclusions are excluded, UK unverified, elsewhere unknown", () => {
  for (const c of ["EEA", "CA", "AU", "BR", "SG", "JP"]) assert.equal(cbZecEligibility(c).status, "excluded", c);
  assert.equal(cbZecEligibility("GB").status, "unverified");
  assert.equal(cbZecEligibility("OTHER").status, "unknown");
  assert.equal(cbZecEligibility("").status, "unknown");
});

test("every country option has a defined outcome and NY is in the state list", () => {
  for (const c of COUNTRY_OPTIONS) assert.ok(["eligible", "excluded", "unverified", "unknown"].includes(cbZecEligibility(c.code, c.code === "US" ? "TX" : undefined).status));
  assert.ok(US_STATES.some((s) => s.code === "NY"));
  assert.equal(US_STATES.length, 51);
  assert.ok(EXCLUDED_REGIONS.some((r) => r.code === "US-NY"));
});

test("three steps, each stating KYC / transparent-only / issuer-power facts where they belong", () => {
  assert.equal(ONBOARD_STEPS.length, 3);
  const all = ONBOARD_STEPS.flatMap((s) => [s.title, s.body, ...s.facts]).join(" ");
  assert.match(all, /KYC/);
  assert.match(all, /transparent/i);
  assert.match(all, /Send ZEC on Base/);
  assert.match(all, /rebase|multiplier/i);
  assert.match(all, /unpublished/i);
});

test("v1 capabilities never claim more than the code enforces", () => {
  assert.equal(CBZEC_V1_CAPABILITIES.spot.available, true);
  assert.equal(CBZEC_V1_CAPABILITIES.lp.available, false);
  assert.equal(CBZEC_V1_CAPABILITIES.collateral.available, false);
});

test("counterfeit classifier (shared) behaves as the onboarding card expects", () => {
  assert.equal(classifyCbZecAddress(CBZEC_ADDRESS), "genuine");
  assert.equal(classifyCbZecAddress(CBZEC_ADDRESS.toLowerCase()), "genuine");
  assert.equal(classifyCbZecAddress("0xb2000000000000000000008501b13360000cb2ed"), "counterfeit");
  assert.equal(classifyCbZecAddress("0xB20000000000000000000000000000000000dead"), "counterfeit");
  assert.equal(isCounterfeitCbZec("0xb2000123456789012345678901234567890123ab"), true);
  assert.equal(classifyCbZecAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"), "unrelated");
  assert.equal(classifyCbZecAddress("0xb2000"), "invalid");
  assert.equal(classifyCbZecAddress(""), "invalid");
});
