/**
 * The cross-chain rung as a resumable stage machine (BUILD-PLAN D6 / Stream C; `SOLANA-ARCHITECTURE.md` §14.6).
 * The monitor re-enters a SENT record every tick, so what matters is that each stage either advances or waits,
 * and that only a real disagreement ends it. The send itself is proven against a validator in
 * `solana/tests/crosschain.spec.ts`; everything here is the decision around it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CCTP_DOMAINS, CCTP_V2_BASE, encodeCctpBurnMessageV2, evmAddressToBytes32 } from "@zyo/shared";
import type { BurnResult } from "../src/dispatch/types.js";
import { Logger, memorySink } from "../src/log.js";
import type { AttestationResult } from "../src/solana/attestation.js";
import { KeeperSolanaDispatcher, type BaseBurner, type SolanaDispatchRecord } from "../src/solana/dispatcher.js";
import { PK, ata, OILSKIN_ERRORS } from "../src/solana/layouts.js";
import { usedNoncePda } from "../src/solana/delivery.js";

const OWNER = Keypair.generate().publicKey;
const ACCOUNT = Keypair.generate().publicKey;
const RECIPIENT = ata(ACCOUNT, PK.usdcMint);
const NONCE = new Uint8Array(32).fill(9);
const NONCE_HEX = ("0x" + Buffer.from(NONCE).toString("hex")) as `0x${string}`;
const RECIPIENT_HEX = ("0x" + Buffer.from(RECIPIENT.toBytes()).toString("hex")) as `0x${string}`;
const BURN_TX = "0x" + "ab".repeat(32);
const AMOUNT = 4_000_000_000n;

const message = encodeCctpBurnMessageV2({
  version: 1,
  sourceDomain: CCTP_DOMAINS.base,
  destinationDomain: CCTP_DOMAINS.solana,
  nonce: NONCE,
  sender: evmAddressToBytes32(CCTP_V2_BASE.tokenMessengerV2),
  recipient: new Uint8Array(32).fill(0xa6),
  destinationCaller: new Uint8Array(32),
  minFinalityThreshold: 1000,
  finalityThresholdExecuted: 1000,
  body: {
    version: 1,
    burnToken: evmAddressToBytes32("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    mintRecipient: RECIPIENT.toBytes(),
    amount: AMOUNT,
    messageSender: evmAddressToBytes32("0x1646587E543bC2f63137bAa86F8598E1274aED78"),
    maxFee: 400_000n,
    feeExecuted: 400n,
    expirationBlock: 51_260_000n,
    hookData: new Uint8Array(0),
  },
});
const MESSAGE_HEX = ("0x" + Buffer.from(message).toString("hex")) as `0x${string}`;
const ATTESTATION_HEX = ("0x" + "11".repeat(130)) as `0x${string}`;

function record(stage: NonNullable<SolanaDispatchRecord["bridge"]>["stage"], over: Record<string, unknown> = {}): SolanaDispatchRecord {
  const now = "2026-09-13T15:00:00.000Z";
  return {
    key: `${ACCOUNT.toBase58()}:1:1:derisk`,
    account: ACCOUNT.toBase58(),
    episode: 1,
    seq: 1,
    action: "derisk",
    rung: "derisk",
    hf: 1.1,
    status: "SENT",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    bridge: { chain: "base", stage, burnTxHash: BURN_TX, amountUsdc: AMOUNT.toString(), nonce: NONCE_HEX, recipient: RECIPIENT_HEX, ...over },
  };
}

/** Only the reads the stage machine makes: the used-nonce account, and the token messenger for the fee ATA. */
function connection(usedNonceExists: boolean) {
  return {
    getAccountInfo: async (key: PublicKey) => {
      if (key.equals(usedNoncePda(NONCE))) return usedNonceExists ? { data: Buffer.alloc(9), owner: PK.tokenProgram, lamports: 1, executable: false } : null;
      return { data: Buffer.alloc(177), owner: PK.tokenProgram, lamports: 1, executable: false };
    },
  } as never;
}

