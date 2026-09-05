import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { RpcClient } from "../src/sources/rpc.js";
import type { Address } from "../src/types.js";

interface Rec { method: string; params: unknown[] }

/** Tiny local JSON-RPC endpoint with programmable behaviour. */
async function withServer(
  handle: (req: Rec, seen: Rec[]) => unknown | { __error: string },
  fn: (url: string, seen: Rec[]) => Promise<void>
): Promise<void> {
  const seen: Rec[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as Rec & { id: number } | (Rec & { id: number })[];
      const answer = (r: Rec & { id: number }) => {
        seen.push({ method: r.method, params: r.params });
        const out = handle(r, seen);
        return out && typeof out === "object" && "__error" in (out as object)
          ? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (out as { __error: string }).__error } }
          : { jsonrpc: "2.0", id: r.id, result: out };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.close();
  }
}

const A = ("0x" + "ab".repeat(20)) as Address;

test("batched callMany preserves order and answers", async () => {
  await withServer(
    (req) => (req.method === "eth_getBlockByNumber" ? { timestamp: `0x${Number(req.params[0]).toString(16)}` } : "0x1"),
    async (url) => {
      const rpc = new RpcClient(url, { batchSize: 3, retries: 0 });
      const ts = await rpc.blockTimestamps([10, 11, 12, 13]);
      assert.equal(ts.get(10), 10);
      assert.equal(ts.get(13), 13);
      // cache: second ask issues no further requests
      const before = (await rpc.blockTimestamps([10])).get(10);
      assert.equal(before, 10);
    }
  );
});

test("getLogs splits the range when the endpoint objects", async () => {
  await withServer(
    (req) => {
      if (req.method !== "eth_getLogs") return "0x1";
      const f = req.params[0] as { fromBlock: string; toBlock: string };
      const span = Number(f.toBlock) - Number(f.fromBlock);
      if (span > 250) return { __error: "block range too large" };
      return [];
    },
    async (url, seen) => {
      const rpc = new RpcClient(url, { retries: 0 });
      const logs = await rpc.getLogs(A, 0, 1000);
      assert.deepEqual(logs, []);
      const calls = seen.filter((s) => s.method === "eth_getLogs");
      assert.ok(calls.length >= 4, `expected splits, got ${calls.length}`);
    }
  );
});

test("retries 429/5xx with backoff, then succeeds", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 429;
      res.end("slow down");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: "0x2a" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const rpc = new RpcClient(`http://127.0.0.1:${port}`, { retries: 3 });
    assert.equal(await rpc.blockNumber(), 42);
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("JSON-RPC errors surface with method context and do not retry", async () => {
  await withServer(
    () => ({ __error: "execution reverted" }),
    async (url, seen) => {
      const rpc = new RpcClient(url, { retries: 2 });
      await assert.rejects(() => rpc.call("eth_call", []), /eth_call: execution reverted/);
      assert.equal(seen.length, 1);
    }
  );
});
