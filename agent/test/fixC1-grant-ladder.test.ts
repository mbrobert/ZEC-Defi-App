import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { GRANT_SELECTORS, KEEPER_GRANT_SHAPE } from "../src/abi/oilskin.js";
import { planAction, type PoolInfo } from "../src/dispatch/policy.js";
import { NO_SWAP } from "../src/dispatch/quote.js";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { ACCOUNT_A, CBBTC, FACTORY, OWNER_A, cbBtcPosition, debtForHf, newLiveClockMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc1-lp-ladder.test.js — expectations FLIPPED.
 *
 * The PoC walked one realistic LP account (collateral supplied, USDC borrowed,
 * ALL of it deployed into the CL pool ⇒ zero idle USDC, three LP ids) down the
 * whole ladder under the grant `web/lib/plan.ts` actually signs — ONE
 * Permission for `StrategyRouter.unwind` — and recorded:
 *
 *     HF 1.30 repay      -> REFUSED   "no active grant … selector 0x812b00f2"
 *     HF 1.15 derisk     -> REFUSED
 *     HF 1.02 emergency  -> REFUSED → ABANDONED after 5 attempts
 *     transactions broadcast : 0        LP ids still open : [11,12,13]
 *
 * (The PoC ran on the 1.55-floor ladder of the time; the walk below sits each stage under the rungs of the
 * 1.25 floor's ladder — warn 1.23 / repay 1.16 / derisk 1.09 / emergency 1.05 — the keeper runs since D7.)
 *
 * because `planAction` opened with a ROOT `SnuggleLpVenue.closeMany` call that
 * the signed grant does not cover. The keeper's flagship user was never
 * protected once.
 *
 * The attack setup is kept verbatim; the assertions now demand protection.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = "0x2000000000000000000000000000000000000001" as const;
const LP_VENUE = "0x2000000000000000000000000000000000000002" as const;
const POOL = ("0x" + "aa".repeat(32)) as Hex;
const KEEPER = privateKeyToAccount(KEY).address;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixC1-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function env(storePath: string): NodeJS.ProcessEnv {
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
  };
}

async function walk(opts: { grant: boolean }) {
  const storePath = join(dir, `walk-${opts.grant ? "granted" : "ungranted"}.json`);
  const chain = newLiveClockMockChain();
  chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL, 10n ** 30n);
  oil.setPositions(ACCOUNT_A, [
    { id: 11n, poolId: POOL },
    { id: 12n, poolId: POOL },
    { id: 13n, poolId: POOL },
  ]);
  oil.setUsdc(ACCOUNT_A, 0n);
  oil.defaultCloseYield = { usdc: 15_000_000_000n, other: 0n }; // 15,000 USDC per closed id

  // ===== EXACTLY what web/lib/plan.ts encodeGrantWrite() signs =====
  if (opts.grant) oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);

  const rungs: [string, number][] = [
    ["healthy", 1.6],
    ["warn", 1.2],
    ["repay", 1.15],
    ["derisk", 1.08],
    ["emergency", 1.02],
  ];
  const log: { stage: string; ticks: string[] }[] = [];
  const sink = memorySink();
  for (const [stage, hf] of rungs) {
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(hf));
    const seen: string[] = [];
    await runKeeper(env(storePath), {
      sink: sink.sink,
      maxTicks: 2,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      onTick: (r) => {
        for (const o of r.outcomes) {
          if (o.account !== ACCOUNT_A.toLowerCase()) continue;
          seen.push(`${o.fired ?? "-"}/${o.dispatch ? o.dispatch.status : "-"}`);
        }
      },
    });
    log.push({ stage, ticks: seen });
  }
  const store = JSON.parse(await readFile(storePath, "utf8")) as {
    accounts: { account: string; grant?: { active: boolean; allowCallback: boolean; expiry: number; selector: string } }[];
    dispatches: { key: string; status: string; error?: string }[];
  };
  return {
    accounts: store.accounts,
    log,
    txSent: oil.txFrom.length,
    lpIdsLeft: (oil.positions.get(ACCOUNT_A.toLowerCase()) ?? []).map((p) => Number(p.id)),
    dispatches: store.dispatches,
    lines: sink.lines,
  };
}

