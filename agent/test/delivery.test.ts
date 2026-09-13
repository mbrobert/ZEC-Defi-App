/**
 * The delivery instruction (BUILD-PLAN D6 / Stream C, step 4). Three things are proved here: every account is
 * DERIVED from Circle's own seeds and lands on the address read from mainnet (`VERIFIED-SOLANA-FACTS.md`
 * Addendum 4, through `@zyo/shared`); the account order, the signer and writable flags and the data layout are
 * Circle's `receive_message` and its handler; and a message that does not pay the account we name, or is not
 * addressed to Solana, or carries a part-signature attestation, is refused before anything is built.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  CCTP_DOMAINS,
  CCTP_V2_BASE,
  CCTP_V2_SOLANA,
  CCTP_V2_SOLANA_RECEIVE,
  encodeCctpBurnMessageV2,
  evmAddressToBytes32,
  type CctpBurnMessageV2,
} from "@zyo/shared";
import {
  CCTP,
  RECEIVE_MESSAGE_ACCOUNT_ORDER,
  anchorDiscriminator,
  custodyPda,
  decodeFeeRecipient,
  eventAuthority,
  feeRecipientTokenAccount,
  ixReceiveMessage,
  localTokenPda,
  messageTransmitterAuthority,
  messageTransmitterPda,
  remoteTokenMessengerPda,
  tokenMessengerPda,
  tokenMinterPda,
  tokenPairPda,
  usedNoncePda,
} from "../src/solana/delivery.js";
import { PK, ata } from "../src/solana/layouts.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const RECIPIENT = Keypair.generate().publicKey; // the user's Account USDC token account
const FEE_ATA = new PublicKey(CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipientUsdcAta);

/** A Base → Solana burn message, built with the codec the live Circle message is decoded by. */
function message(over: Partial<CctpBurnMessageV2> = {}, body: Partial<CctpBurnMessageV2["body"]> = {}): Uint8Array {
  const m: CctpBurnMessageV2 = {
    version: 1,
    sourceDomain: CCTP_DOMAINS.base,
    destinationDomain: CCTP_DOMAINS.solana,
    nonce: new Uint8Array(32).fill(7),
    sender: evmAddressToBytes32(CCTP_V2_BASE.tokenMessengerV2),
    recipient: new Uint8Array(32).fill(0xa6),
    destinationCaller: new Uint8Array(32),
    minFinalityThreshold: 1000,
    finalityThresholdExecuted: 1000,
    ...over,
    body: {
      version: 1,
      burnToken: evmAddressToBytes32(BASE_USDC),
      mintRecipient: RECIPIENT.toBytes(),
      amount: 24_067_940_000n,
      messageSender: evmAddressToBytes32("0x1646587E543bC2f63137bAa86F8598E1274aED78"),
      maxFee: 2_406_794n,
      feeExecuted: 0n,
      expirationBlock: 51_260_000n,
      hookData: new Uint8Array(0),
      ...body,
    },
  };
  return encodeCctpBurnMessageV2(m);
}
const attestation = (sigs = 2) => new Uint8Array(65 * sigs).fill(3);

