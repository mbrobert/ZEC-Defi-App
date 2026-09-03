import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyZcashAddress,
  describeZcashAddress,
  isValidTransparentAddress,
  sha256,
  sha256HexUtf8,
} from "@zyo/shared";

/**
 * S-01: the pure-TS SHA-256 and the real Base58Check transparent-address
 * validation in @zyo/shared (shared has no test runner of its own — the
 * agent suite hosts these vectors).
 */

// GENERATED TEST VECTOR (not a real wallet): hash160 =
// sha256("oilskin-test-vector-1")[0..20] = 1e5d10fb5a58438245527090e1c376a3c55c3959,
// prefix 0x1CB8 (t1), valid double-SHA256 checksum.
const VALID_T1 = "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX";
// The OLD fixture used across the agent tests until 2026-09-02 — it matches
// the t-addr SHAPE but its checksum is invalid. It must now be rejected.
const OLD_INVALID_FIXTURE = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";
// Real-shape P2SH (t3) with a valid checksum.
const VALID_T3 = "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd";

describe("sha256 (pure TS)", () => {
  it("matches the canonical NIST vectors", () => {
    assert.equal(
      sha256HexUtf8(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert.equal(
      sha256HexUtf8("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert.equal(
      sha256HexUtf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  it("handles multi-block messages and the padding boundary (55/56/64 bytes)", () => {
    // 56 bytes forces the length words into a second block.
    assert.equal(
      sha256HexUtf8("a".repeat(56)),
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
    );
    // 1,000,000 × "a" — the classic long vector.
    const million = new Uint8Array(1_000_000).fill(0x61);
    const hex = Array.from(sha256(million))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(hex, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });
});

describe("Base58Check transparent-address validation", () => {
  it("accepts checksum-valid t1 and t3 addresses", () => {
    assert.equal(isValidTransparentAddress(VALID_T1), true);
    assert.equal(isValidTransparentAddress(VALID_T3), true);
    assert.equal(classifyZcashAddress(VALID_T1), "transparent");
    assert.equal(classifyZcashAddress(VALID_T3), "transparent");
    assert.equal(describeZcashAddress(VALID_T1).settleable, true);
  });

  it("REJECTS the old checksum-invalid fixture the shape-only regex accepted", () => {
    assert.equal(isValidTransparentAddress(OLD_INVALID_FIXTURE), false);
    assert.equal(classifyZcashAddress(OLD_INVALID_FIXTURE), "invalid");
    assert.equal(describeZcashAddress(OLD_INVALID_FIXTURE).settleable, false);
  });

  it("a single-character typo breaks the checksum", () => {
    const typo = VALID_T1.slice(0, -1) + (VALID_T1.endsWith("X") ? "Y" : "X");
    assert.equal(classifyZcashAddress(typo), "invalid");
  });

  it("non-base58 characters (0, O, I, l) are rejected outright", () => {
    assert.equal(classifyZcashAddress("t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH50l"), "invalid");
    assert.equal(isValidTransparentAddress("t1" + "O".repeat(33)), false);
  });

  it("wrong version prefixes fail even with a self-consistent checksum shape", () => {
    // A Bitcoin P2PKH (prefix 0x00) has a valid Base58Check checksum but the
    // wrong version bytes and length for Zcash.
    assert.equal(isValidTransparentAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), false);
  });

  it("classification trims and returns the SAME normalized string for downstream use", () => {
    const padded = `  ${VALID_T1}\n`;
    const info = describeZcashAddress(padded);
    assert.equal(info.kind, "transparent");
    assert.equal(info.normalized, VALID_T1); // exactly the validated string
  });

  it("unified and sapling classification is unchanged (settleable: false)", () => {
    const unified =
      "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkyy00c7qqfqfqhqvxr0pmw6snjrg";
    assert.equal(classifyZcashAddress(unified), "unified");
    assert.equal(describeZcashAddress(unified).settleable, false);
  });
});
