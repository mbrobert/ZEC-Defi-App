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

// ---------------------------------------------------------------------------
// The receive side on Solana (BUILD-PLAN D6 / Stream C) — Addendum 4, read 2026-09-13
// ---------------------------------------------------------------------------

/**
 * What `MessageTransmitterV2.receive_message` and the token messenger's `handle_receive_*` need on Solana,
 * beyond the send-side accounts above. Seeds are Circle's (`receive_message.rs`,
 * `handle_receive_finalized_message.rs`); every address was derived with them and read at slot 446,728,203.
 *
 * `usedNonce` is per message (`["used_nonce", <the message's 32-byte nonce>]`) and is CREATED by the delivery —
 * its absence is what makes a delivery possible and its presence is what makes a replay impossible, so the
 * keeper reads it to tell "not delivered yet" from "already delivered by someone else".
 */
export const CCTP_V2_SOLANA_RECEIVE = {
  seeds: {
    messageTransmitterAuthority: "message_transmitter_authority",
    usedNonce: "used_nonce",
    tokenPair: "token_pair",
    custody: "custody",
  },
  pdas: {
    /** `["message_transmitter_authority", TokenMessengerMinterV2]` of the transmitter — signs the handler CPI. */
    messageTransmitterAuthority: "DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up",
    /** `["token_pair", "6", <Base USDC as bytes32>]` — proves Base USDC maps to this chain's USDC. */
    tokenPairBaseUsdc: "3udrkuozTYGBVMyMdxmXWVTUrnpmSh7kEZiq67A8jTws",
    /** `["custody", USDC mint]` — a TOKEN ACCOUNT the mint is paid out of; not a mint authority. */
    custodyUsdc: "6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L",
    /** Circle's fee recipient and its USDC associated token account (the handler pays the fee there). */
    feeRecipient: "4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56",
    feeRecipientUsdcAta: "6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3",
    /** Anchor `#[event_cpi]` authorities of the two programs. */
    messageTransmitterEventAuthority: "2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV",
    tokenMessengerEventAuthority: "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd",
  },
  /** `ReceiveMessageParams` (Borsh, in Circle's order). */
  receiveMessageParams: ["message:bytes", "attestation:bytes"],
  receiveMessageDiscriminatorPreimage: "global:receive_message",
  /** The handler the transmitter CPIs into; which one depends on `finalityThresholdExecuted`. */
  handlerDiscriminatorPreimages: {
    finalized: "global:handle_receive_finalized_message",
    unfinalized: "global:handle_receive_unfinalized_message",
  },
  /** Circle's own boundary: below this the message is delivered through the UNFINALIZED handler. */
  finalizedThreshold: 2000,
  /** `token_messenger.message_body_version` / `authority_bump`, read 2026-09-13. */
  messageBodyVersion: 1,
  authorityBump: 254,
} as const;

/** One attester signature is 65 bytes; the attestation is `signature_threshold` of them, ascending by signer. */
export const CCTP_ATTESTATION_SIGNATURE_BYTES = 65;
/** `message_transmitter.signature_threshold` on both chains, read 2026-09-12 (Base) and 2026-09-13 (Solana). */
export const CCTP_SIGNATURE_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Circle's attestation service ("Iris")
// ---------------------------------------------------------------------------

export const CCTP_IRIS = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
} as const;

// ---------------------------------------------------------------------------
// Circle's fee and allowance API, and the Fast-versus-Standard choice (CROSSCHAIN-RUNBOOK §5, closed 2026-09-25)
// ---------------------------------------------------------------------------

/**
 * `GET /v2/burn/USDC/fees/{sourceDomain}/{destDomain}` — the minimum fee per finality threshold. Circle's API
 * reference (read 2026-09-25): "Minimum fees for the transfer, expressed in basis points (bps). For example,
 * 1 = 0.01%." Recorded live in `docs/research/cctp-fees-2026-09-25.json`.
 */
export function cctpFeePath(sourceDomain: number, destDomain: number): string {
  for (const [name, d] of [["sourceDomain", sourceDomain], ["destDomain", destDomain]] as const) {
    if (!Number.isInteger(d) || d < 0) throw new RangeError(`${name} must be a domain id, got ${String(d)}`);
  }
  return `/v2/burn/USDC/fees/${sourceDomain}/${destDomain}`;
}