describe("the delivery's accounts are Circle's seeds, landing on the addresses read from mainnet", () => {
  it("every derived PDA equals the address VERIFIED-SOLANA-FACTS Addendum 3 and 4 recorded", () => {
    assert.equal(messageTransmitterAuthority().toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.messageTransmitterAuthority);
    assert.equal(custodyPda().toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.custodyUsdc);
    assert.equal(tokenPairPda(CCTP_DOMAINS.base, evmAddressToBytes32(BASE_USDC)).toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.tokenPairBaseUsdc);
    assert.equal(eventAuthority(CCTP.messageTransmitter).toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.messageTransmitterEventAuthority);
    assert.equal(eventAuthority(CCTP.tokenMessengerMinter).toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.tokenMessengerEventAuthority);
    assert.equal(tokenMessengerPda().toBase58(), CCTP_V2_SOLANA.pdas.tokenMessenger);
    assert.equal(tokenMinterPda().toBase58(), CCTP_V2_SOLANA.pdas.tokenMinter);
    assert.equal(localTokenPda().toBase58(), CCTP_V2_SOLANA.pdas.localTokenUsdc);
    assert.equal(remoteTokenMessengerPda(CCTP_DOMAINS.base).toBase58(), CCTP_V2_SOLANA.pdas.remoteTokenMessengerBase);
    assert.equal(messageTransmitterPda().toBase58(), CCTP_V2_SOLANA.pdas.messageTransmitter);
    // the fee recipient's token account is an ordinary ATA of the fee recipient the token_messenger names
    assert.equal(feeRecipientTokenAccount(new PublicKey(CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipient)).toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipientUsdcAta);
  });

  it("decodeFeeRecipient reads the field at Addendum 4's offset", () => {
    const fee = new PublicKey(CCTP_V2_SOLANA_RECEIVE.pdas.feeRecipient);
    const data = Buffer.concat([Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1), fee.toBuffer(), Buffer.alloc(36)]);
    assert.equal(decodeFeeRecipient(data).toBase58(), fee.toBase58());
    assert.throws(() => decodeFeeRecipient(Buffer.alloc(20)), /too short/);
  });

  it("the used-nonce account is per message, so two messages can never collide and one can never land twice", () => {
    const a = usedNoncePda(new Uint8Array(32).fill(1));
    const b = usedNoncePda(new Uint8Array(32).fill(2));
    assert.notEqual(a.toBase58(), b.toBase58());
    assert.equal(usedNoncePda(new Uint8Array(32).fill(1)).toBase58(), a.toBase58());
    assert.throws(() => usedNoncePda(new Uint8Array(31)), RangeError);
  });

  it("the discriminator is Anchor's sha256 of Circle's own instruction name", () => {
    assert.deepEqual([...anchorDiscriminator("global:receive_message")], [...anchorDiscriminator(CCTP_V2_SOLANA_RECEIVE.receiveMessageDiscriminatorPreimage)]);
    assert.equal(anchorDiscriminator("global:receive_message").length, 8);
    // the send side's, which the program's own cctp.rs carries, is a different instruction
    assert.notDeepEqual([...anchorDiscriminator("global:receive_message")], [...anchorDiscriminator(CCTP_V2_SOLANA.depositForBurnDiscriminatorPreimage)]);
  });
});

