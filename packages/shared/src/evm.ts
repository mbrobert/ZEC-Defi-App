/**
 * EVM address validation and normalisation (EIP-55 checksums).
 *
 * Replaces the Zcash address module: on Base the only address shape in the
 * money path is a 20-byte EVM address, and the only "kind" question that
 * matters is "is this the pinned cbZEC or a look-alike" (see base.ts).
 */
import { keccak256Hex } from "./keccak.js";

/** A 0x-prefixed, 40-hex-char EVM address. Checksummed when produced by this module. */
export type Address = `0x${string}`;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shape check only: 0x + 40 hex chars. Says nothing about the checksum. */
export function isHexAddress(value: unknown): value is Address {
  return typeof value === "string" && HEX_ADDRESS.test(value);
}

/**
 * EIP-55 checksum encoding. Throws on anything that is not a 40-hex address.
 * Accepts any casing on input (lowercase, uppercase, or already checksummed).
 */
export function toChecksumAddress(value: string): Address {
  if (!isHexAddress(value)) throw new TypeError(`Not an EVM address: ${String(value)}`);
  const lower = value.slice(2).toLowerCase();
  const hash = keccak256Hex(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i];
    out += parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out as Address;
}

/**
 * True when the value is a 40-hex address whose mixed-case checksum is
 * exactly right. All-lowercase and all-uppercase inputs carry no checksum and
 * return false here — use isValidAddress if you want to accept them.
 */
export function isChecksumAddress(value: string): boolean {
  if (!isHexAddress(value)) return false;
  return toChecksumAddress(value) === value;
}

/**
 * Accepts an address the way wallets and explorers do: all-lowercase or
 * all-uppercase (no checksum to verify) or a correctly checksummed mixed-case
 * string. Rejects mixed case with a WRONG checksum — that is the one shape
 * that indicates a typo or a tampered paste.
 */
export function isValidAddress(value: unknown): value is Address {
  if (!isHexAddress(value)) return false;
  const body = value.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(value) === value;
}

/** Validate (as isValidAddress) and return the checksummed form. Throws otherwise. */
export function normalizeAddress(value: string): Address {
  if (!isValidAddress(value)) {
    throw new TypeError(`Invalid EVM address (shape or checksum): ${String(value)}`);
  }
  return toChecksumAddress(value);
}

/** Case-insensitive equality of two addresses. Non-addresses are never equal to anything. */
export function isSameAddress(a: unknown, b: unknown): boolean {
  if (!isHexAddress(a) || !isHexAddress(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(value: unknown): boolean {
  return isHexAddress(value) && value.toLowerCase() === ZERO_ADDRESS;
}

/** "0x1234…abcd" for UI display. Never use the result as an identifier. */
export function shortAddress(value: string, head = 6, tail = 4): string {
  if (!isHexAddress(value)) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