/** `GET /v2/fastBurn/USDC/allowance` — "The current USDC Fast Burn allowance remaining, in full units of USDC up to 6 decimals." */
export const CCTP_FAST_BURN_ALLOWANCE_PATH = "/v2/fastBurn/USDC/allowance";

/** Circle's published minimum fee for each path, basis points of the amount burned (fractional: 1.3 bp is a real value). */
export interface CctpFeeSchedule {
  fastMinFeeBps: number;
  standardMinFeeBps: number;
}

const isFeeBps = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000;

/**
 * Parse the fee endpoint's answer. Both thresholds must be present and well-formed: a schedule with one of them
 * missing is not a schedule the keeper can choose from, and is refused rather than guessed at.
 */
export function parseCctpFeeResponse(body: unknown): CctpFeeSchedule {
  if (!Array.isArray(body)) throw new RangeError("Circle's fee answer is not an array");
  let fast: number | undefined;
  let standard: number | undefined;
  for (const row of body as unknown[]) {
    const r = row as { finalityThreshold?: unknown; minimumFee?: unknown } | null;
    if (!r || typeof r !== "object") throw new RangeError("Circle's fee answer holds a row that is not an object");
    if (!isFeeBps(r.minimumFee)) throw new RangeError(`Circle's fee answer holds a minimumFee that is not a fee: ${String(r.minimumFee)}`);
    if (r.finalityThreshold === CCTP_FINALITY.fast) fast = r.minimumFee;
    else if (r.finalityThreshold === CCTP_FINALITY.standard) standard = r.minimumFee;
    else throw new RangeError(`Circle's fee answer names a finality threshold this code does not know: ${String(r.finalityThreshold)}`);
  }
  if (fast === undefined || standard === undefined) throw new RangeError("Circle's fee answer does not carry both the Fast (1000) and the Standard (2000) minimum");
  return { fastMinFeeBps: fast, standardMinFeeBps: standard };
}

export interface CctpFastBurnAllowance {
  /** Full units of USDC. */
  allowanceUsdc: number;
  /** Circle's own timestamp of the figure, ISO 8601; null when absent or unparsable. */
  lastUpdatedIso: string | null;
}

export function parseCctpAllowanceResponse(body: unknown): CctpFastBurnAllowance {
  const r = body as { allowance?: unknown; lastUpdated?: unknown } | null;
  if (!r || typeof r !== "object") throw new RangeError("Circle's allowance answer is not an object");
  if (typeof r.allowance !== "number" || !Number.isFinite(r.allowance) || r.allowance < 0) throw new RangeError(`Circle's allowance answer holds an allowance that is not an amount: ${String(r.allowance)}`);
  const lastUpdatedIso = typeof r.lastUpdated === "string" && Number.isFinite(Date.parse(r.lastUpdated)) ? r.lastUpdated : null;
  return { allowanceUsdc: r.allowance, lastUpdatedIso };
}

/**
 * The operator's bounds on the choice. Every number here is a product setting, not a chain fact — the
 * defaults below are the founder's to change (`CCTP_MAX_FAST_FEE_BPS` and friends in the Solana keeper's env).
 */
export interface CctpFinalityPolicy {
  /** The most the keeper will ever let Circle take, integer basis points of the amount burned. */
  maxFastFeeBps: number;
  /**
   * Headroom over Circle's published minimum, in percent of that minimum. Circle's docs (concepts/fees, read
   * 2026-09-25): "If fees increase, your Fast Transfers may be degraded to Standard Transfers when the provided
   * maxFee is below the required threshold." The headroom is what keeps a fee that moved between the read and
   * the attestation from turning seconds into minutes.
   */
  feeHeadroomPct: number;
  /** The share of the Fast allowance a burn must leave behind, percent, before the keeper stops asking for Fast. */
  allowanceHeadroomPct: number;
  /** An allowance figure older than this, by Circle's own `lastUpdated`, is not trusted to downgrade a transfer. */
  allowanceMaxAgeS: number;
}

/**
 * Defaults, and why: the ceiling is 10 bp — one tenth of a percent, above every fee Circle has published on
 * this route (1.3 bp Fast, 0 Standard, read 2026-09-12 and 2026-09-25) and small beside the rung it protects;
 * 50 % headroom turns 1.3 bp into a 2 bp bound; the burn must leave a tenth of the pool; and an allowance
 * figure five minutes old is history (the pool moved ≈ $630 K in 51 minutes on 2026-09-12).
 */