describe("FIX C-1: the keeper's plan fits inside the one grant the user signs", () => {
  it("FIX C-1: an LP account walking the ladder is PROTECTED under the web's single unwind grant", async () => {
    const r = await walk({ grant: true });
    // Was: 0 broadcasts, [11,12,13] still open, every rung REFUSED.
    assert.ok(r.txSent > 0, `the keeper must act: ${JSON.stringify(r.log)}`);
    assert.ok(r.lpIdsLeft.length < 3, `LP ids must have been closed, still open: ${JSON.stringify(r.lpIdsLeft)}`);
    const grantRefusals = r.lines.filter((l) => l.includes("no active grant for keeper"));
    assert.deepEqual(grantRefusals, [], "no rung may be refused for want of a grant");
    const onChain = r.dispatches.filter((d) => !d.key.endsWith(":notify"));
    assert.ok(onChain.length > 0);
    assert.ok(
      onChain.some((d) => d.status === "CONFIRMED" || d.status === "SENT"),
      `expected an on-chain protective action, got ${JSON.stringify(onChain.map((d) => d.status))}`
    );
    assert.ok(!onChain.some((d) => d.status === "ABANDONED"), "nothing may be abandoned in a healthy grant setup");

    // FIX C-3: the grant (expiry included) is persisted for a dashboard to read,
    // instead of being fetched on every dispatch and thrown away.
    const acct = r.accounts.find((a) => a.account === ACCOUNT_A.toLowerCase())!;
    assert.ok(acct.grant, "the on-chain grant state must be surfaced on the account record");
    assert.equal(acct.grant!.active, true);
    assert.equal(acct.grant!.allowCallback, true);
    assert.equal(acct.grant!.selector, GRANT_SELECTORS["StrategyRouter.unwind"]);
    assert.ok(acct.grant!.expiry > 0, "the expiry the keeper reads is kept, not discarded");
  });

  it("FIX C-1: with NO grant the keeper still fails closed — REFUSED, nothing broadcast", async () => {
    const r = await walk({ grant: false });
    assert.equal(r.txSent, 0);
    assert.deepEqual(r.lpIdsLeft, [11, 12, 13]);
    assert.ok(r.lines.some((l) => l.includes("no active grant for keeper")));
  });

  it("FIX C-1: every plan needs exactly the grant the web signs — the invariant that cannot re-break", () => {
    const pools = new Map<Hex, PoolInfo>([[POOL, { sqrtPriceX96: 10n ** 30n, swap: NO_SWAP, needsSwap: false }]]);
    for (const action of ["repay", "derisk", "emergency-unwind"]) {
      for (const idle of [0n, 5_000_000_000n]) {
        const plan = planAction({
          account: ACCOUNT_A,
          action,
          collateralAsset: CBBTC,
          router: ROUTER,
          positions: [
            { id: 1n, poolId: POOL, valueUsdc: 1_000n },
            { id: 2n, poolId: POOL, valueUsdc: 5_000n },
          ],
          pools,
          idleUsdc: idle,
          usdcNeeded: null,
          bandToleranceBps: 100,
          nowS: 1_800_000_000n,
          txDeadlineS: 120,
        });
        assert.equal(plan.kind, "CALLS");
        if (plan.kind !== "CALLS") continue;
        assert.deepEqual(
          plan.grantsNeeded,
          [{ target: ROUTER, selector: KEEPER_GRANT_SHAPE.selector }],
          `${action}/idle=${idle} planned a call outside the signed Permission`
        );
      }
    }
    // …and the shape the web must sign carries the peripheral opt-in.
    assert.equal(KEEPER_GRANT_SHAPE.allowCallback, true);
    assert.equal(KEEPER_GRANT_SHAPE.selector, GRANT_SELECTORS["StrategyRouter.unwind"]);
    // Exactly the root calls the product issues grants for: `unwind` for every single-chain rung and, since
    // BUILD-PLAN D6 / A5.2 (2026-09-13), `closeLpAndBurn` for a paired account's cross-chain rung under its OWN
    // grant. A third entry would be a plan outside the signed Permissions — C-HIGH-1 coming back.
    assert.deepEqual(Object.keys(GRANT_SELECTORS).sort(), ["StrategyRouter.closeLpAndBurn", "StrategyRouter.unwind"]);
    assert.notEqual(GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"], GRANT_SELECTORS["StrategyRouter.unwind"]);
  });
});
