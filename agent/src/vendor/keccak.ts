/**
 * Minimal pure-TypeScript Keccak-256 (the Ethereum variant, NOT NIST SHA3).
 *
 * Vendored because this agent is zero-dependency by design (and Node's
 * crypto exposes only NIST SHA3, whose padding differs). BigInt lanes keep
 * the code obviously-correct rather than fast; the agent hashes tiny inputs
 * (quote JSONs, ABI signatures) so performance is irrelevant.
 *
 * Verified in test/keccak.test.ts against the classic vectors and the
 * canonical Ethereum function selectors (transfer → 0xa9059cbb, …).
 */

const ROUNDS = 24;

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y].
const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
  const nn = BigInt(n % 64);
  return ((x << nn) | (x >> (64n - nn))) & MASK64;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < ROUNDS; round++) {
    // θ
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= d;
    }

    // ρ and π
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      }
    }

    // χ
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
      }
    }

    // ι
    state[0] ^= RC[round];
  }
}

/** Keccak-256 of raw bytes. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rate = 136; // bytes; capacity 512 bits → rate 1088 bits
  const state: bigint[] = new Array(25).fill(0n);

  // Padding: Keccak (0x01 … 0x80), not SHA3 (0x06 … 0x80).
  const padLen = rate - (input.length % rate);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        lane = (lane << 8n) | BigInt(padded[off + i * 8 + byte]);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let byte = 0; byte < 8; byte++) {
      out[i * 8 + byte] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

/** Keccak-256 of a UTF-8 string, hex-encoded. */
export function keccak256(input: string | Uint8Array): `0x${string}` {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(keccak256Bytes(bytes));
}

/** First 4 bytes of keccak256(signature) — an EVM function selector. */
export function selector(signature: string): `0x${string}` {
  return keccak256(signature).slice(0, 10) as `0x${string}`;
}
