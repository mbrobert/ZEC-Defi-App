/**
 * Word-level ABI helpers (same discipline as agent/src/services/chain.ts:
 * scoped to exactly the shapes this service decodes — no general ABI lib).
 *
 * No runtime keccak: every selector and event topic this service uses is a
 * PRECOMPUTED constant with recorded provenance (see engine/events.ts). The
 * hashes were produced by agent/src/vendor/keccak.ts, which is test-verified
 * against the canonical Ethereum vectors.
 */

import type { Address, Hex } from "./types.js";

export function word(data: string, i: number): string {
  return data.slice(i * 64, (i + 1) * 64);
}

export function wordToBigint(w: string): bigint {
  return BigInt(`0x${w || "0"}`);
}

export function wordToAddress(w: string): Address {
  return `0x${w.slice(24)}`.toLowerCase() as Address;
}

export function wordToBool(w: string): boolean {
  return wordToBigint(w) === 1n;
}

/** Two's-complement int24 from a 32-byte word. */
export function wordToInt24(w: string): number {
  const v = Number(wordToBigint(w) & 0xffffffn);
  return v >= 0x800000 ? v - 0x1000000 : v;
}

export function topicToAddress(t: Hex): Address {
  return `0x${t.slice(26)}`.toLowerCase() as Address;
}

export function topicToBigint(t: Hex): bigint {
  return BigInt(t);
}

export function strip0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

export function encodeUint256(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

/**
 * Verified function selectors on the engine vault. Provenance: signatures
 * from contracts/src/interfaces/ISnuggleVault.sol (extracted from the
 * VERIFIED implementation 0x359f90ee4c2e21cbf6e32c5a062eeef306822d28 on
 * base.blockscout.com); hashes computed with the test-verified vendored
 * keccak, 2026-08-27. ownerOf/name/symbol/totalSupply double-check the
 * hasher against canonical ERC-721 selectors.
 */
export const SEL = {
  positions: "0x99fbab88",
  approvedPools: "0x35d75781",
  poolIdsCount: "0x3fd37a6a",
  poolIds: "0x69883b4e",
  userPositions: "0x613cf420",
} as const;

/** Canonical ERC-20/721 Transfer topic0 (keccak "Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Decode the engine's `positions(uint256)` return (17-word static tuple —
 * layout from the verified source, mirrored in ISnuggleVault.sol).
 */
export interface EnginePositionState {
  tokenId: bigint;
  poolId: Hex;
  owner: Address;
  rangeWidthBps: number;
  currentTickLower: number;
  currentTickUpper: number;
  autoSnuggleEnabled: boolean;
  autoCompoundEnabled: boolean;
  rebalanceDelay: bigint;
  outOfRangeSince: bigint;
  totalRebalances: number;
  lastRebalanceTime: number;
  depositTimestamp: bigint;
  cumulativeFees0: bigint;
  cumulativeFees1: bigint;
  cumulativeRewards: bigint;
}

export function decodePositions(raw: string): EnginePositionState {
  const w = (i: number) => word(raw, i);
  return {
    tokenId: wordToBigint(w(0)),
    poolId: `0x${w(1)}` as Hex,
    owner: wordToAddress(w(2)),
    rangeWidthBps: Number(wordToBigint(w(3))),
    currentTickLower: wordToInt24(w(4)),
    currentTickUpper: wordToInt24(w(5)),
    autoSnuggleEnabled: wordToBool(w(6)),
    autoCompoundEnabled: wordToBool(w(7)),
    rebalanceDelay: wordToBigint(w(8)),
    outOfRangeSince: wordToBigint(w(9)),
    totalRebalances: Number(wordToBigint(w(10))),
    lastRebalanceTime: Number(wordToBigint(w(11))),
    depositTimestamp: wordToBigint(w(12)),
    cumulativeFees0: wordToBigint(w(13)),
    cumulativeFees1: wordToBigint(w(14)),
    cumulativeRewards: wordToBigint(w(15)),
  };
}
