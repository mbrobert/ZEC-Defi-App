/**
 * Circle's Cross-Chain Transfer Protocol (CCTP) V2 — the USDC rail between Solana and Base (BUILD-PLAN D6;
 * `docs/CROSSCHAIN-LOOP-2026-09-12.md` §1; `docs/SOLANA-ARCHITECTURE.md` §14).
 *
 * SOURCE OF TRUTH: docs/VERIFIED-SOLANA-FACTS.md Addendum 1 (2026-09-12 20:10 UTC — the proxies, the fee API,
 * the domain ids) and Addendum 3 (2026-09-13 03:11–03:16 UTC — the implementations, the verified ABIs, the
 * message byte layout, the Solana instruction's accounts and PDAs). Nothing may be added here that is not in
 * that document; anything else is probed on chain first (the rule base.ts and solana.ts follow).
 *
 * Deliberately carries NO fee and NO transfer time as a live number: the fee and the Fast allowance are read
 * from Circle's API at send time by whoever sends (the web for the deploy direction, the keeper for the
 * protective one); the dated snapshot below exists so a test can tell a re-read has drifted, never so code can
 * skip the read.
 */
import type { Address } from "./evm.js";
import type { SolanaAddress } from "./solana.js";

/** CCTP domain ids: the paths of Circle's fee endpoints and `MessageTransmitterV2.localDomain()` on Base. */
export const CCTP_DOMAINS = { solana: 5, base: 6 } as const;
export type CctpDomain = (typeof CCTP_DOMAINS)[keyof typeof CCTP_DOMAINS];

/** `minFinalityThreshold`: 1000 = Fast Transfer (seconds, fee-bearing), 2000 = Standard (source-chain finality, fee 0). */
export const CCTP_FINALITY = { fast: 1000, standard: 2000 } as const;

/** Circle's per-message burn cap on USDC, the same on both chains (Addendum 1 Base, Addendum 3 Solana): 10,000,000 USDC. */
export const CCTP_BURN_LIMIT_PER_MESSAGE_USDC = 10_000_000;

// ---------------------------------------------------------------------------
// Base (chain id 8453) — Addendum 1 for the proxies, Addendum 3 for the implementations and selectors
// ---------------------------------------------------------------------------

export const CCTP_V2_BASE = {
  /** The proxies the router and the keeper call; each is an EIP-1967 `AdminUpgradableProxy` — Circle can upgrade them. */
  tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002",
  /** The implementations behind the first two at block 51,239,874 (verified names `TokenMessengerV2` / `MessageTransmitterV2`). */
  implementations: {
    tokenMessengerV2: "0x555E272506C06e7E559d57418563742AFE363ec8",
    messageTransmitterV2: "0x7Db629f6Acc20Be49a0A7565c21CC178E9Ac21e3",
  },
  /** Circle's fee recipient on the messenger (`feeRecipient()`). */
  feeRecipient: "0xBEA3621Ef88850E062cF4baCCaD72877E2c3e4Eb",
  /** The verified ABI's entry points and events (test/cctp.test.ts recomputes every selector and topic). */
  abi: {
    depositForBurn: "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
    depositForBurnSelector: "0x8e0250ee",
    depositForBurnWithHook: "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
    depositForBurnWithHookSelector: "0x779b432d",
    receiveMessage: "receiveMessage(bytes,bytes)",
    receiveMessageSelector: "0x57ecfd28",
    depositForBurnEvent: "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)",
    messageSentEvent: "MessageSent(bytes)",
    messageReceivedEvent: "MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)",
  },
  messageBodyVersion: 1,
  transmitterVersion: 1,
} as const satisfies {
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  tokenMinterV2: Address;
  implementations: Record<string, Address>;
  feeRecipient: Address;
  abi: Record<string, string>;
  messageBodyVersion: number;
  transmitterVersion: number;
};

// ---------------------------------------------------------------------------
// Solana — Addendum 1 for the programs, Addendum 3 for the seeds and the PDAs read at slot 446,596,935
// ---------------------------------------------------------------------------

