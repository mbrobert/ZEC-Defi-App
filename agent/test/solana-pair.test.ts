/**
 * The cross-chain pair rule and the bridge decision (BUILD-PLAN D6 / A5.2; SOLANA-ARCHITECTURE §14.7), pure:
 * a Solana Account and a Base account are a pair only when each names the other; rung 2 stays on Solana; rungs
 * 3–4 go over the bridge for a linked pair with a burner and no burn in flight, and fall back past the stall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { evmAddressToBytes32 } from "@zyo/shared";
import { PK, ata } from "../src/solana/layouts.js";
import { baseAccountOf, bridgeDecision, expectedRecipientOf, pairStatus, unreadPair } from "../src/solana/pair.js";

const BASE = "0x1646587E543bC2f63137bAa86F8598E1274aED78" as const;
const view = (baseAccount: Uint8Array) => ({ baseAccount });
const hex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

test("baseAccountOf: a left-padded EVM address decodes; zero and a non-padded value are 'not linked'", () => {
  assert.equal(baseAccountOf(view(evmAddressToBytes32(BASE)))!.toLowerCase(), BASE.toLowerCase());
  assert.equal(baseAccountOf(view(new Uint8Array(32))), null);
  assert.equal(baseAccountOf(view(new Uint8Array(32).fill(1))), null, "not an EVM address");
  assert.equal(baseAccountOf(view(new Uint8Array(31))), null);
});

test("expectedRecipientOf is the Account's USDC associated token account as bytes32 — what the Base router must record", () => {
  const account = Keypair.generate().publicKey;
  assert.equal(expectedRecipientOf(account), hex(ata(account, PK.usdcMint).toBytes()));
  assert.notEqual(expectedRecipientOf(account), hex(account.toBytes()), "the token account, not the PDA");
});

test("pairStatus: linked only when both sides name each other; every other shape is named", () => {
  const account = Keypair.generate().publicKey;
  const mine = expectedRecipientOf(account);
  const other = hex(new Uint8Array(32).fill(9));
  const zero = hex(new Uint8Array(32));
  assert.equal(pairStatus(BASE, mine, mine), "linked");
  assert.equal(pairStatus(BASE, mine.toUpperCase() as `0x${string}`, mine), "linked", "case-insensitive");
  assert.equal(pairStatus(BASE, other, mine), "half-linked-solana", "Solana names Base, Base names someone else");
  assert.equal(pairStatus(BASE, zero, mine), "half-linked-solana", "Solana names Base, Base records nothing");
  assert.equal(pairStatus(BASE, null, mine), "unknown", "Solana names Base, Base was not read");
  assert.equal(pairStatus(null, mine, mine), "half-linked-base", "Base names this Account, Solana names no one");
  assert.equal(pairStatus(null, zero, mine), "unlinked");
  assert.equal(pairStatus(null, null, mine), "unlinked");
  const u = unreadPair(account, { baseAccount: evmAddressToBytes32(BASE) } as never);
  assert.equal(u.status, "unknown");
  assert.equal(u.baseAccount!.toLowerCase(), BASE.toLowerCase());
  assert.equal(unreadPair(account, { baseAccount: new Uint8Array(32) } as never).status, "unlinked");
});

test("bridgeDecision: rung 2 stays on Solana; rungs 3–4 bridge for a linked pair with a burner; in flight → wait inside the stall window, single-chain past it; anything else single-chain", () => {
  const base = { status: "linked" as const, burnerAvailable: true, inFlightAgeS: null, stallS: 1800, idleCoversNeed: false };
  assert.equal(bridgeDecision({ ...base, action: "repay" }).route, "solana");
  assert.equal(bridgeDecision({ ...base, action: "notify" }).route, "solana");
  assert.equal(bridgeDecision({ ...base, action: "derisk" }).route, "bridge");
  assert.equal(bridgeDecision({ ...base, action: "emergency-unwind" }).route, "bridge");
  assert.equal(bridgeDecision({ ...base, action: "derisk", status: "half-linked-solana" }).route, "solana");
  assert.equal(bridgeDecision({ ...base, action: "derisk", status: "unknown" }).route, "solana");
  assert.equal(bridgeDecision({ ...base, action: "derisk", burnerAvailable: false }).route, "solana");
  assert.equal(bridgeDecision({ ...base, action: "derisk", inFlightAgeS: 60 }).route, "wait");
  assert.equal(bridgeDecision({ ...base, action: "emergency-unwind", inFlightAgeS: 1799 }).route, "wait");
  assert.equal(bridgeDecision({ ...base, action: "emergency-unwind", inFlightAgeS: 1800 }).route, "solana", "past the stall window the sale path takes over");
  for (const d of [bridgeDecision({ ...base, action: "derisk" }), bridgeDecision({ ...base, action: "derisk", inFlightAgeS: 5 })]) assert.ok(d.reason.length > 20);
});

test("the idle USDC decides first: once a delivery has landed, the same rung is answered on Solana — which is what ends the five-step sequence instead of burning a second time", () => {
  const linked = { status: "linked" as const, burnerAvailable: true, inFlightAgeS: null, stallS: 1800 };
  // Before the delivery: nothing on Solana can pay, so the Base leg is closed.
  assert.equal(bridgeDecision({ ...linked, action: "derisk", idleCoversNeed: false }).route, "bridge");
  assert.equal(bridgeDecision({ ...linked, action: "emergency-unwind", idleCoversNeed: false }).route, "bridge");
  // After it: the Account holds what arrived, so the rung is a repay and nothing crosses a chain again.
  for (const action of ["derisk", "emergency-unwind"]) {
    const d = bridgeDecision({ ...linked, action, idleCoversNeed: true });
    assert.equal(d.route, "solana", action);
    assert.match(d.reason, /reaches the disarm level/);
  }
  // It outranks even a burn in flight: there is no reason to wait for USDC that is already here.
  assert.equal(bridgeDecision({ ...linked, action: "derisk", idleCoversNeed: true, inFlightAgeS: 30 }).route, "solana");
});
