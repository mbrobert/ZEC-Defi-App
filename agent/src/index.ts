import { loadConfig } from "./config.js";
import { MockRheaService, RheaSdkService, type RheaService } from "./services/rhea.js";
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
async function main() {
  const config = loadConfig();
  console.log("[agent] starting", {
    rheaMode: config.rheaMode,
    baseRpcUrl: config.baseRpcUrl,
    vault: config.positionVault ?? "(not deployed)",
  });

  const rhea: RheaService =
    config.rheaMode === "sdk"
      ? await RheaSdkService.create(config.nearNetworkId)
      : new MockRheaService();

  const store = new StrategyStore(config.storePath);
  const oneClick = new OneClickClient({
    baseUrl: config.oneClickBaseUrl,
    jwt: config.oneClickJwt,
  });
  void oneClick; // consumed by RewardExecutor once writes are wired

  const healthMonitor = new HealthMonitor(
    rhea,
    store,
    { warning: config.hfWarning, critical: config.hfCritical },
    async (a) => {
      console.warn(
        `[health] strategy=${a.strategyId} HF=${a.healthFactor.toFixed(3)} band=${a.band} action=${a.suggestedAction}`
      );
      // TODO(notify): wire email/push/webhook. CRITICAL should also trigger
      // the deleverage path (LP withdraw → repay) once writes are enabled.
    }
  );

  const timers: NodeJS.Timeout[] = [];
  timers.push(
    setInterval(() => void healthMonitor.tick().catch(console.error), config.healthPollMs)
  );
  console.log(`[agent] health loop every ${config.healthPollMs}ms`);

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
          await store.update(s.id, { lp: { ...s.lp, inRange } });
        } catch (err) {
          console.error(`[lp] ${s.id}:`, (err as Error).message);
        }
      }
    };
    timers.push(setInterval(() => void lpTick().catch(console.error), config.lpPollMs));
    console.log(`[agent] lp loop every ${config.lpPollMs}ms`);
  } else {
    console.log(
      "[agent] POSITION_VAULT_ADDRESS not set — lp/reward loops idle. " +
        "Deploy contracts (contracts/script/Deploy.s.sol) and set the address."
    );
  }

  const shutdown = () => {
    console.log("[agent] shutting down");
    for (const t of timers) clearInterval(t);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await healthMonitor.tick();
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