export const CCTP_FINALITY_POLICY_DEFAULTS: CctpFinalityPolicy = { maxFastFeeBps: 10, feeHeadroomPct: 50, allowanceHeadroomPct: 10, allowanceMaxAgeS: 300 };

export function assertCctpFinalityPolicy(p: CctpFinalityPolicy): void {
  if (!Number.isInteger(p.maxFastFeeBps) || p.maxFastFeeBps < 0 || p.maxFastFeeBps >= 10_000) throw new RangeError(`maxFastFeeBps must be an integer in [0, 10000), got ${String(p.maxFastFeeBps)}`);
  if (!Number.isFinite(p.feeHeadroomPct) || p.feeHeadroomPct < 0) throw new RangeError(`feeHeadroomPct must be ≥ 0, got ${String(p.feeHeadroomPct)}`);
  if (!Number.isFinite(p.allowanceHeadroomPct) || p.allowanceHeadroomPct < 0 || p.allowanceHeadroomPct >= 100) throw new RangeError(`allowanceHeadroomPct must be in [0, 100), got ${String(p.allowanceHeadroomPct)}`);
  if (!Number.isFinite(p.allowanceMaxAgeS) || p.allowanceMaxAgeS <= 0) throw new RangeError(`allowanceMaxAgeS must be > 0, got ${String(p.allowanceMaxAgeS)}`);
}

/** Circle's fee with the policy's headroom on top, rounded UP to the whole basis point the contracts take. */
export function cctpFeeBoundBps(minFeeBps: number, headroomPct: number): number {
  if (!isFeeBps(minFeeBps)) throw new RangeError(`minFeeBps must be a fee, got ${String(minFeeBps)}`);
  // Round to a millionth of a basis point first so 1.3 × 1.5 (= 1.9500000000000002) and 2 × 1.5 (= 3) both land where arithmetic says.
  const withHeadroom = Math.round((minFeeBps * (100 + headroomPct) * 1e6) / 100) / 1e6;
  return Math.ceil(withHeadroom);
}

export interface CctpFinalityInput {
  /** What must cross, USDC base units (6 decimals); null when the size is not known before the plan is made. */
  amountUsdc: bigint | null;
  /** Circle's schedule for this route, or null when it could not be read. */
  fees: CctpFeeSchedule | null;
  /** The shared Fast allowance and how old Circle's figure is, or null when it could not be read. */
  allowance: { allowanceUsdc: number; ageS: number | null } | null;
  policy: CctpFinalityPolicy;
}

export type CctpFinalityChoice =
  | { kind: "send"; path: "fast" | "standard"; minFinalityThreshold: typeof CCTP_FINALITY.fast | typeof CCTP_FINALITY.standard; maxFeeBps: number; reason: string }
  | { kind: "refuse"; reason: string };

/**
 * Fast or Standard, decided from Circle's live numbers (BUILD-PLAN D6; CROSSCHAIN-RUNBOOK §5's open item,
 * closed 2026-09-25). The asymmetry the rules follow: choosing Standard by mistake costs a protective rung
 * *minutes*; choosing Fast by mistake costs at most the fee bound, because Circle itself degrades a Fast
 * request it cannot honour to Standard (the sentence quoted on `feeHeadroomPct`). So Fast is the default and
 * Standard is chosen only on evidence — a fee above the ceiling, or a fresh allowance figure the amount would
 * exhaust. A schedule that cannot be read sends Fast at the ceiling; a Standard minimum above the ceiling is a
 * refusal, because a burn whose `maxFee` is under that minimum reverts on chain rather than degrading.
 */
