import { redactUrl } from "@zyo/shared";
import { loadConfig } from "./config.js";
import { MockRheaService, type RheaService } from "./services/rhea.js";
import { RheaSdkService } from "./services/rheaSdk.js";
import { OneClickClient } from "./services/oneClick.js";
import { RpcReadOnlyChainService } from "./services/chain.js";
import type { Address } from "./types/evm.js";
import { StrategyStore } from "./store/strategyStore.js";
import { HealthMonitor } from "./monitors/healthMonitor.js";

/**
 * Agent entrypoint.
 *   • health loop  — Rhea health factor per strategy → notify/deleverage hooks
 *   • lp loop      — in-range + accrued-reward refresh (reads; needs vault addr)
 *   • reward loop  — claim decision + execution (writes; needs viem integration)
 *
 * Runs fully in mock mode out of the box:
 *   RHEA_MODE=mock npm run dev -w @zyo/agent
 */

/**
 * Self-rescheduling async loop: the next run is scheduled only AFTER the
 * previous tick fully completes (awaited), so a slow tick can never overlap
 * itself the way setInterval does — overlapping health ticks were dispatching
 * the same EMERGENCY_UNWIND several times.
 */
function startLoop(name: string, intervalMs: number, tick: () => Promise<void>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`[${name}]`, err);
    }
    if (!stopped) {
      timer = setTimeout(run, intervalMs);
      timer.unref();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main() {
  const config = loadConfig();
  console.log("[agent] starting", {
    rheaMode: config.rheaMode,
    // Host ONLY — provider RPC URLs embed the API key in the path.
    baseRpcHost: redactUrl(config.baseRpcUrl),
    vault: config.positionVault ?? "(not deployed)",
  });

  // RHEA_MODE=sdk wires the REAL SDK service (services/rheaSdk.ts). Its
  // create() throws when the SDK is not installed/usable — FAIL FAST at
  // startup rather than erroring on every tick with positions unmonitored.
  let rhea: RheaService;
  if (config.rheaMode === "sdk") {
    try {
      rhea = await RheaSdkService.create(config.nearNetworkId);
    } catch (err) {
      console.error(
        "[agent] fatal: RHEA_MODE=sdk but the Rhea SDK service failed to initialize — " +
          "refusing to run with health monitoring silently broken.",
        (err as Error).message
      );
      process.exit(1);
    }
  } else {
    rhea = new MockRheaService();
  }

  const store = new StrategyStore(config.storePath);
  const oneClick = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    jwt: config.oneClickJwt,
  });
  void oneClick; // consumed by RewardExecutor once writes are wired

  const healthMonitor = new HealthMonitor(
    rhea,
    store,
    {
      warning: config.hfWarning,
      critical: config.hfCritical,
      emergency: config.hfEmergency,
    },
    async (a) => {
      console.warn(
        `[health] strategy=${a.strategyId} HF=${a.healthFactor.toFixed(3)} band=${a.band} action=${a.suggestedAction}`
      );
      // TODO(notify): wire email/push/webhook. CRITICAL should also trigger
      // the deleverage path (LP withdraw → repay) once writes are enabled.
    }
  );

  const stoppers: (() => void)[] = [];
  stoppers.push(startLoop("health", config.healthPollMs, () => healthMonitor.tick().then(() => undefined)));
  console.log(`[agent] health loop every ${config.healthPollMs}ms (self-rescheduling)`);

  if (config.positionVault) {
    const chain = new RpcReadOnlyChainService(
      config.baseRpcUrl,
      config.positionVault as Address
    );
    const lpTick = async () => {
      for (const s of await store.list()) {
        if (!s.lp?.vaultPositionId || s.status !== "ACTIVE_FULL") continue;
        try {
          const pos = await chain.getPosition(BigInt(s.lp.vaultPositionId));
          const inRange = await chain.isInRange(pos.adapter, BigInt(s.lp.vaultPositionId));
          await store.update(s.id, (cur) =>
            cur.lp ? { ...cur, lp: { ...cur.lp, inRange } } : cur
          );
        } catch (err) {
          console.error(`[lp] ${s.id}:`, (err as Error).message);
        }
      }
    };
    stoppers.push(startLoop("lp", config.lpPollMs, lpTick));
    console.log(`[agent] lp loop every ${config.lpPollMs}ms (self-rescheduling)`);
  } else {
    console.log(
      "[agent] POSITION_VAULT_ADDRESS not set — lp/reward loops idle. " +
        "Deploy contracts (contracts/script/Deploy.s.sol) and set the address."
    );
  }

  const shutdown = () => {
    console.log("[agent] shutting down");
    for (const stop of stoppers) stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