export const CCTP_V2_SOLANA = {
  programs: {
    tokenMessengerMinterV2: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    messageTransmitterV2: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  },
  /** PDA seeds from Circle's `deposit_for_burn.rs`; a domain seed is the domain's decimal string. */
  seeds: {
    tokenMessenger: "token_messenger",
    tokenMinter: "token_minter",
    senderAuthority: "sender_authority",
    localToken: "local_token",
    remoteTokenMessenger: "remote_token_messenger",
    denylistAccount: "denylist_account",
    messageTransmitter: "message_transmitter",
    eventAuthority: "__event_authority",
  },
  /** The PDAs as derived and read (owner = the program named; `senderAuthority` has no account — it only signs). */
  pdas: {
    tokenMessenger: "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W",
    tokenMinter: "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux",
    senderAuthority: "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE",
    localTokenUsdc: "CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1",
    remoteTokenMessengerBase: "BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM",
    messageTransmitter: "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU",
  },
  /** `DepositForBurnParams` field order (Borsh), for a hand-built instruction and its seam test. */
  depositForBurnParams: ["amount:u64", "destination_domain:u32", "mint_recipient:pubkey", "destination_caller:pubkey", "max_fee:u64", "min_finality_threshold:u32"],
  /** Anchor's global instruction discriminator input. */
  depositForBurnDiscriminatorPreimage: "global:deposit_for_burn",
} as const satisfies {
  programs: Record<string, SolanaAddress>;
  seeds: Record<string, string>;
  pdas: Record<string, SolanaAddress>;
  depositForBurnParams: readonly string[];
  depositForBurnDiscriminatorPreimage: string;
};

// ---------------------------------------------------------------------------
// The V2 message (Circle's technical guide; Addendum 3) — what `MessageSent` carries and `receiveMessage` takes
// ---------------------------------------------------------------------------

/** Byte offsets of the message header (148 bytes) and the BurnMessageV2 body (228 bytes + hook data). */
export const CCTP_V2_MESSAGE_LAYOUT = {
  header: { version: 0, sourceDomain: 4, destinationDomain: 8, nonce: 12, sender: 44, recipient: 76, destinationCaller: 108, minFinalityThreshold: 140, finalityThresholdExecuted: 144, body: 148 },
  burnBody: { version: 0, burnToken: 4, mintRecipient: 36, amount: 68, messageSender: 100, maxFee: 132, feeExecuted: 164, expirationBlock: 196, hookData: 228 },
  headerLength: 148,
  burnBodyLength: 228,
} as const;

export interface CctpBurnMessageV2 {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Uint8Array;
  sender: Uint8Array;
  recipient: Uint8Array;
  destinationCaller: Uint8Array;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: Uint8Array;
    mintRecipient: Uint8Array;
    amount: bigint;
    messageSender: Uint8Array;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Uint8Array;
  };
}

function u32be(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new RangeError(`u32 out of range: ${String(v)}`);
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
function readU32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}
function u256be(v: bigint): Uint8Array {
  if (typeof v !== "bigint" || v < 0n || v >= 1n << 256n) throw new RangeError(`uint256 out of range: ${String(v)}`);
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function readU256be(b: Uint8Array, o: number): bigint {
  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) + BigInt(b[o + i]!);
  return x;
}
function bytes32(v: Uint8Array, name: string): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return v;
}

