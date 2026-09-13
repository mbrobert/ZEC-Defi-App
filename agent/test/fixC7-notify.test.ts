import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { rungById } from "@zyo/shared";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import type { KeeperEvent } from "../src/notify/notifier.js";
import { ACCOUNT_A, FACTORY, OWNER_A, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc6-notify.test.js — expectations FLIPPED.
 *
 * The PoC spawned the shipped `dist/src/index.js` at the `warn` rung and
 * recorded THE ENTIRE user-facing output of the protection they were shown
 * before signing:
 *
 *     {"ts":"…","level":"warn","msg":"NOTIFY: health warning","svc":"keeper",…}
 *     stderr: ""
 *
 * `runKeeper(process.env)` passed no `notify` and no `onEscalate`, so the hook
 * was a permanent no-op and every escalation — UNKNOWN streaks, ABANDONED
 * dispatches, refused grants, store failures — reached one log file on a
 * machine the user cannot see.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = "0x2000000000000000000000000000000000000001" as const;
const LP_VENUE = "0x2000000000000000000000000000000000000002" as const;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL = ("0x" + "aa".repeat(32)) as Hex;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixC7-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function env(storePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    BASE_RPC_URL: "http://mock.invalid",
    ACCOUNT_FACTORY_ADDRESS: FACTORY,
    STORE_PATH: storePath,
    DISCOVERY_FROM_BLOCK: "0",
    KEEPER_PRIVATE_KEY: KEY,
    STRATEGY_ROUTER_ADDRESS: ROUTER,
    HEALTH_POLL_MS: "10",
    RPC_DEADLINE_MS: "2000",
    WATCHDOG_STALL_MS: "5000",
    LOG_LEVEL: "info",
    NOTIFY_ALLOW_LOG_ONLY: "1",
    ...extra,
  };
}

