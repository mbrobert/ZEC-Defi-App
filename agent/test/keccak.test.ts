import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, selector } from "../src/vendor/keccak.js";

/**
 * Ground truth generated with Foundry's `cast keccak` (production Keccak-256
 * implementation) — includes a >136-byte input to exercise multi-block
 * absorption, which the quote-hashing path relies on.
 */
describe("vendored keccak256", () => {
  it("empty string", () => {
    assert.equal(
      keccak256(""),
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
  });

  it("abc", () => {
    assert.equal(
      keccak256("abc"),
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    );
  });

  it("quick brown fox", () => {
    assert.equal(
      keccak256("The quick brown fox jumps over the lazy dog"),
      "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"
    );
  });

  it("multi-block input (200 bytes, spans two rate blocks)", () => {
    assert.equal(
      keccak256("a".repeat(200)),
      "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"
    );
  });

  it("derives canonical EVM function selectors", () => {
    assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
    assert.equal(selector("balanceOf(address)"), "0x70a08231");
  });
});