export function chooseCctpFinality(input: CctpFinalityInput): CctpFinalityChoice {
  const { policy, fees, allowance, amountUsdc } = input;
  assertCctpFinalityPolicy(policy);
  if (amountUsdc !== null && amountUsdc < 0n) throw new RangeError("amountUsdc must be ≥ 0");
  if (!fees) {
    return { kind: "send", path: "fast", minFinalityThreshold: CCTP_FINALITY.fast, maxFeeBps: policy.maxFastFeeBps, reason: `Circle's fee schedule could not be read: Fast at the ${policy.maxFastFeeBps} bp ceiling (Circle degrades to Standard on its own if that is short)` };
  }
  const standardBound = cctpFeeBoundBps(fees.standardMinFeeBps, policy.feeHeadroomPct);
  if (standardBound > policy.maxFastFeeBps) {
    return { kind: "refuse", reason: `Circle's Standard minimum is ${fees.standardMinFeeBps} bp (${standardBound} bp with ${policy.feeHeadroomPct} % headroom), above the ${policy.maxFastFeeBps} bp ceiling — a burn under it reverts on chain; raise CCTP_MAX_FAST_FEE_BPS or wait` };
  }
  const fastBound = cctpFeeBoundBps(fees.fastMinFeeBps, policy.feeHeadroomPct);
  const standard = (why: string): CctpFinalityChoice => ({ kind: "send", path: "standard", minFinalityThreshold: CCTP_FINALITY.standard, maxFeeBps: standardBound, reason: `Standard (source-chain finality, ${fees.standardMinFeeBps} bp): ${why}` });

  let allowanceNote: string;
  if (!allowance) allowanceNote = "allowance unread";
  else if (allowance.ageS !== null && allowance.ageS > policy.allowanceMaxAgeS) allowanceNote = `allowance figure ${Math.round(allowance.ageS)} s old, past ${policy.allowanceMaxAgeS} s — not trusted to downgrade`;
  else if (amountUsdc === null) allowanceNote = `allowance ${allowance.allowanceUsdc.toFixed(2)} USDC, amount not yet sized`;
  else {
    const amount = Number(amountUsdc) / 1e6;
    const usable = allowance.allowanceUsdc * (1 - policy.allowanceHeadroomPct / 100);
    if (amount > usable) {
      return standard(`${amount.toFixed(2)} USDC exceeds the usable Fast allowance ${usable.toFixed(2)} of ${allowance.allowanceUsdc.toFixed(2)} (${policy.allowanceHeadroomPct} % kept back${allowance.ageS !== null ? `, figure ${Math.round(allowance.ageS)} s old` : ""}) — Fast would wait for finality anyway`);
    }
    allowanceNote = `allowance ${allowance.allowanceUsdc.toFixed(2)} USDC covers ${amount.toFixed(2)}`;
  }
  if (fastBound > policy.maxFastFeeBps) {
    return standard(`Circle's Fast minimum ${fees.fastMinFeeBps} bp is ${fastBound} bp with ${policy.feeHeadroomPct} % headroom, above the ${policy.maxFastFeeBps} bp ceiling`);
  }
  return { kind: "send", path: "fast", minFinalityThreshold: CCTP_FINALITY.fast, maxFeeBps: fastBound, reason: `Fast: Circle's minimum ${fees.fastMinFeeBps} bp, bound ${fastBound} bp with ${policy.feeHeadroomPct} % headroom under the ${policy.maxFastFeeBps} bp ceiling; ${allowanceNote}` };
}

/** `GET /v2/messages/{sourceDomain}?transactionHash=…` — every message a burn transaction produced. */
export function attestationPathByTx(sourceDomain: number, txHash: string): string {
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) throw new RangeError(`sourceDomain must be a domain id, got ${String(sourceDomain)}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new RangeError(`txHash must be a 32-byte hex hash, got ${String(txHash)}`);
  return `/v2/messages/${sourceDomain}?transactionHash=${txHash.toLowerCase()}`;
}

/** The same, by CCTP nonce — the lookup that survives a re-org changing the transaction hash. */
export function attestationPathByNonce(sourceDomain: number, nonce: string): string {
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) throw new RangeError(`sourceDomain must be a domain id, got ${String(sourceDomain)}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new RangeError(`nonce must be 32 bytes of hex, got ${String(nonce)}`);
  return `/v2/messages/${sourceDomain}?nonce=${nonce.toLowerCase()}`;
}

/** What the keeper burned, and therefore what it will accept back from Circle. */
export interface CctpBurnExpectation {
  /** The nonce the burn's own `MessageSent` carried (bytes32 hex). */
  nonce: `0x${string}`;
  /** The recipient the router burned to (bytes32 hex) — the user's Solana USDC token account. */
  mintRecipient: `0x${string}`;
  amount: bigint;
  destinationDomain: number;
}

export type CctpAttestationOutcome =
  /** Attested and agreeing with the burn: ready to deliver. */
  | { kind: "complete"; messageHex: `0x${string}`; attestationHex: `0x${string}`; message: CctpBurnMessageV2; feeExecuted: bigint; deliveredAmount: bigint }
  /** Circle has the message and has not attested it yet. */
  | { kind: "pending"; status: string; delayReason: string | null }
  /** Circle knows nothing about this transaction yet (indexing lag), or it produced no message. */
  | { kind: "not-found" }
  /** Circle answered with something that is NOT the burn we made — never deliver it. */
  | { kind: "mismatch"; why: string };

