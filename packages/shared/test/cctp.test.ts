import {
  test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CCTP_BURN_LIMIT_PER_MESSAGE_USDC,
  CCTP_DOMAINS,
  CCTP_FEES_2026_09_12,
  CCTP_FINALITY,
  CCTP_V2_BASE,
  CCTP_V2_MESSAGE_LAYOUT,
  CCTP_V2_SOLANA,
  bytes32ToEvmAddress,
  decodeCctpBurnMessageV2,
  encodeCctpBurnMessageV2,
  evmAddressToBytes32,
  isChecksumAddress,
  keccak256Hex,
  type CctpBurnMessageV2,
  CCTP_V2_SOLANA_RECEIVE,
  CCTP_ATTESTATION_SIGNATURE_BYTES,
  CCTP_SIGNATURE_THRESHOLD,
  CCTP_IRIS,
  attestationPathByTx,
  attestationPathByNonce,
  parseAttestationResponse,
} from "../dist/index.js";

const facts = readFileSync(new URL("../../../docs/VERIFIED-SOLANA-FACTS.md", import.meta.url), "utf8");
const selector = (sig: string) => "0x" + keccak256Hex(sig).replace(/^0x/, "").slice(0, 8);

test("every Base address is checksummed and every one is in VERIFIED-SOLANA-FACTS.md (Addenda 1 and 3)", () => {
  const addrs = [CCTP_V2_BASE.tokenMessengerV2, CCTP_V2_BASE.messageTransmitterV2, CCTP_V2_BASE.tokenMinterV2, CCTP_V2_BASE.feeRecipient, ...Object.values(CCTP_V2_BASE.implementations)];
  for (const a of addrs) {
    assert.ok(isChecksumAddress(a), a);
    assert.ok(facts.includes(a), `${a} not in the facts file`);
  }
  for (const p of Object.values(CCTP_V2_SOLANA.programs)) assert.ok(facts.includes(p), p);
  for (const p of Object.values(CCTP_V2_SOLANA.pdas)) assert.ok(facts.includes(p), p);
});

test("the selectors and event signatures are the verified ABI's — recomputed from the signatures here", () => {
  assert.equal(selector(CCTP_V2_BASE.abi.depositForBurn), CCTP_V2_BASE.abi.depositForBurnSelector);
  assert.equal(selector(CCTP_V2_BASE.abi.depositForBurnWithHook), CCTP_V2_BASE.abi.depositForBurnWithHookSelector);
  assert.equal(selector(CCTP_V2_BASE.abi.receiveMessage), CCTP_V2_BASE.abi.receiveMessageSelector);
  assert.equal(CCTP_V2_BASE.abi.depositForBurnSelector, "0x8e0250ee", "Addendum 3");
  assert.equal(CCTP_V2_BASE.abi.receiveMessageSelector, "0x57ecfd28", "Addendum 3");
  // the event topics the keeper filters on, as keccak of the canonical signature
  assert.match(keccak256Hex(CCTP_V2_BASE.abi.depositForBurnEvent).replace(/^0x/, ""), /^[0-9a-f]{64}$/);
  assert.match(keccak256Hex(CCTP_V2_BASE.abi.messageSentEvent).replace(/^0x/, ""), /^[0-9a-f]{64}$/);
});

test("domains, finality thresholds and the burn cap are the recorded ones", () => {
  assert.equal(CCTP_DOMAINS.solana, 5);
  assert.equal(CCTP_DOMAINS.base, 6);
  assert.equal(CCTP_FINALITY.fast, 1000);
  assert.equal(CCTP_FINALITY.standard, 2000);
  assert.equal(CCTP_BURN_LIMIT_PER_MESSAGE_USDC, 10_000_000);
  assert.equal(CCTP_FEES_2026_09_12.solanaToBaseFastMinFeeBps, 1);
  assert.equal(CCTP_FEES_2026_09_12.baseToSolanaFastMinFeeBps, 1.3);
  assert.ok(facts.includes("Solana **5**, Base **6**"));
});