function rig(opts: { burner?: Partial<BaseBurner>; attest?: AttestationResult | null; usedNonce?: boolean } = {}) {
  const sink = memorySink();
  const burner: BaseBurner = {
    dispatch: async () => ({ status: "REFUSED", reason: "not used here" }) as BurnResult,
    confirm: async () => ({ status: "CONFIRMED", txHash: BURN_TX as `0x${string}`, bridge: { chain: "base", stage: "burn-confirmed", burnTxHash: BURN_TX, amountUsdc: AMOUNT.toString(), nonce: NONCE_HEX, messageHex: MESSAGE_HEX, recipient: RECIPIENT_HEX } }) as BurnResult,
    ...opts.burner,
  };
  const attestation = opts.attest === null ? null : ({ byNonce: async () => opts.attest ?? { kind: "not-found" as const }, byTx: async () => opts.attest ?? { kind: "not-found" as const } } as never);
  const d = new KeeperSolanaDispatcher({
    connection: connection(opts.usedNonce ?? false),
    reader: {} as never,
    programId: Keypair.generate().publicKey,
    keeper: Keypair.generate(),
    rungs: [{ id: 0, disarmHf: 1.25 }, { id: 1, disarmHf: 1.18 }, { id: 2, disarmHf: 1.11 }, { id: 3, disarmHf: 1.07 }],
    rungIndex: () => 2,
    valuationParams: { priceMaxAgeS: 180, independentMaxAgeS: 120, oracleDeviationBps: 200, hfToleranceBps: 100, requireIndependent: false },
    saleDiscountBps: 0,
    keeperMaxSaleUsdc: 0n,
    planMarginBps: 50,
    confirmTimeoutMs: 2_000,
    idlErrors: OILSKIN_ERRORS,
    log: new Logger(sink.sink, "debug"),
    baseBurner: burner,
    attestation,
  });
  return { d, lines: sink.lines as string[] };
}