/** An EVM address as the 32-byte form CCTP uses (12 zero bytes then the 20 address bytes). */
export function evmAddressToBytes32(address: Address): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new RangeError(`not an EVM address: ${String(address)}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(address.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

/** The inverse, refusing a value whose first 12 bytes are not zero (it is not an EVM address then). */
export function bytes32ToEvmAddress(b: Uint8Array): Address {
  bytes32(b, "value");
  for (let i = 0; i < 12; i++) if (b[i] !== 0) throw new RangeError("not a left-padded EVM address");
  return ("0x" + Array.from(b.subarray(12), (x) => x.toString(16).padStart(2, "0")).join("")) as Address;
}

/** Encode a V2 burn message byte for byte as the layout above (what the Base mock and Stream C's tests build). */
export function encodeCctpBurnMessageV2(m: CctpBurnMessageV2): Uint8Array {
  const L = CCTP_V2_MESSAGE_LAYOUT;
  const out = new Uint8Array(L.headerLength + L.burnBodyLength + m.body.hookData.length);
  out.set(u32be(m.version), L.header.version);
  out.set(u32be(m.sourceDomain), L.header.sourceDomain);
  out.set(u32be(m.destinationDomain), L.header.destinationDomain);
  out.set(bytes32(m.nonce, "nonce"), L.header.nonce);
  out.set(bytes32(m.sender, "sender"), L.header.sender);
  out.set(bytes32(m.recipient, "recipient"), L.header.recipient);
  out.set(bytes32(m.destinationCaller, "destinationCaller"), L.header.destinationCaller);
  out.set(u32be(m.minFinalityThreshold), L.header.minFinalityThreshold);
  out.set(u32be(m.finalityThresholdExecuted), L.header.finalityThresholdExecuted);
  const o = L.header.body;
  out.set(u32be(m.body.version), o + L.burnBody.version);
  out.set(bytes32(m.body.burnToken, "burnToken"), o + L.burnBody.burnToken);
  out.set(bytes32(m.body.mintRecipient, "mintRecipient"), o + L.burnBody.mintRecipient);
  out.set(u256be(m.body.amount), o + L.burnBody.amount);
  out.set(bytes32(m.body.messageSender, "messageSender"), o + L.burnBody.messageSender);
  out.set(u256be(m.body.maxFee), o + L.burnBody.maxFee);
  out.set(u256be(m.body.feeExecuted), o + L.burnBody.feeExecuted);
  out.set(u256be(m.body.expirationBlock), o + L.burnBody.expirationBlock);
  out.set(m.body.hookData, o + L.burnBody.hookData);
  return out;
}

/** Decode a V2 burn message; refuses a message shorter than header + body or whose versions are not the pinned 1. */
export function decodeCctpBurnMessageV2(bytes: Uint8Array): CctpBurnMessageV2 {
  const L = CCTP_V2_MESSAGE_LAYOUT;
  if (!(bytes instanceof Uint8Array) || bytes.length < L.headerLength + L.burnBodyLength) {
    throw new RangeError(`CCTP burn message too short: ${bytes?.length ?? "?"} bytes`);
  }
  const o = L.header.body;
  const m: CctpBurnMessageV2 = {
    version: readU32be(bytes, L.header.version),
    sourceDomain: readU32be(bytes, L.header.sourceDomain),
    destinationDomain: readU32be(bytes, L.header.destinationDomain),
    nonce: bytes.slice(L.header.nonce, L.header.nonce + 32),
    sender: bytes.slice(L.header.sender, L.header.sender + 32),
    recipient: bytes.slice(L.header.recipient, L.header.recipient + 32),
    destinationCaller: bytes.slice(L.header.destinationCaller, L.header.destinationCaller + 32),
    minFinalityThreshold: readU32be(bytes, L.header.minFinalityThreshold),
    finalityThresholdExecuted: readU32be(bytes, L.header.finalityThresholdExecuted),
    body: {
      version: readU32be(bytes, o + L.burnBody.version),
      burnToken: bytes.slice(o + L.burnBody.burnToken, o + L.burnBody.burnToken + 32),
      mintRecipient: bytes.slice(o + L.burnBody.mintRecipient, o + L.burnBody.mintRecipient + 32),
      amount: readU256be(bytes, o + L.burnBody.amount),
      messageSender: bytes.slice(o + L.burnBody.messageSender, o + L.burnBody.messageSender + 32),
      maxFee: readU256be(bytes, o + L.burnBody.maxFee),
      feeExecuted: readU256be(bytes, o + L.burnBody.feeExecuted),
      expirationBlock: readU256be(bytes, o + L.burnBody.expirationBlock),
      hookData: bytes.slice(o + L.burnBody.hookData),
    },
  };
  if (m.version !== CCTP_V2_BASE.transmitterVersion || m.body.version !== CCTP_V2_BASE.messageBodyVersion) {
    throw new RangeError(`CCTP message version ${m.version}/${m.body.version} is not the pinned V2 (1/1)`);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Dated snapshot of Circle's fee API (Addendum 1) — for drift tests, never for a live number
// ---------------------------------------------------------------------------

export const CCTP_FEES_2026_09_12 = {
  readIso: "2026-09-12T20:10:38Z",
  /** `/v2/burn/USDC/fees/5/6`: the Fast Transfer minimum fee Solana → Base, in basis points; Standard is 0. */
  solanaToBaseFastMinFeeBps: 1,
  /** `/v2/burn/USDC/fees/6/5`: Base → Solana. */
  baseToSolanaFastMinFeeBps: 1.3,
  /** `/v2/fastBurn/USDC/allowance`: one pool shared by every Fast route, USD. */
  fastBurnAllowanceUsd: 53_140_871.26,
} as const;
