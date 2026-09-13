/**
 * Step 4 of the cross-chain rung: delivering an attested CCTP message on Solana
 * (`docs/SOLANA-ARCHITECTURE.md` §14.6; BUILD-PLAN D6 / Stream C).
 *
 * `MessageTransmitterV2.receive_message(message, attestation)` verifies Circle's signatures, records the
 * nonce so the same message can never land twice, and CPIs into TokenMessengerMinterV2, which pays the USDC
 * out of its **custody token account** — CCTP does not mint on Solana (`VERIFIED-SOLANA-FACTS.md`
 * Addendum 4) — to the recipient the message names. That recipient is the user's own Account token account,
 * fixed in the message bytes at burn time, so this instruction cannot be pointed anywhere else: the keeper is
 * a relayer here, not a custodian, and any funded key could send exactly the same transaction.
 *
 * Every account is derived from Circle's own seeds and asserted against the addresses read on chain
 * (`solana/test/…`, `agent/test/delivery.test.ts`); nothing is typed from memory.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { CCTP_DOMAINS, CCTP_V2_SOLANA, CCTP_V2_SOLANA_RECEIVE, decodeCctpBurnMessageV2 } from "@zyo/shared";
import { PK, ata } from "./layouts.js";

/** Circle's two programs, as this module addresses them. */
export const CCTP = {
  tokenMessengerMinter: new PublicKey(CCTP_V2_SOLANA.programs.tokenMessengerMinterV2),
  messageTransmitter: new PublicKey(CCTP_V2_SOLANA.programs.messageTransmitterV2),
} as const;

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Anchor's global discriminator, computed (never typed): `sha256("global:<name>")[..8]`. */
export function anchorDiscriminator(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

// ------------------------------------------------------------------ the PDAs Circle's seeds derive

/** `["message_transmitter_authority", <receiver>]` of the transmitter — signs the handler CPI. */
export function messageTransmitterAuthority(receiver: PublicKey = CCTP.tokenMessengerMinter): PublicKey {
  return pda([seed(CCTP_V2_SOLANA_RECEIVE.seeds.messageTransmitterAuthority), receiver.toBuffer()], CCTP.messageTransmitter);
}
/** `["used_nonce", <the message's 32-byte nonce>]` — created by the delivery; its existence IS the replay guard. */
export function usedNoncePda(nonce: Uint8Array): PublicKey {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new RangeError("the CCTP nonce is 32 bytes");
  return pda([seed(CCTP_V2_SOLANA_RECEIVE.seeds.usedNonce), Buffer.from(nonce)], CCTP.messageTransmitter);
}
/** `["local_token", <mint>]`. */
export function localTokenPda(mint: PublicKey = PK.usdcMint): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.localToken), mint.toBuffer()], CCTP.tokenMessengerMinter);
}
/** `["token_pair", "<remote domain, decimal>", <the remote token as bytes32>]`. */
export function tokenPairPda(remoteDomain: number, remoteToken: Uint8Array): PublicKey {
  if (!(remoteToken instanceof Uint8Array) || remoteToken.length !== 32) throw new RangeError("the remote token is 32 bytes");
  return pda([seed(CCTP_V2_SOLANA_RECEIVE.seeds.tokenPair), seed(String(remoteDomain)), Buffer.from(remoteToken)], CCTP.tokenMessengerMinter);
}
/** `["custody", <mint>]` — the token account a delivery is paid out of. */
export function custodyPda(mint: PublicKey = PK.usdcMint): PublicKey {
  return pda([seed(CCTP_V2_SOLANA_RECEIVE.seeds.custody), mint.toBuffer()], CCTP.tokenMessengerMinter);
}
/** `["remote_token_messenger", "<domain, decimal>"]`. */
export function remoteTokenMessengerPda(domain: number): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.remoteTokenMessenger), seed(String(domain))], CCTP.tokenMessengerMinter);
}
export function tokenMessengerPda(): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.tokenMessenger)], CCTP.tokenMessengerMinter);
}
export function tokenMinterPda(): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.tokenMinter)], CCTP.tokenMessengerMinter);
}
export function messageTransmitterPda(): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.messageTransmitter)], CCTP.messageTransmitter);
}
export function eventAuthority(program: PublicKey): PublicKey {
  return pda([seed(CCTP_V2_SOLANA.seeds.eventAuthority)], program);
}

/**
 * The account order `receive_message` takes, flattened: its own nine, then the receiver's own accounts as
 * REMAINING accounts (Circle's handler gets `authority_pda` prepended by the transmitter, so the remaining
 * list starts at `token_messenger`). Pinned by `agent/test/delivery.test.ts` against Circle's source.
 */
