import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Logger, memorySink, redactString, redactValue } from "../src/log.js";

const KEY = "0x" + "ab".repeat(32);
const TX = "0x" + "cd".repeat(32);

describe("log — redaction", () => {
  it("redacts any 32-byte hex in free text (private keys look like tx hashes)", () => {
    assert.equal(redactString(`key=${KEY} done`), "key=0x[redacted] done");
    // Hex longer than 64 nibbles is not a key/hash and is left alone.
    assert.equal(redactString(KEY + "ff"), KEY + "ff");
  });

  it("reduces URLs to origin (API keys live in path/userinfo)", () => {
    assert.equal(redactString("rpc https://u:pw@rpc.example/v2/KEY?x=1 ok"), "rpc https://rpc.example/… ok");
    assert.equal(redactString("ws wss://rpc.example/KEY"), "ws wss://rpc.example/…");
  });

  it("redacts bearer tokens and secret-named fields regardless of value", () => {
    assert.equal(redactString("Authorization: Bearer eyJhbGciOi.xxx.yyy"), "Authorization: Bearer [redacted]");
    const v = redactValue({ privateKey: "short", jwt: "j", token: "t", apiKey: "k", password: "p", authorization: "a", keeperPrivateKey: "x" }) as Record<string, unknown>;
    for (const k of Object.keys(v)) assert.equal(v[k], "[redacted]", k);
  });

  it("keeps tx/block hashes under allow-listed field names, redacts them elsewhere", () => {
    const v = redactValue({ txHash: TX, blockHash: TX, hash: TX, other: TX, nested: { txHash: TX, note: `see ${TX}` } }) as Record<string, unknown>;
    assert.equal(v.txHash, TX);
    assert.equal(v.blockHash, TX);
    assert.equal(v.hash, TX);
    assert.equal(v.other, "0x[redacted]");
    assert.equal((v.nested as Record<string, unknown>).txHash, TX);
    assert.equal((v.nested as Record<string, unknown>).note, "see 0x[redacted]");
  });

  it("serialises bigints and Errors, bounds depth", () => {
    const v = redactValue({ n: 10n, e: new Error(`boom ${KEY}`), arr: [1n, { url: "https://a.b/c" }] }) as Record<string, unknown>;
    assert.equal(v.n, "10");
    assert.deepEqual(v.e, { name: "Error", message: "boom 0x[redacted]" });
    assert.deepEqual(v.arr, ["1", { url: "https://a.b/…" }]);
    let deep: Record<string, unknown> = { leaf: KEY };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    assert.doesNotMatch(JSON.stringify(redactValue(deep)), /abab/);
  });
});

describe("log — Logger", () => {
  it("emits JSON lines with bindings, respects level, redacts fields and message", () => {
    const m = memorySink();
    const log = new Logger(m.sink, "info", { svc: "keeper" }).child({ account: "0xabc" });
    log.debug("hidden");
    log.info(`start ${KEY}`, { txHash: TX, rpc: "https://x.y/KEY", privateKey: KEY });
    assert.equal(m.lines.length, 1);
    const rec = JSON.parse(m.lines[0]) as Record<string, unknown>;
    assert.equal(rec.level, "info");
    assert.equal(rec.svc, "keeper");
    assert.equal(rec.account, "0xabc");
    assert.equal(rec.msg, "start 0x[redacted]");
    assert.equal(rec.txHash, TX);
    assert.equal(rec.rpc, "https://x.y/…");
    assert.equal(rec.privateKey, "[redacted]");
    assert.doesNotMatch(m.lines[0], /abab/);
  });
});