describe("the bridge stage machine", () => {
  it("burn-sent: a confirmed Base receipt advances the record to burn-confirmed and KEEPS it open — the rung is not answered until the USDC is home", async () => {
    const r = rig();
    const out = await r.d.confirm(record("burn-sent"));
    assert.equal(out.status, "SENT", "still resumable: attestation and delivery are still to come");
    if (out.status !== "SENT") return;
    assert.equal(out.bridge?.stage, "burn-confirmed");
    assert.equal(out.bridge?.nonce, NONCE_HEX);
    assert.equal(out.bridge?.messageHex, MESSAGE_HEX);
  });

  it("burn-sent: a Base receipt that fails ends the rung, and one with no burner is named rather than silently waiting", async () => {
    const failed = rig({ burner: { confirm: async () => ({ status: "FAILED", error: "burn transaction reverted on chain" }) as BurnResult } });
    const out = await failed.d.confirm(record("burn-sent"));
    assert.equal(out.status, "FAILED");
    if (out.status === "FAILED") assert.match(out.error, /reverted/);
  });

  it("burn-confirmed: every answer that is not an attestation is a WAIT — pending, not indexed, or the service being down all leave the record open", async () => {
    for (const [label, att] of [
      ["pending", { kind: "pending", status: "pending_confirmations", delayReason: null }],
      ["delayed", { kind: "pending", status: "pending_confirmations", delayReason: "waiting for finality" }],
      ["not indexed", { kind: "not-found" }],
      ["service down", { kind: "unavailable", why: "attestation service answered 502" }],
    ] as [string, AttestationResult][]) {
      const r = rig({ attest: att });
      const out = await r.d.confirm(record("burn-confirmed"));
      assert.equal(out.status, "SENT", label);
      if (out.status === "SENT") assert.equal(out.bridge?.stage, "burn-confirmed", `${label}: the stage does not move`);
    }
    // and with no attestation client at all the record simply waits rather than failing
    const none = rig({ attest: null });
    const out = await none.d.confirm(record("burn-confirmed"));
    assert.equal(out.status, "SENT");
  });

  it("burn-confirmed: a message that is not our burn ENDS the rung by name — it is never delivered", async () => {
    const r = rig({ attest: { kind: "mismatch", why: "amount 1 is not the burned 4000000000" } });
    const out = await r.d.confirm(record("burn-confirmed"));
    assert.equal(out.status, "FAILED");
    if (out.status === "FAILED") assert.match(out.error, /is not the burn we made: amount 1/);
  });

  it("burn-confirmed: a record with no nonce cannot be asked about, and says so instead of guessing", async () => {
    const r = rig({ attest: { kind: "not-found" } });
    const out = await r.d.confirm(record("burn-confirmed", { nonce: undefined }));
    assert.equal(out.status, "FAILED");
    if (out.status === "FAILED") assert.match(out.error, /no nonce or recipient/);
  });

  it("attested: a nonce Circle has already recorded means someone else delivered it — a success, not a race lost, and nothing is sent", async () => {
    const r = rig({ usedNonce: true });
    const out = await r.d.confirm(record("attested", { messageHex: MESSAGE_HEX, attestationHex: ATTESTATION_HEX }));
    assert.equal(out.status, "CONFIRMED");
    if (out.status !== "CONFIRMED") return;
    assert.equal(out.bridge?.stage, "delivered");
    assert.match(out.note ?? "", /already delivered/);
    assert.ok(r.lines.some((l) => l.includes("already delivered")));
  });

  it("attested: an attestation complete in the same call goes straight to the delivery, without waiting a tick", async () => {
    const r = rig({
      usedNonce: true, // so the delivery resolves without a validator
      attest: { kind: "complete", messageHex: MESSAGE_HEX, attestationHex: ATTESTATION_HEX, message: { body: { amount: AMOUNT } } as never, feeExecuted: 400n, deliveredAmount: AMOUNT - 400n },
    });
    const out = await r.d.confirm(record("burn-confirmed"));
    assert.equal(out.status, "CONFIRMED", "attested and delivered in one pass");
    if (out.status !== "CONFIRMED") return;
    assert.equal(out.bridge?.stage, "delivered");
    assert.equal(out.bridge?.attestationHex, ATTESTATION_HEX);
    assert.equal(out.bridge?.deliveredAmountUsdc, (AMOUNT - 400n).toString(), "what lands is the burn less Circle's fee");
  });

  it("attested: without a lookup table the delivery is REFUSED by name — never sent and rejected for its size", async () => {
    // receive_message carries 21 accounts plus Circle's message and signatures: 1,264 bytes as a legacy
    // transaction against the 1,232 limit, measured on localnet 2026-09-13. The table is a deploy artefact.
    const r = rig({ usedNonce: false });
    const out = await r.d.confirm(record("attested", { messageHex: MESSAGE_HEX, attestationHex: ATTESTATION_HEX }));
    assert.equal(out.status, "REFUSED");
    if (out.status !== "REFUSED") return;
    assert.equal(out.permanent, true, "no retry will make a transaction smaller");
    assert.match(out.reason, /address lookup table/);
    assert.match(out.reason, /CCTP_LOOKUP_TABLE/);
  });

  it("attested: a record with no message or attestation is a fault, not a wait", async () => {
    const r = rig();
    const out = await r.d.confirm(record("attested"));
    assert.equal(out.status, "FAILED");
    if (out.status === "FAILED") assert.match(out.error, /no message or attestation/);
  });

  it("delivered: re-entering a finished bridge is idempotent and says the repay is the next rung firing", async () => {
    const r = rig();
    const out = await r.d.confirm(record("delivered", { deliveredAmountUsdc: (AMOUNT - 400n).toString(), deliveryTx: "5".repeat(88) }));
    assert.equal(out.status, "CONFIRMED");
    if (out.status !== "CONFIRMED") return;
    assert.match(out.note ?? "", /the repay is the next rung firing/);
    assert.equal(out.bridge?.stage, "delivered");
  });
});
