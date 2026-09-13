import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, type Hex } from "viem";
import { base } from "viem/chains";
import { rungById } from "@zyo/shared";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { ACCOUNT_A, ACCOUNT_B, FACTORY, OWNER_A, OWNER_B, cbBtcPosition, debtForHf, newLiveClockMockChain as newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, "..", "src", "index.js"); // dist/src/index.js when compiled

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-live-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = "0x2000000000000000000000000000000000000001" as const;
const LP_VENUE = "0x2000000000000000000000000000000000000002" as const;

function baseEnv(url: string, storePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    BASE_RPC_URL: url,
    ACCOUNT_FACTORY_ADDRESS: FACTORY,
    STORE_PATH: storePath,
    DISCOVERY_FROM_BLOCK: "0",
    HEALTH_POLL_MS: "150",
    RPC_DEADLINE_MS: "1000",
    WATCHDOG_STALL_MS: "3000",
    BACKOFF_MAX_MS: "1000",
    LOG_LEVEL: "info",
    NOTIFY_ALLOW_LOG_ONLY: "1",
    ...extra,
  };
}

describe("real-process liveness (spawns dist/src/index.js)", () => {
  it("runs ≥ 3 ticks, keeps the event loop alive, exits 0 on SIGTERM and releases the store lock", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0));
    const server = await chain.listen();
    const storePath = join(dir, "live1.json");
    // A provider-style URL with a key in the path: it must never appear in the logs.
    const child = spawn(process.execPath, [ENTRY], { env: baseEnv(`${server.url}/v2/SECRETKEY123`, storePath), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const heartbeats = () => out.split("\n").filter((l) => l.includes('"msg":"heartbeat"')).length;
    const deadline = Date.now() + 15_000;
    while (heartbeats() < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(heartbeats() >= 3, `only ${heartbeats()} heartbeats\nstdout:\n${out}\nstderr:\n${err}`);
    // The lock exists while running.
    await stat(`${storePath}.lock`);
    // The daemon did not exit on its own (the round-1 bug).
    assert.equal(child.exitCode, null);

    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
    child.kill("SIGTERM");
    const res = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no exit after SIGTERM")), 10_000))]);
    await server.close();
    assert.equal(res.code, 0, `exit ${res.code}/${res.signal}\nstdout:\n${out}\nstderr:\n${err}`);
    assert.ok(out.includes('"msg":"shutdown requested"'));
    assert.ok(out.includes('"msg":"stopped"'));
    await assert.rejects(stat(`${storePath}.lock`), /ENOENT/, "lock released");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(store.accounts.length, 1);
    // Nothing secret-shaped in the output; the RPC URL is reduced to its origin.
    assert.ok(!out.includes("SECRETKEY123"), "RPC URL path (API key) leaked");
    assert.ok(out.includes(`"rpcUrl":"${server.url}/…"`), "origin is still logged");
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(out.replace(/"txHash":"0x[0-9a-fA-F]{64}"/g, "")), "32-byte hex outside txHash");
  });

  it("exits 1 with a redacted message on bad config (never echoing the key) and holds no lock", async () => {
    const chain = newMockChain();
    const server = await chain.listen();
    const storePath = join(dir, "live2.json");
    const child = spawn(process.execPath, [ENTRY], {
      env: baseEnv(server.url, storePath, { KEEPER_PRIVATE_KEY: "0xnotakeySECRETVALUE" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const res = await new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    await server.close();
    assert.equal(res, 1);
    assert.match(err, /KEEPER_PRIVATE_KEY/);
    assert.doesNotMatch(err, /SECRETVALUE/);
    await assert.rejects(stat(`${storePath}.lock`), /ENOENT/);
  });

  it("refuses to start on the wrong chain id, before touching the store", async () => {
    const chain = newMockChain();
    chain.chainId = 1;
    const server = await chain.listen();
    const storePath = join(dir, "live3.json");
    const child = spawn(process.execPath, [ENTRY], { env: baseEnv(server.url, storePath), stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    await server.close();
    assert.equal(code, 1);
    assert.match(err, /chain id 1, config expects 8453/);
    await assert.rejects(stat(storePath), /ENOENT/);
  });

  it("a second process against the same store is refused by the link() lock and exits 1", async () => {
    const chain = newMockChain();
    const server = await chain.listen();
    const storePath = join(dir, "live4.json");
    const first = spawn(process.execPath, [ENTRY], { env: baseEnv(server.url, storePath), stdio: ["ignore", "pipe", "pipe"] });
    let out1 = "";
    first.stdout.on("data", (d) => (out1 += d));
    const t0 = Date.now();
    while (!out1.includes('"msg":"heartbeat"') && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const second = spawn(process.execPath, [ENTRY], { env: baseEnv(server.url, storePath), stdio: ["ignore", "pipe", "pipe"] });
    let err2 = "";
    second.stderr.on("data", (d) => (err2 += d));
    const code2 = await new Promise<number | null>((r) => second.on("exit", (c) => r(c)));
    assert.equal(code2, 1);
    assert.match(err2, /locked — held by pid/);
    const exited = new Promise<number | null>((r) => first.on("exit", (c) => r(c)));
    first.kill("SIGTERM");
    assert.equal(await exited, 0);
    await server.close();
  });
});

describe("runKeeper in-process — end to end in keeper mode", () => {
  it("discovers, fires a rung, sends execAsKeeper via the real dispatcher, the mock repays, HF recovers and the rung re-arms", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.15)); // repay rung
    cbBtcPosition(chain, ACCOUNT_B, debtForHf(2.0)); // healthy
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A, ACCOUNT_B]);
    const keeper = privateKeyToAccount(KEY).address;
    // EXACTLY the one Permission the web signs.
    oil.grant(keeper, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    const POOL = ("0x" + "aa".repeat(32)) as Hex;
    oil.poolPrices.set(POOL, 10n ** 30n);
    oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL }, { id: 2n, poolId: POOL }, { id: 3n, poolId: POOL }]);
    oil.defaultCloseYield = { usdc: 15_000_000_000n, other: 0n }; // 15,000 USDC per closed id

    const storePath = join(dir, "e2e.json");
    const sink = memorySink();
    const reports: { fired: (string | null)[]; dispatch: string[] }[] = [];
    {
      const { ticks } = await runKeeper(
        {
          BASE_RPC_URL: "http://mock.invalid",
          ACCOUNT_FACTORY_ADDRESS: FACTORY,
          STORE_PATH: storePath,
          DISCOVERY_FROM_BLOCK: "0",
          NOTIFY_ALLOW_LOG_ONLY: "1",
          KEEPER_PRIVATE_KEY: KEY,
          STRATEGY_ROUTER_ADDRESS: ROUTER,
          HEALTH_POLL_MS: "20",
          RPC_DEADLINE_MS: "500",
          WATCHDOG_STALL_MS: "2000",
          LOG_LEVEL: "debug",
        },
        {
          sink: sink.sink,
          maxTicks: 3,
          makeClient: () => chain.publicClient(),
          makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
          onTick: (r) => reports.push({ fired: r.outcomes.map((o) => o.fired), dispatch: r.outcomes.map((o) => o.dispatch?.status ?? "-") }),
        }
      );
      assert.equal(ticks, 3);
    }
    // Tick 1: repay fired for A, SENT. Tick 2: SENT confirmed on resume; HF recovered → re-arm.
    assert.ok(reports[0].fired.includes("repay"), JSON.stringify(reports));
    assert.ok(reports[0].dispatch.includes("SENT"));
    assert.deepEqual(oil.txFrom, [keeper]);
    assert.equal(oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 2);
    const store = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(store.dispatches.length, 1);
    assert.equal(store.dispatches[0].status, "CONFIRMED");
    assert.equal(store.dispatches[0].key, `${ACCOUNT_A.toLowerCase()}:1:1:repay`);
    const a = store.accounts.find((x: { account: string }) => x.account === ACCOUNT_A.toLowerCase());
    assert.ok(a.lastHf >= rungById("warn").disarmHf, `HF after repay ${a.lastHf}`);
    assert.deepEqual(a.ladder.fired, []); // re-armed: HF ≥ repay.disarm and warn.disarm
    assert.equal(a.episode, null);
    const lines = sink.lines.join("\n");
    assert.ok(!lines.includes(KEY.slice(2)), "key leaked into logs");
    assert.ok(lines.includes('"mode":"keeper"'));
  });

  it("watchdog: a tick wedged in an await that ignores its signal is abandoned, the daemon keeps ticking with backoff, and the abandoned dispatch is resumed with its key", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.2)); // warn → notify
    const storePath = join(dir, "wd.json");
    const sink = memorySink();
    const aborted: boolean[] = [];
    let dispatchCalls = 0;
    const keysSeen: string[] = [];
    // Every RPC and hook the keeper owns is bounded by a deadline; the residual
    // risk is a component that ignores its signal (a bug). Model it with a
    // dispatcher whose first call hangs forever: the watchdog must abandon the
    // tick, the loop must go on, and the PENDING record must be resumed.
    {
      const { ticks } = await runKeeper(
        {
          BASE_RPC_URL: "http://mock.invalid",
          ACCOUNT_FACTORY_ADDRESS: FACTORY,
          STORE_PATH: storePath,
          DISCOVERY_FROM_BLOCK: "0",
          NOTIFY_ALLOW_LOG_ONLY: "1",
          HEALTH_POLL_MS: "10",
          RPC_DEADLINE_MS: "150",
          WATCHDOG_STALL_MS: "200",
          BACKOFF_MAX_MS: "40",
          LOG_LEVEL: "debug",
        },
        {
          sink: sink.sink,
          maxTicks: 3,
          makeClient: () => chain.publicClient(),
          makeDispatcher: () => ({
            dispatch: async ({ record }) => {
              dispatchCalls++;
              keysSeen.push(record.key);
              if (dispatchCalls === 1) return new Promise(() => undefined); // wedged, ignores the signal
              return { status: "NOTIFIED" as const };
            },
            confirm: async () => ({ status: "FAILED" as const, error: "n/a" }),
          }),
          onTick: (r) => aborted.push(r.aborted),
        }
      );
      assert.equal(ticks, 3);
    }
    assert.deepEqual(aborted, [true, false, false]);
    const lines = sink.lines.join("\n");
    assert.ok(lines.includes("WATCHDOG: tick stalled"), lines);
    assert.ok(lines.includes('"stalls":1'));
    // Backoff raised after the stall (min(poll×2^0, max) = 10) and reset to 0 by the next progressing tick.
    assert.ok(/"heartbeat".*"ticks":1.*"backoffMs":10/.test(lines), lines);
    assert.ok(/"heartbeat".*"ticks":2.*"backoffMs":0/.test(lines), lines);
    // The wedged dispatch was resumed on tick 2 under the SAME key and completed.
    const store = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(store.dispatches.length, 1);
    assert.equal(store.dispatches[0].status, "NOTIFIED");
    assert.equal(dispatchCalls, 2);
    assert.deepEqual(keysSeen, [store.dispatches[0].key, store.dispatches[0].key]);
    assert.ok(lines.includes("resuming dispatch with its persisted key"));
  });
});
