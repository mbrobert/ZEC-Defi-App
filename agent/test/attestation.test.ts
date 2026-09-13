/**
 * The keeper's Circle attestation client (BUILD-PLAN D6 / Stream C, step 3). The judgement of a message lives
 * in `@zyo/shared` and is tested there against a recorded live answer; what is tested here is the transport a
 * keeper needs: the right URL, a bounded and genuinely cancelled request, and every network shape classified
 * so that "wait" is never confused with "this is not our burn".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CCTP_DOMAINS, CCTP_IRIS, decodeCctpBurnMessageV2 } from "@zyo/shared";
import { CircleAttestationClient } from "../src/solana/attestation.js";
import { AbortedError } from "../src/services/deadline.js";
import { Logger, memorySink } from "../src/log.js";

const recorded = JSON.parse(readFileSync(new URL("../../../docs/research/cctp-attestation-a9cb6989.json", import.meta.url), "utf8")) as {
  messages: { message: `0x${string}`; attestation: `0x${string}`; eventNonce: `0x${string}`; status: string }[];
};
const msg = recorded.messages[0]!;
const decoded = decodeCctpBurnMessageV2(Uint8Array.from(Buffer.from(msg.message.slice(2), "hex")));
const hex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
const EXPECT = {
  nonce: msg.eventNonce,
  mintRecipient: hex(decoded.body.mintRecipient),
  amount: decoded.body.amount,
  destinationDomain: decoded.destinationDomain,
};
const TX = "0xa9cb69894a97d99530c1274e8d8c7e7b148fc1b0e8b57a7ba267f5ed4ac32737";

function rig(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const sink = memorySink();
  const seen: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  const client = new CircleAttestationClient({ baseUrl: CCTP_IRIS.mainnet, deadlineMs: 500, fetchImpl, log: new Logger(sink.sink, "debug") });
  return { client, seen, lines: sink.lines as string[] };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the attestation client", () => {
  it("asks Circle's documented URL, by transaction and by nonce, on the base it was given", async () => {
    const r = rig(() => json(recorded));
    await r.client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    await r.client.byNonce(CCTP_DOMAINS.base, msg.eventNonce, EXPECT);
    assert.deepEqual(r.seen, [
      `${CCTP_IRIS.mainnet}/v2/messages/6?transactionHash=${TX}`,
      `${CCTP_IRIS.mainnet}/v2/messages/6?nonce=${msg.eventNonce}`,
    ]);
    const t = rig(() => json(recorded));
    const testnet = new CircleAttestationClient({ baseUrl: `${CCTP_IRIS.testnet}/`, deadlineMs: 500, fetchImpl: (async (u: unknown) => { t.seen.push(String(u)); return json(recorded); }) as unknown as typeof fetch, log: new Logger(memorySink().sink, "debug") });
    await testnet.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(t.seen[0], `${CCTP_IRIS.testnet}/v2/messages/6?transactionHash=${TX}`, "a trailing slash on the base does not double up");
    assert.throws(() => new CircleAttestationClient({ baseUrl: "not-a-url", deadlineMs: 500, log: new Logger(memorySink().sink, "debug") }), RangeError);
  });

  it("passes the recorded live answer through as complete, with the amount that will actually land", async () => {
    const r = rig(() => json(recorded));
    const out = await r.client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(out.kind, "complete");
    if (out.kind !== "complete") return;
    assert.equal(out.attestationHex, msg.attestation);
    assert.equal(out.deliveredAmount, out.message.body.amount - out.feeExecuted);
  });

  it("distinguishes waiting from failing: 404 and an empty list are not-found, a pending status is pending, 5xx and unreadable JSON are unavailable", async () => {
    assert.equal((await rig(() => new Response("", { status: 404 })).client.byTx(CCTP_DOMAINS.base, TX, EXPECT)).kind, "not-found");
    assert.equal((await rig(() => json({ messages: [] })).client.byTx(CCTP_DOMAINS.base, TX, EXPECT)).kind, "not-found");
    const pending = await rig(() => json({ messages: [{ ...msg, attestation: "0x", status: "pending_confirmations", delayReason: null }] })).client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(pending.kind, "pending");
    for (const status of [500, 502, 429]) {
      const out = await rig(() => new Response("nope", { status })).client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
      assert.equal(out.kind, "unavailable", `status ${status}`);
      if (out.kind === "unavailable") assert.match(out.why, new RegExp(String(status)));
    }
    const bad = await rig(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })).client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(bad.kind, "unavailable");
    const down = await rig(() => Promise.reject(new Error("ECONNREFUSED"))).client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(down.kind, "unavailable");
    if (down.kind === "unavailable") assert.match(down.why, /unreachable/);
  });

  it("a message that is not our burn is a mismatch, and it is logged at error — a keeper must never deliver it quietly", async () => {
    const r = rig(() => json(recorded));
    const out = await r.client.byTx(CCTP_DOMAINS.base, TX, { ...EXPECT, amount: 1n });
    assert.equal(out.kind, "mismatch");
    assert.ok(r.lines.some((l) => l.includes("ATTESTATION MISMATCH")), "the refusal reaches the log");
  });

  it("the request is really cancelled: the deadline aborts the fetch, and a cancelled tick unwinds rather than reporting a service fault", async () => {
    // A fetch that never settles unless its signal aborts — the deadline must be what ends it.
    const hang = rig((_u, init) =>
      new Promise<Response>((_res, rej) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      })
    );
    const started = Date.now();
    const out = await hang.client.byTx(CCTP_DOMAINS.base, TX, EXPECT);
    assert.equal(out.kind, "unavailable");
    assert.ok(Date.now() - started < 3000, "it did not wait forever");
    // The tick's own abort is not a Circle problem: it must propagate.
    const ctl = new AbortController();
    const onTick = rig((_u, init) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        queueMicrotask(() => ctl.abort(new Error("tick over")));
      })
    );
    await assert.rejects(() => onTick.client.byTx(CCTP_DOMAINS.base, TX, EXPECT, ctl.signal), (e: unknown) => e instanceof AbortedError);
  });
});