describe("ixReceiveMessage", () => {
  it("builds Circle's account list in order, with the transmitter's own nine then the handler's as remaining accounts, and the documented flags", () => {
    const keeper = Keypair.generate().publicKey;
    const msg = message();
    const ix = ixReceiveMessage({ payer: keeper, caller: keeper, recipientTokenAccount: RECIPIENT, feeRecipientTokenAccount: FEE_ATA }, msg, attestation());
    assert.equal(ix.programId.toBase58(), CCTP_V2_SOLANA.programs.messageTransmitterV2);
    assert.equal(ix.keys.length, RECEIVE_MESSAGE_ACCOUNT_ORDER.length);
    const at = (name: (typeof RECEIVE_MESSAGE_ACCOUNT_ORDER)[number]) => ix.keys[RECEIVE_MESSAGE_ACCOUNT_ORDER.indexOf(name)];
    // the transmitter's own accounts
    assert.equal(at("payer").pubkey.toBase58(), keeper.toBase58());
    assert.ok(at("payer").isSigner && at("payer").isWritable, "the payer signs and pays the used-nonce rent");
    assert.ok(at("caller").isSigner && !at("caller").isWritable);
    assert.equal(at("authority_pda").pubkey.toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.messageTransmitterAuthority);
    assert.ok(!at("authority_pda").isSigner, "the transmitter signs with it; the transaction does not");
    assert.equal(at("message_transmitter").pubkey.toBase58(), CCTP_V2_SOLANA.pdas.messageTransmitter);
    assert.ok(at("used_nonce").isWritable, "created by this instruction");
    assert.equal(at("used_nonce").pubkey.toBase58(), usedNoncePda(new Uint8Array(32).fill(7)).toBase58());
    assert.equal(at("receiver").pubkey.toBase58(), CCTP_V2_SOLANA.programs.tokenMessengerMinterV2);
    assert.equal(at("system_program").pubkey.toBase58(), SystemProgram.programId.toBase58());
    // the handler's, as remaining accounts — authority_pda is prepended by the transmitter, not by us
    assert.equal(at("remaining.token_messenger").pubkey.toBase58(), CCTP_V2_SOLANA.pdas.tokenMessenger);
    assert.equal(at("remaining.remote_token_messenger").pubkey.toBase58(), CCTP_V2_SOLANA.pdas.remoteTokenMessengerBase);
    assert.equal(at("remaining.token_pair").pubkey.toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.tokenPairBaseUsdc);
    assert.equal(at("remaining.recipient_token_account").pubkey.toBase58(), RECIPIENT.toBase58());
    assert.equal(at("remaining.custody_token_account").pubkey.toBase58(), CCTP_V2_SOLANA_RECEIVE.pdas.custodyUsdc);
    assert.equal(at("remaining.fee_recipient_token_account").pubkey.toBase58(), FEE_ATA.toBase58());
    assert.equal(at("remaining.token_program").pubkey.toBase58(), PK.tokenProgram.toBase58());
    for (const n of ["remaining.local_token", "remaining.fee_recipient_token_account", "remaining.recipient_token_account", "remaining.custody_token_account"] as const) {
      assert.ok(at(n).isWritable, `${n} is written`);
    }
    for (const n of ["remaining.token_messenger", "remaining.remote_token_messenger", "remaining.token_minter", "remaining.token_pair", "remaining.token_program"] as const) {
      assert.ok(!at(n).isWritable, `${n} is read`);
    }
    assert.ok(ix.keys.every((k, i) => i === 0 || i === 1 || !k.isSigner), "only the payer and the caller sign");
  });

  it("carries Circle's bytes verbatim: 8-byte discriminator then two Borsh byte vectors", () => {
    const keeper = Keypair.generate().publicKey;
    const msg = message();
    const att = attestation();
    const ix = ixReceiveMessage({ payer: keeper, caller: keeper, recipientTokenAccount: RECIPIENT, feeRecipientTokenAccount: FEE_ATA }, msg, att);
    assert.equal(ix.data.length, 8 + 4 + msg.length + 4 + att.length);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...anchorDiscriminator("global:receive_message")]);
    assert.equal(ix.data.readUInt32LE(8), msg.length);
    assert.deepEqual([...ix.data.subarray(12, 12 + msg.length)], [...msg], "the message is unmodified");
    assert.equal(ix.data.readUInt32LE(12 + msg.length), att.length);
    assert.deepEqual([...ix.data.subarray(16 + msg.length)], [...att], "the attestation is unmodified");
  });

  it("refuses a message that pays somewhere else, one addressed to another chain, and an attestation that is not whole signatures", () => {
    const keeper = Keypair.generate().publicKey;
    const k = { payer: keeper, caller: keeper, recipientTokenAccount: RECIPIENT, feeRecipientTokenAccount: FEE_ATA };
    const elsewhere = message({}, { mintRecipient: Keypair.generate().publicKey.toBytes() });
    assert.throws(() => ixReceiveMessage(k, elsewhere, attestation()), /pays .*, not the/);
    const wrongChain = message({ destinationDomain: 27 });
    assert.throws(() => ixReceiveMessage(k, wrongChain, attestation()), /addressed to domain 27/);
    assert.throws(() => ixReceiveMessage(k, message(), new Uint8Array(0)), /not whole 65-byte signatures/);
    assert.throws(() => ixReceiveMessage(k, message(), new Uint8Array(100)), /not whole 65-byte signatures/);
    // one signature is a whole signature: the threshold is Circle's to enforce, not ours to guess
    assert.doesNotThrow(() => ixReceiveMessage(k, message(), attestation(1)));
  });

  it("routes by the message's own source domain: a Base-sourced message names Base's remote messenger and token pair", () => {
    const keeper = Keypair.generate().publicKey;
    const ix = ixReceiveMessage({ payer: keeper, caller: keeper, recipientTokenAccount: RECIPIENT, feeRecipientTokenAccount: FEE_ATA }, message(), attestation());
    const names = ix.keys.map((k) => k.pubkey.toBase58());
    assert.ok(names.includes(remoteTokenMessengerPda(CCTP_DOMAINS.base).toBase58()));
    assert.ok(names.includes(tokenPairPda(CCTP_DOMAINS.base, evmAddressToBytes32(BASE_USDC)).toBase58()));
    assert.ok(!names.includes(ata(keeper, PK.usdcMint).toBase58()), "the keeper's own token account is never in a delivery");
  });
});