describe("FIX C-7: every rung and every escalation leaves the keeper host", () => {
  it("FIX C-7: the warn rung and the on-chain rungs both reach a real channel", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.2)); // warn
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    oil.poolPrices.set(POOL, 10n ** 30n);
    oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL }]);
    oil.defaultCloseYield = { usdc: 20_000_000_000n, other: 0n };

    const delivered: KeeperEvent[] = [];
    const storePath = join(dir, "notify.json");
    await runKeeper(env(storePath), {
      sink: memorySink().sink,
      maxTicks: 1,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      notifyChannel: { name: "test", send: async (e) => void delivered.push(e) },
    });
    // Was: nothing left the process at all.
    assert.ok(delivered.some((e) => e.kind === "notify" && e.rung === "warn"), JSON.stringify(delivered.map((e) => e.kind)));
    assert.ok(delivered.some((e) => e.kind === "rung-fired"));
    const notify = delivered.find((e) => e.kind === "notify")!;
    assert.equal(notify.account, ACCOUNT_A.toLowerCase());
    assert.ok(typeof notify.hf === "number" && notify.hf < rungById("warn").hf);
    assert.ok(notify.at.length > 0);

    // …and an on-chain rung reports its outcome on the same channel.
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.02)); // emergency
    await runKeeper(env(storePath), {
      sink: memorySink().sink,
      maxTicks: 1,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      notifyChannel: { name: "test", send: async (e) => void delivered.push(e) },
    });
    const dispatchEvents = delivered.filter((e) => e.kind === "dispatch");
    assert.ok(dispatchEvents.length > 0, "an on-chain rung must report its outcome");
    assert.ok(dispatchEvents.some((e) => e.status === "SENT" || e.status === "CONFIRMED"));
    assert.ok(delivered.some((e) => e.severity === "critical"), "the last-resort rung is critical");
  });

  it("FIX C-7: a refused grant is escalated to the channel as a configuration error the USER must fix", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.02));
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setUsdc(ACCOUNT_A, 1_000_000_000n);
    // The grant exists but was issued without the peripheral opt-in.
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"], { allowCallback: false });

    const delivered: KeeperEvent[] = [];
    await runKeeper(env(join(dir, "misgrant.json")), {
      sink: memorySink().sink,
      maxTicks: 1,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      notifyChannel: { name: "test", send: async (e) => void delivered.push(e) },
    });
    const misgrant = delivered.find((e) => e.kind === "grant-misconfigured");
    assert.ok(misgrant, JSON.stringify(delivered.map((e) => `${e.kind}:${e.status ?? ""}`)));
    assert.ok(misgrant!.reasons!.some((r) => r.includes("allowCallback=false")));
    assert.equal(oil.txFrom.length, 0, "nothing may be broadcast against a mis-issued grant");
  });

  it("FIX C-7: a webhook is POSTed per event, and a keeper with NO channel says so loudly at startup", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.2));
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);

    const posts: { url: string; body: unknown; auth?: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = memorySink();
    await runKeeper(
      env(join(dir, "webhook.json"), { NOTIFY_WEBHOOK_URL: "https://pager.example/hook/SECRET", NOTIFY_WEBHOOK_TOKEN: "t0ken" }),
      {
        sink: sink.sink,
        maxTicks: 1,
        makeClient: () => chain.publicClient(),
        makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
        fetchImpl,
      }
    );
    assert.ok(posts.length > 0, "the webhook must receive the rung");
    assert.equal(posts[0].url, "https://pager.example/hook/SECRET");
    assert.equal(posts[0].auth, "Bearer t0ken");
    assert.ok((posts[0].body as { kind: string }).kind.length > 0);
    // The URL's path and the token are secrets: neither may appear in a log line.
    const lines = sink.lines.join("\n");
    assert.ok(!lines.includes("SECRET"), "webhook path leaked into the logs");
    assert.ok(!lines.includes("t0ken"), "webhook token leaked into the logs");

    // With nothing person-facing configured the keeper REFUSES TO START (audit wave 2, N-MED-1):
    // its own log and store accept every event and reach nobody, so "NOTIFIED" would be a lie.
    const sink2 = memorySink();
    await assert.rejects(
      () =>
        runKeeper(env(join(dir, "nochannel.json"), { NOTIFY_ALLOW_LOG_ONLY: "0" }), {
          sink: sink2.sink,
          maxTicks: 1,
          makeClient: () => chain.publicClient(),
          makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
        }),
      /NOTIFY_WEBHOOK_URL.*no person-facing notification channel/
    );
    assert.ok(sink2.lines.some((l) => l.includes("NO PERSON-FACING NOTIFICATION CHANNEL")));

    // An operator can opt into log-only by name; the keeper then says so at startup and every
    // warning is LOGGED_ONLY, never NOTIFIED.
    const sink3 = memorySink();
    const logOnlyChain = newMockChain();
    cbBtcPosition(logOnlyChain, ACCOUNT_A, debtForHf(1.2)); // warn rung
    logOnlyChain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    const logOnlyOil = new MockOilskin(logOnlyChain, { router: ROUTER, lpVenue: LP_VENUE });
    logOnlyOil.install([ACCOUNT_A]);
    logOnlyOil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    const statuses: string[] = [];
    await runKeeper(env(join(dir, "logonly.json"), { NOTIFY_ALLOW_LOG_ONLY: "1" }), {
      sink: sink3.sink,
      maxTicks: 2,
      makeClient: () => logOnlyChain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: logOnlyChain.transport() }),
      onTick: (r) => {
        for (const o of r.outcomes) if (o.dispatch) statuses.push(o.dispatch.status);
      },
    });
    assert.ok(sink3.lines.some((l) => l.includes("running log-only")));
    assert.ok(statuses.includes("LOGGED_ONLY"), `warn rung recorded LOGGED_ONLY, got ${statuses.join(",")}`);
    assert.ok(!statuses.includes("NOTIFIED"), "nothing may be NOTIFIED without a person-facing channel");
  });
});