test("the Solana seeds and the params order are Circle's deposit_for_burn.rs", () => {
  assert.deepEqual(CCTP_V2_SOLANA.depositForBurnParams, ["amount:u64", "destination_domain:u32", "mint_recipient:pubkey", "destination_caller:pubkey", "max_fee:u64", "min_finality_threshold:u32"]);
  assert.equal(CCTP_V2_SOLANA.seeds.remoteTokenMessenger, "remote_token_messenger");
  assert.equal(CCTP_V2_SOLANA.seeds.localToken, "local_token");
  assert.equal(CCTP_V2_SOLANA.depositForBurnDiscriminatorPreimage, "global:deposit_for_burn");
});

test("an EVM address round-trips through the 32-byte form; a non-padded value is refused", () => {
  const a = CCTP_V2_BASE.tokenMessengerV2;
  const b = evmAddressToBytes32(a);
  assert.equal(b.length, 32);
  assert.ok(b.subarray(0, 12).every((x) => x === 0));
  assert.equal(bytes32ToEvmAddress(b).toLowerCase(), a.toLowerCase());
  // Addendum 3: Base's messenger as recorded on Solana's remote_token_messenger
  assert.equal("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""), "0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d");
  const notEvm = new Uint8Array(32).fill(1);
  assert.throws(() => bytes32ToEvmAddress(notEvm), RangeError);
  assert.throws(() => evmAddressToBytes32("0x1234" as never), RangeError);
});

test("a V2 burn message encodes at the documented offsets (148 + 228 bytes) and decodes back; versions other than 1/1 are refused", () => {
  const L = CCTP_V2_MESSAGE_LAYOUT;
  assert.equal(L.headerLength, 148);
  assert.equal(L.burnBodyLength, 228);
  const nonce = new Uint8Array(32).fill(7);
  const m: CctpBurnMessageV2 = {
    version: 1,
    sourceDomain: CCTP_DOMAINS.solana,
    destinationDomain: CCTP_DOMAINS.base,
    nonce,
    sender: new Uint8Array(32).fill(0xa6),
    recipient: evmAddressToBytes32(CCTP_V2_BASE.tokenMessengerV2),
    destinationCaller: new Uint8Array(32),
    minFinalityThreshold: CCTP_FINALITY.fast,
    finalityThresholdExecuted: CCTP_FINALITY.fast,
    body: {
      version: 1,
      burnToken: new Uint8Array(32).fill(0xc6),
      mintRecipient: evmAddressToBytes32("0x1111111111111111111111111111111111111111"),
      amount: 24_067_940_000n,
      messageSender: new Uint8Array(32).fill(3),
      maxFee: 2_406_794n,
      feeExecuted: 2_406_794n,
      expirationBlock: 51_239_874n,
      hookData: new Uint8Array(0),
    },
  };
  const bytes = encodeCctpBurnMessageV2(m);
  assert.equal(bytes.length, 376);
  // spot-check the offsets by hand
  assert.deepEqual(Array.from(bytes.subarray(8, 12)), [0, 0, 0, 6], "destinationDomain u32 big-endian at 8");
  assert.deepEqual(Array.from(bytes.subarray(140, 144)), [0, 0, 3, 232], "minFinalityThreshold 1000 at 140");
  assert.equal(bytes[148 + 36 + 31], 0x11, "mintRecipient's last byte at body+36+31");
  const back = decodeCctpBurnMessageV2(bytes);
  assert.deepEqual(back, m);
  assert.equal(bytes32ToEvmAddress(back.body.mintRecipient), "0x1111111111111111111111111111111111111111");
  // hook data survives; a short message and a wrong version are refused
  const withHook = encodeCctpBurnMessageV2({ ...m, body: { ...m.body, hookData: new Uint8Array([9, 9]) } });
  assert.equal(withHook.length, 378);
  assert.deepEqual(Array.from(decodeCctpBurnMessageV2(withHook).body.hookData), [9, 9]);
  assert.throws(() => decodeCctpBurnMessageV2(bytes.subarray(0, 300)), RangeError);
  const v2 = new Uint8Array(bytes);
  v2[3] = 2;
  assert.throws(() => decodeCctpBurnMessageV2(v2), /not the pinned V2/);
});

// --------------------------------------------------------------------- the receive side (Addendum 4)

const recorded = JSON.parse(readFileSync(new URL("../../../docs/research/cctp-attestation-a9cb6989.json", import.meta.url), "utf8")) as {
  messages: { message: `0x${string}`; attestation: `0x${string}`; eventNonce: `0x${string}`; status: string; decodedMessage: Record<string, unknown> }[];
};
const recordedMsg = recorded.messages[0]!;
const recordedDecoded = decodeCctpBurnMessageV2(Uint8Array.from(Buffer.from(recordedMsg.message.slice(2), "hex")));
const toHex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
/** The burn that recorded response belongs to, as the keeper would have recorded it at send time. */
const recordedExpectation = {
  nonce: recordedMsg.eventNonce,
  mintRecipient: toHex(recordedDecoded.body.mintRecipient),
  amount: recordedDecoded.body.amount,
  destinationDomain: recordedDecoded.destinationDomain,
};

test("every receive-side address is in VERIFIED-SOLANA-FACTS.md (Addendum 4), and the constants are Circle's", () => {
  for (const p of Object.values(CCTP_V2_SOLANA_RECEIVE.pdas)) assert.ok(facts.includes(p), `${p} not in the facts file`);
  assert.equal(CCTP_V2_SOLANA_RECEIVE.seeds.usedNonce, "used_nonce");
  assert.equal(CCTP_V2_SOLANA_RECEIVE.seeds.messageTransmitterAuthority, "message_transmitter_authority");
  assert.equal(CCTP_V2_SOLANA_RECEIVE.finalizedThreshold, CCTP_FINALITY.standard, "Circle's finalized boundary is the standard threshold");
  assert.equal(CCTP_V2_SOLANA_RECEIVE.messageBodyVersion, 1);
  assert.equal(CCTP_V2_SOLANA_RECEIVE.authorityBump, 254);
  assert.equal(CCTP_ATTESTATION_SIGNATURE_BYTES, 65);
  assert.equal(CCTP_SIGNATURE_THRESHOLD, 2);
  assert.deepEqual(CCTP_V2_SOLANA_RECEIVE.receiveMessageParams, ["message:bytes", "attestation:bytes"]);
});

test("the attestation paths are Circle's, and a malformed hash or domain is refused rather than sent", () => {
  const tx = "0xA9CB69894A97D99530C1274E8D8C7E7B148FC1B0E8B57A7BA267F5ED4AC32737";
  assert.equal(attestationPathByTx(CCTP_DOMAINS.base, tx), `/v2/messages/6?transactionHash=${tx.toLowerCase()}`);
  assert.equal(attestationPathByNonce(CCTP_DOMAINS.base, recordedMsg.eventNonce), `/v2/messages/6?nonce=${recordedMsg.eventNonce}`);
  assert.equal(CCTP_IRIS.mainnet, "https://iris-api.circle.com");
  assert.equal(CCTP_IRIS.testnet, "https://iris-api-sandbox.circle.com");
  assert.throws(() => attestationPathByTx(6, "0x1234"), RangeError);
  assert.throws(() => attestationPathByTx(-1, tx), RangeError);
  assert.throws(() => attestationPathByNonce(6, "nope"), RangeError);
});

test("parseAttestationResponse on the RECORDED Circle answer: complete, decoded from the raw bytes, and the delivered amount is the burn less the fee Circle executed", () => {
  const out = parseAttestationResponse(recorded, recordedExpectation);
  assert.equal(out.kind, "complete", out.kind === "mismatch" ? out.why : out.kind);
  if (out.kind !== "complete") return;
  assert.equal(out.messageHex, recordedMsg.message);
  assert.equal(out.attestationHex, recordedMsg.attestation);
  assert.equal((out.attestationHex.length - 2) / 2, CCTP_ATTESTATION_SIGNATURE_BYTES * CCTP_SIGNATURE_THRESHOLD, "two whole signatures");
  assert.equal(out.message.body.amount, 9_990_734n);
  assert.equal(out.feeExecuted, 1_298n);
  assert.equal(out.deliveredAmount, 9_990_734n - 1_298n, "what actually lands: the burn less Circle's executed fee");
  assert.ok(out.feeExecuted < out.message.body.maxFee, "the executed fee stays under the bound the burn set");
  // The fact that forces the raw decode: Circle null-fills the decoded fields for a non-EVM destination.
  const body = recordedMsg.decodedMessage.decodedMessageBody as Record<string, unknown>;
  assert.equal(body.mintRecipient, null, "Circle decodes no mint recipient for a non-EVM destination");
  assert.equal(recordedMsg.decodedMessage.recipient, null);
  assert.notEqual(toHex(out.message.body.mintRecipient), "0x" + "00".repeat(32), "…but the raw bytes carry it");
});

test("parseAttestationResponse refuses anything that is not the burn we made, and says which field disagreed", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["another recipient", { mintRecipient: ("0x" + "11".repeat(32)) as `0x${string}` }, /mint recipient/],
    ["another amount", { amount: 1n }, /amount/],
    ["another domain", { destinationDomain: 5 }, /destination domain/],
  ];
  for (const [label, over, why] of cases) {
    const out = parseAttestationResponse(recorded, { ...recordedExpectation, ...over } as never);
    assert.equal(out.kind, "mismatch", label);
    if (out.kind === "mismatch") assert.match(out.why, why, label);
  }
  // A nonce we never burned is not ours at all: not-found, so the keeper keeps waiting rather than delivering.
  assert.equal(parseAttestationResponse(recorded, { ...recordedExpectation, nonce: ("0x" + "aa".repeat(32)) as `0x${string}` }).kind, "not-found");
  // Bytes that are not a V2 burn message.
  const junk = { messages: [{ ...recordedMsg, message: "0xdeadbeef" }] };
  const j = parseAttestationResponse(junk, recordedExpectation);
  assert.equal(j.kind, "mismatch");
  if (j.kind === "mismatch") assert.match(j.why, /not a CCTP V2 burn message/);
  // A half-length attestation is refused, never split.
  const half = { messages: [{ ...recordedMsg, attestation: recordedMsg.attestation.slice(0, 100) as `0x${string}` }] };
  assert.equal(parseAttestationResponse(half, recordedExpectation).kind, "mismatch");
});

test("parseAttestationResponse: pending and not-found are distinguished, so a keeper waits instead of failing", () => {
  assert.equal(parseAttestationResponse({ messages: [] }, recordedExpectation).kind, "not-found");
  assert.equal(parseAttestationResponse({}, recordedExpectation).kind, "not-found");
  assert.equal(parseAttestationResponse(null, recordedExpectation).kind, "not-found");
  const pending = { messages: [{ ...recordedMsg, attestation: "0x", status: "pending_confirmations", delayReason: null }] };
  const p = parseAttestationResponse(pending, recordedExpectation);
  assert.equal(p.kind, "pending");
  if (p.kind === "pending") assert.equal(p.status, "pending_confirmations");
  // Attested bytes but a status that is not complete: still pending, never delivered early.
  const notYet = { messages: [{ ...recordedMsg, status: "pending_confirmations", delayReason: "waiting for finality" }] };
  const n = parseAttestationResponse(notYet, recordedExpectation);
  assert.equal(n.kind, "pending");
  if (n.kind === "pending") assert.equal(n.delayReason, "waiting for finality");
});
