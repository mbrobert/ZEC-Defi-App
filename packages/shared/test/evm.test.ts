import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keccak256Hex,
  toChecksumAddress,
  isChecksumAddress,
  isValidAddress,
  isHexAddress,
  normalizeAddress,
  isSameAddress,
  isZeroAddress,
  ZERO_ADDRESS,
  shortAddress,
} from "../dist/index.js";

test("keccak256 matches the canonical vectors", () => {
  assert.equal(keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // > one rate block (136 bytes) to exercise multi-block absorption
  const long = "a".repeat(200);
  assert.equal(keccak256Hex(long).length, 64);
  assert.notEqual(keccak256Hex(long), keccak256Hex("a".repeat(199)));
});

test("toChecksumAddress reproduces EIP-55 for known Base addresses from any casing", () => {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.equal(toChecksumAddress(usdc.toLowerCase()), usdc);
  assert.equal(toChecksumAddress(usdc.toUpperCase().replace("0X", "0x")), usdc);
  assert.equal(toChecksumAddress(usdc), usdc);
  const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  assert.equal(toChecksumAddress(permit2.toLowerCase()), permit2);
  const cbzec = "0xB2000000000000000000008501b13360000cb2EC";
  assert.equal(toChecksumAddress(cbzec.toLowerCase()), cbzec);
  // EIP-55 reference vector
  assert.equal(
    toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"),
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  );
});

test("toChecksumAddress throws on non-addresses", () => {
  for (const bad of ["", "0x", "0x1234", "833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xZZ3589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 42, null]) {
    assert.throws(() => toChecksumAddress(bad as string), TypeError);
  }
});

test("isChecksumAddress / isValidAddress distinguish wrong-checksum mixed case", () => {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.equal(isChecksumAddress(usdc), true);
  assert.equal(isChecksumAddress(usdc.toLowerCase()), false);
  assert.equal(isValidAddress(usdc), true);
  assert.equal(isValidAddress(usdc.toLowerCase()), true);
  assert.equal(isValidAddress("0x" + usdc.slice(2).toUpperCase()), true);
  // flip one letter's case → wrong checksum → rejected
  const i = usdc.search(/[a-fA-F]/); // first letter (digits have no case)
  const flipped = usdc[i] === usdc[i].toUpperCase() ? usdc[i].toLowerCase() : usdc[i].toUpperCase();
  const tampered = usdc.slice(0, i) + flipped + usdc.slice(i + 1);
  assert.notEqual(tampered, usdc);
  assert.equal(isValidAddress(tampered), false);
  assert.throws(() => normalizeAddress(tampered), TypeError);
  assert.equal(normalizeAddress(usdc.toLowerCase()), usdc);
  assert.equal(isHexAddress(usdc), true);
  assert.equal(isHexAddress("0x00"), false);
});

test("isSameAddress is case-insensitive and never matches non-addresses", () => {
  const a = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  assert.equal(isSameAddress(a, a.toLowerCase()), true);
  assert.equal(isSameAddress(a, "0x4200000000000000000000000000000000000006"), false);
  assert.equal(isSameAddress(a, "not-an-address"), false);
  assert.equal(isSameAddress(undefined, undefined), false);
});

test("zero address and short display", () => {
  assert.equal(isZeroAddress(ZERO_ADDRESS), true);
  assert.equal(isZeroAddress("0x0000000000000000000000000000000000000001"), false);
  assert.equal(shortAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), "0x8335…2913");
  assert.equal(shortAddress("nope"), "nope");
});