export const RECEIVE_MESSAGE_ACCOUNT_ORDER = [
  "payer",
  "caller",
  "authority_pda",
  "message_transmitter",
  "used_nonce",
  "receiver",
  "system_program",
  "transmitter.event_authority",
  "transmitter.program",
  // remaining accounts, forwarded to TokenMessengerMinterV2's handle_receive_*_message
  "remaining.token_messenger",
  "remaining.remote_token_messenger",
  "remaining.token_minter",
  "remaining.local_token",
  "remaining.token_pair",
  "remaining.fee_recipient_token_account",
  "remaining.recipient_token_account",
  "remaining.custody_token_account",
  "remaining.token_program",
  "remaining.messenger.event_authority",
  "remaining.messenger.program",
] as const;

const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });

/** Borsh `Vec<u8>`: a four-byte little-endian length, then the bytes. */
function borshBytes(b: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, Buffer.from(b)]);
}

export interface DeliveryKeys {
  /** Pays the rent of the `used_nonce` account it creates, and signs. The keeper. */
  payer: PublicKey;
  /** The message's `destinationCaller`, or any signer when that is zero. The keeper. */
  caller: PublicKey;
  /** Where the USDC lands: the token account the BURN named. Never a parameter of the keeper's choosing. */
  recipientTokenAccount: PublicKey;
  /** Circle's fee recipient token account for this mint. */
  feeRecipientTokenAccount: PublicKey;
  mint?: PublicKey;
}

/**
 * Build the one instruction that delivers an attested burn. `message` and `attestation` are Circle's own bytes,
 * unmodified; the recipient is read back OUT of those bytes and must equal the key passed in, so a message and
 * a recipient that disagree cannot be sent.
 */
export function ixReceiveMessage(k: DeliveryKeys, message: Uint8Array, attestation: Uint8Array): TransactionInstruction {
  const decoded = decodeCctpBurnMessageV2(message);
  const mint = k.mint ?? PK.usdcMint;
  const named = new PublicKey(decoded.body.mintRecipient);
  if (!named.equals(k.recipientTokenAccount)) {
    throw new RangeError(`the message pays ${named.toBase58()}, not the ${k.recipientTokenAccount.toBase58()} this delivery names`);
  }
  if (decoded.destinationDomain !== CCTP_DOMAINS.solana) {
    throw new RangeError(`the message is addressed to domain ${decoded.destinationDomain}, not Solana (${CCTP_DOMAINS.solana})`);
  }
  if (attestation.length === 0 || attestation.length % 65 !== 0) {
    throw new RangeError(`the attestation is ${attestation.length} bytes, not whole 65-byte signatures`);
  }
  const receiver = CCTP.tokenMessengerMinter;
  const data = Buffer.concat([
    anchorDiscriminator(CCTP_V2_SOLANA_RECEIVE.receiveMessageDiscriminatorPreimage),
    borshBytes(message),
    borshBytes(attestation),
  ]);
  return new TransactionInstruction({
    programId: CCTP.messageTransmitter,
    keys: [
      w(k.payer, true),
      ro(k.caller, true),
      ro(messageTransmitterAuthority(receiver)),
      ro(messageTransmitterPda()),
      w(usedNoncePda(decoded.nonce)),
      ro(receiver),
      ro(SystemProgram.programId),
      ro(eventAuthority(CCTP.messageTransmitter)),
      ro(CCTP.messageTransmitter),
      // remaining accounts → the token messenger's handler
      ro(tokenMessengerPda()),
      ro(remoteTokenMessengerPda(decoded.sourceDomain)),
      ro(tokenMinterPda()),
      w(localTokenPda(mint)),
      ro(tokenPairPda(decoded.sourceDomain, decoded.body.burnToken)),
      w(k.feeRecipientTokenAccount),
      w(k.recipientTokenAccount),
      w(custodyPda(mint)),
      ro(PK.tokenProgram),
      ro(eventAuthority(receiver)),
      ro(receiver),
    ],
    data,
  });
}

/** Circle's fee recipient token account for a mint, from the `token_messenger` account's `fee_recipient`. */
export function feeRecipientTokenAccount(feeRecipient: PublicKey, mint: PublicKey = PK.usdcMint): PublicKey {
  return ata(feeRecipient, mint);
}

/** `token_messenger.fee_recipient`, decoded from the account's bytes (Addendum 4's field order). */
export function decodeFeeRecipient(data: Buffer): PublicKey {
  // 8 discriminator + denylister 32 + owner 32 + pending_owner 32 + message_body_version 4 + authority_bump 1
  const offset = 8 + 32 + 32 + 32 + 4 + 1;
  if (data.length < offset + 32) throw new Error(`token_messenger is ${data.length} bytes, too short for fee_recipient`);
  return new PublicKey(data.subarray(offset, offset + 32));
}