const isHex = (v: unknown, bytes?: number): v is `0x${string}` =>
  typeof v === "string" && (bytes === undefined ? /^0x([0-9a-fA-F]{2})*$/.test(v) : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v));

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

function bytesToHex(b: Uint8Array): `0x${string}` {
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

/**
 * Circle's `/v2/messages` answer, judged against the burn we actually made (BUILD-PLAN D6 / Stream C).
 *
 * The message is decoded from the RAW BYTES with `decodeCctpBurnMessageV2`, never from Circle's own
 * `decodedMessage`: for a non-EVM destination Circle returns `mintRecipient`, `recipient` and
 * `destinationCaller` as **null** (observed live 2026-09-13 on a Base → domain-27 burn, recorded in
 * `docs/research/cctp-attestation-a9cb6989.json`), so a keeper that trusted those fields would deliver a
 * message it never checked. Every field that identifies the burn — nonce, recipient, amount, domain — must
 * agree, and the attestation must be the right number of whole signatures, or the outcome is `mismatch` and
 * nothing is delivered.
 */
export function parseAttestationResponse(body: unknown, expect: CctpBurnExpectation): CctpAttestationOutcome {
  const root = body as { messages?: unknown } | null;
  const list = root && Array.isArray(root.messages) ? (root.messages as Record<string, unknown>[]) : null;
  if (!list || list.length === 0) return { kind: "not-found" };

  // Circle returns every message the transaction produced; ours is the one carrying our nonce.
  const mine = list.find((m) => typeof m.eventNonce === "string" && m.eventNonce.toLowerCase() === expect.nonce.toLowerCase());
  if (!mine) return { kind: "not-found" };

  const status = typeof mine.status === "string" ? mine.status : "unknown";
  const messageHex = mine.message;
  const attestationHex = mine.attestation;
  if (!isHex(messageHex)) return { kind: "pending", status, delayReason: typeof mine.delayReason === "string" ? mine.delayReason : null };

  let decoded: CctpBurnMessageV2;
  try {
    decoded = decodeCctpBurnMessageV2(hexToBytes(messageHex));
  } catch (e) {
    return { kind: "mismatch", why: `the message bytes are not a CCTP V2 burn message: ${(e as Error).message}` };
  }

  // The burn we made, checked field by field against the bytes Circle will have attested.
  const nonceHex = bytesToHex(decoded.nonce);
  if (nonceHex.toLowerCase() !== expect.nonce.toLowerCase()) return { kind: "mismatch", why: `nonce ${nonceHex} is not the burn's ${expect.nonce}` };
  const recipientHex = bytesToHex(decoded.body.mintRecipient);
  if (recipientHex.toLowerCase() !== expect.mintRecipient.toLowerCase()) {
    return { kind: "mismatch", why: `mint recipient ${recipientHex} is not the account's ${expect.mintRecipient}` };
  }
  if (decoded.body.amount !== expect.amount) return { kind: "mismatch", why: `amount ${decoded.body.amount} is not the burned ${expect.amount}` };
  if (decoded.destinationDomain !== expect.destinationDomain) {
    return { kind: "mismatch", why: `destination domain ${decoded.destinationDomain} is not ${expect.destinationDomain}` };
  }
  if (decoded.body.feeExecuted > decoded.body.maxFee) {
    return { kind: "mismatch", why: `Circle executed a fee of ${decoded.body.feeExecuted} above the ${decoded.body.maxFee} the burn allowed` };
  }

  if (!isHex(attestationHex) || attestationHex === "0x") return { kind: "pending", status, delayReason: typeof mine.delayReason === "string" ? mine.delayReason : null };
  const sigBytes = (attestationHex.length - 2) / 2;
  if (sigBytes % CCTP_ATTESTATION_SIGNATURE_BYTES !== 0 || sigBytes === 0) {
    return { kind: "mismatch", why: `the attestation is ${sigBytes} bytes, not whole ${CCTP_ATTESTATION_SIGNATURE_BYTES}-byte signatures` };
  }
  if (status !== "complete") return { kind: "pending", status, delayReason: typeof mine.delayReason === "string" ? mine.delayReason : null };

  return {
    kind: "complete",
    messageHex,
    attestationHex,
    message: decoded,
    feeExecuted: decoded.body.feeExecuted,
    deliveredAmount: decoded.body.amount - decoded.body.feeExecuted,
  };
}
