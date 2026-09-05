/**
 * Minimal, dependency-free Keccak-256 (the Ethereum flavour: multi-rate
 * padding with domain byte 0x01, NOT SHA3-256's 0x06).
 *
 * Used only for EIP-55 address checksums, so inputs are tiny and the BigInt
 * lane implementation is more than fast enough. Verified against the
 * canonical empty-string vector and the checksummed addresses in
 * docs/VERIFIED-BASE-FACTS.md (see test/evm.test.ts).
 */

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets r[x][y] (x = column, y = row). */
const ROTATION: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1600 - 2*256 bits

function rotl64(v: bigint, n: number): bigint {
  if (n === 0) return v;
  const s = BigInt(n);
  return ((v << s) | (v >> (64n - s))) & MASK64;
}

function keccakF1600(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) a[i] ^= d[i % 5];
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], ROTATION[x][y]);
      }
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
      }
    }
    // iota
    a[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Keccak-256 of raw bytes → 32-byte digest. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state: bigint[] = new Array(25).fill(0n);
  // multi-rate padding: 0x01 ... 0x80
  const padLen = RATE_BYTES - (input.length % RATE_BYTES);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let off = 0; off < padded.length; off += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let v = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        v = (v << 8n) | BigInt(padded[off + lane * 8 + byte]);
      }
      state[lane] ^= v;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let v = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** Keccak-256 of a UTF-8/ASCII string → lowercase hex (no 0x prefix). */
export function keccak256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return Array.from(keccak256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
