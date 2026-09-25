/**
 * The keeper's Circle fee-and-allowance client (CROSSCHAIN-RUNBOOK §5's "Fast versus Standard", closed
 * 2026-09-25). The parsing and the choice live in `@zyo/shared` and are tested there on the recorded live
 * answers; what is tested here is the transport: the documented URLs, a bounded and genuinely cancelled
 * request, and every network shape classified as `unavailable` — so an outage at Circle is a null the chooser
 * has a rule for, never a number and never a failed rung.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CCTP_DOMAINS, CCTP_IRIS } from "@zyo/shared";
import { CircleFeeClient } from "../src/solana/circleFees.js";
import { AbortedError } from "../src/services/deadline.js";
import { Logger, memorySink } from "../src/log.js";

const recorded = JSON.parse(readFileSync(new URL("../../../docs/research/cctp-fees-2026-09-25.json", import.meta.url), "utf8")) as {
  readAtIso: string;
  reads: { url: string; body: unknown }[];
};
const body = (suffix: string) => recorded.reads.find((r) => r.url.endsWith(suffix))!.body;
const FEES_6_5 = "/v2/burn/USDC/fees/6/5";
const ALLOWANCE = "/v2/fastBurn/USDC/allowance";
/** Circle's own `lastUpdated` on the recorded allowance, plus three seconds. */
const NOW_MS = Date.parse("2026-09-25T21:58:43.744Z");

function rig(handler: (url: string, init?: RequestInit) => Promise<Response> | Response, over: { baseUrl?: string; deadlineMs?: number } = {}) {
  const sink = memorySink();
  const seen: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  const client = new CircleFeeClient({ baseUrl: over.baseUrl ?? CCTP_IRIS.mainnet, deadlineMs: over.deadlineMs ?? 500, fetchImpl, log: new Logger(sink.sink, "debug"), now: () => NOW_MS });
  return { client, seen, lines: sink.lines as string[] };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const byPath = (url: string) => (url.endsWith(FEES_6_5) ? json(body(FEES_6_5)) : url.endsWith(ALLOWANCE) ? json(body(ALLOWANCE)) : json({}, 404));

describe("the Circle fee client", () => {
  it("asks Circle's documented URLs on the base it was given; a trailing slash does not double up; a non-URL base is refused", async () => {
    const r = rig(byPath);
    await r.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    await r.client.fastBurnAllowance();
    assert.deepEqual(r.seen, [`${CCTP_IRIS.mainnet}${FEES_6_5}`, `${CCTP_IRIS.mainnet}${ALLOWANCE}`]);
    const t = rig(byPath, { baseUrl: `${CCTP_IRIS.testnet}/` });
    await t.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.equal(t.seen[0], `${CCTP_IRIS.testnet}${FEES_6_5}`);
    assert.throws(() => new CircleFeeClient({ baseUrl: "not-a-url", deadlineMs: 500, log: new Logger(memorySink().sink, "debug") }), RangeError);
  });

  it("the recorded live answers come back parsed, and finalityInputs shapes them for the chooser with the allowance's age measured from Circle's own lastUpdated", async () => {
    const r = rig(byPath);
    const f = await r.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.equal(f.kind, "ok");
    if (f.kind === "ok") {
      assert.deepEqual(f.fees, { fastMinFeeBps: 1.3, standardMinFeeBps: 0 });
      assert.equal(f.readAtMs, NOW_MS);
    }
    const a = await r.client.fastBurnAllowance();
    assert.equal(a.kind, "ok");
    if (a.kind === "ok") assert.deepEqual(a.allowance, { allowanceUsdc: 54_436_850.827264, lastUpdatedIso: "2026-09-25T21:58:40.744Z" });
    const inputs = await r.client.finalityInputs(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.deepEqual(inputs.fees, { fastMinFeeBps: 1.3, standardMinFeeBps: 0 });
    assert.deepEqual(inputs.allowance, { allowanceUsdc: 54_436_850.827264, ageS: 3 });
    assert.deepEqual(inputs.notes, []);
  });

  it("every network shape is `unavailable`, never a number: 5xx, unreadable JSON, unreachable, a schedule that is not a schedule, and a deadline that aborts the request itself", async () => {
    const down = rig(() => json({ error: "x" }, 502));
    assert.deepEqual(await down.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana), { kind: "unavailable", why: `Circle's fee service answered 502 on ${FEES_6_5}` });
    const garbage = rig(() => new Response("<html>", { status: 200 }));
    const g = await garbage.client.fastBurnAllowance();
    assert.equal(g.kind, "unavailable");
    if (g.kind === "unavailable") assert.match(g.why, /unreadable JSON/);
    const unreachable = rig(() => Promise.reject(new TypeError("fetch failed")));
    const u = await unreachable.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.equal(u.kind, "unavailable");
    if (u.kind === "unavailable") assert.match(u.why, /unreachable: TypeError: fetch failed/);
    const half = rig(() => json([{ finalityThreshold: 1000, minimumFee: 1.3 }]));
    const h = await half.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.equal(h.kind, "unavailable");
    if (h.kind === "unavailable") assert.match(h.why, /not a schedule: RangeError: .*both the Fast/);
    const notAmount = rig(() => json({ allowance: "lots" }));
    const n = await notAmount.client.fastBurnAllowance();
    assert.equal(n.kind, "unavailable");
    if (n.kind === "unavailable") assert.match(n.why, /not an allowance/);
    // the deadline aborts the in-flight request: the handler sees the abort, and the answer is unavailable, not a hang
    let aborted = false;
    const slow = rig((_u, init) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })), { deadlineMs: 20 });
    const s = await slow.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.equal(s.kind, "unavailable");
    assert.ok(aborted, "the request itself was cancelled");
  });

  it("a tick's own abort unwinds as AbortedError rather than being reported as a Circle fault", async () => {
    const ctl = new AbortController();
    const r = rig((_u, init) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    const p = r.client.fees(CCTP_DOMAINS.base, CCTP_DOMAINS.solana, ctl.signal);
    ctl.abort(new Error("shutdown"));
    await assert.rejects(p, AbortedError);
  });

  it("finalityInputs: one unavailable read becomes null with a note and a warning, and the other still counts", async () => {
    const r = rig((url) => (url.endsWith(ALLOWANCE) ? json({}, 503) : byPath(url)));
    const inputs = await r.client.finalityInputs(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.deepEqual(inputs.fees, { fastMinFeeBps: 1.3, standardMinFeeBps: 0 });
    assert.equal(inputs.allowance, null);
    assert.deepEqual(inputs.notes, [`allowance: Circle's fee service answered 503 on ${ALLOWANCE}`]);
    assert.ok(r.lines.some((l) => /Fast allowance could not be read/.test(l)), r.lines.join("\n"));
    // an allowance with no usable timestamp has a null age — the chooser treats the figure as current
    const ageless = rig((url) => (url.endsWith(ALLOWANCE) ? json({ allowance: 100 }) : byPath(url)));
    const i2 = await ageless.client.finalityInputs(CCTP_DOMAINS.base, CCTP_DOMAINS.solana);
    assert.deepEqual(i2.allowance, { allowanceUsdc: 100, ageS: null });
  });
});
