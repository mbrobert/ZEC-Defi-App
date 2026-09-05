import { createPublicClient, createWalletClient, http, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { accountCreatedEvent, strategyRouterAbi } from "./abi/oilskin.js";
import { describeConfig, loadConfig, type KeeperConfig } from "./config.js";
import { KeeperDispatcher } from "./dispatch/keeperDispatcher.js";
import { ObserveOnlyDispatcher } from "./dispatch/observeOnly.js";
import type { Dispatcher } from "./dispatch/types.js";
import { Logger, stdoutSink, type LogSink } from "./log.js";
import { HealthMonitor, type TickReport } from "./monitors/healthMonitor.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "./services/chain.js";
import { sleep } from "./services/deadline.js";
import { AccountDiscovery } from "./services/discovery.js";
import { KeeperStore } from "./store/keeperStore.js";
import { ProgressWatchdog, type TickHandle } from "./watchdog.js";

/**
 * Wires the keeper and runs the loop. Structure, in order of what has bitten
 * before (AUDIT-FINDINGS Lens E / Part 4):
 *   • nothing is `unref()`'d — the loop is the process; it exits only on a
 *     signal or a fatal startup error;
 *   • the chain id is checked against config before the store is opened;
 *   • the store lock is taken before the first tick and released on exit;
 *   • ticks are driven by a progress watchdog: a stalled tick is aborted and
 *     the next one waits `poll + backoff`; nothing restarts the process;
 *   • SIGTERM/SIGINT abort the in-flight tick, drain the store, and exit 0.
 */

export interface RunOptions {
  /** Test hooks. */
  sink?: LogSink;
  onTick?: (report: TickReport, ticks: number) => void;
  /** Stop after this many ticks (tests); default runs until a signal. */
  maxTicks?: number;
  makeClient?: (config: KeeperConfig) => PublicClient;
  /** Test hook: a wallet client over the same transport as the public client. */
  makeWallet?: (config: KeeperConfig, account: Account) => WalletClient<Transport, Chain, Account>;
  makeDispatcher?: (config: KeeperConfig, log: Logger) => Dispatcher;
  notify?: (record: import("./store/keeperStore.js").DispatchRecord) => Promise<void> | void;
  /** Consecutive UNKNOWN valuations before escalation. */
  unknownEscalationStreak?: number;
  maxDispatchAttempts?: number;
  onEscalate?: (e: { account: `0x${string}`; reasons: string[]; streak: number }) => void;
}

export const KEEPER_DEFAULTS = {
  unknownEscalationStreak: 3,
  maxDispatchAttempts: 5,
  backoffFactor: 2,
} as const;

function abandoned(signal: AbortSignal): Promise<TickReport> {
  return new Promise((resolve) => {
    const done = () =>
      // Give the cooperative path a moment to produce its own report first.
      setTimeout(() => resolve({ blockNumber: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: true }), 250);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

export async function runKeeper(env: NodeJS.ProcessEnv, opts: RunOptions = {}): Promise<{ ticks: number }> {
  const config = loadConfig(env);
  const log = new Logger(opts.sink ?? stdoutSink, config.logLevel, { svc: "keeper", pid: process.pid });
  log.info("starting", describeConfig(config));

  const client =
    opts.makeClient?.(config) ??
    (createPublicClient({
      chain: base,
      transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }),
    }) as PublicClient);

  let currentHandle: TickHandle | null = null;
  const onProgress = () => currentHandle?.bump();

  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), {
    deadlineMs: config.rpcDeadlineMs,
    onProgress,
  });

  // Chain identity before anything else: a wrong RPC must not populate a store.
  const chainId = await reader.chainId();
  if (chainId !== config.chainId) {
    throw new Error(`RPC reports chain id ${chainId}, config expects ${config.chainId}`);
  }

  const store = new KeeperStore(config.storePath);
  await store.open();
  log.info("store open", { path: config.storePath, accounts: store.listAccounts().length, counters: store.counters });

  const discovery = new AccountDiscovery(client, {
    factory: config.factoryAddress,
    event: accountCreatedEvent,
    argNames: { owner: "owner", account: "account" },
    chunkBlocks: config.discoveryChunkBlocks,
    deadlineMs: config.rpcDeadlineMs,
    onProgress,
  });

  let dispatcher: Dispatcher;
  if (opts.makeDispatcher) {
    dispatcher = opts.makeDispatcher(config, log);
  } else if (config.keeperPrivateKey && config.routerAddress) {
    // The key becomes a viem account here and is never referenced again.
    const account = privateKeyToAccount(config.keeperPrivateKey);
    const wallet =
      opts.makeWallet?.(config, account) ??
      createWalletClient({ account, chain: base, transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }) });
    // Router wiring is read from the router itself so nothing here can drift from the deployment.
    const [usdc, lpVenue] = await Promise.all([
      client.readContract({ address: config.routerAddress, abi: strategyRouterAbi, functionName: "USDC" }),
      client.readContract({ address: config.routerAddress, abi: strategyRouterAbi, functionName: "LP_VENUE" }),
    ]);
    dispatcher = new KeeperDispatcher({
      client,
      wallet,
      keeper: account.address,
      router: config.routerAddress,
      lpVenue,
      usdc,
      reader,
      ladder: HF_LADDER,
      log,
      config: {
        deadlineMs: config.rpcDeadlineMs,
        bandToleranceBps: config.bandToleranceBps,
        txDeadlineS: config.txDeadlineS,
        priceMaxAgeS: config.priceMaxAgeS,
        oracleDeviationBps: config.oracleDeviationBps,
        hfToleranceBps: config.hfToleranceBps,
      },
      notify: opts.notify,
    });
    log.info("keeper mode", { keeper: account.address, router: config.routerAddress, lpVenue, usdc });
  } else {
    dispatcher = new ObserveOnlyDispatcher(log, opts.notify, config.rpcDeadlineMs);
    log.warn("observe-only: no KEEPER_PRIVATE_KEY — rungs are recorded and warnings delivered, on-chain actions refused");
  }

  const monitor = new HealthMonitor({
    reader,
    discovery,
    store,
    ladder: HF_LADDER,
    dispatcher,
    log,
    config: {
      concurrency: config.concurrency,
      priceMaxAgeS: config.priceMaxAgeS,
      oracleDeviationBps: config.oracleDeviationBps,
      hfToleranceBps: config.hfToleranceBps,
      discoveryFromBlock: config.discoveryFromBlock,
      unknownEscalationStreak: opts.unknownEscalationStreak ?? KEEPER_DEFAULTS.unknownEscalationStreak,
      maxDispatchAttempts: opts.maxDispatchAttempts ?? KEEPER_DEFAULTS.maxDispatchAttempts,
    },
    onEscalate: (e) => {
      log.error("ESCALATION", e);
      opts.onEscalate?.(e);
    },
  });

  const watchdog = new ProgressWatchdog({
    stallMs: config.watchdogStallMs,
    backoff: { initialMs: config.healthPollMs, maxMs: Math.max(config.backoffMaxMs, config.healthPollMs), factor: KEEPER_DEFAULTS.backoffFactor },
    onStall: (i) => log.error("WATCHDOG: tick stalled — aborted, backing off (process stays up)", i),
  });

  // ---- lifecycle -----------------------------------------------------------
  const stop = new AbortController();
  let stopReason = "";
  const onSignal = (sig: string) => {
    if (stop.signal.aborted) return;
    stopReason = sig;
    log.info("shutdown requested", { signal: sig });
    stop.abort(new Error(`shutdown: ${sig}`));
  };
  const sigterm = () => onSignal("SIGTERM");
  const sigint = () => onSignal("SIGINT");
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);

  // The watchdog timer is deliberately NOT unref'd: it is part of what keeps
  // the daemon alive between ticks (the old daemon exited after one tick).
  const wdTimer = setInterval(() => watchdog.check(), Math.max(250, Math.floor(config.watchdogStallMs / 4)));

  let ticks = 0;
  try {
    while (!stop.signal.aborted) {
      const handle = watchdog.beginTick();
      const combined = AbortSignal.any([handle.signal, stop.signal]);
      const tickHandle: TickHandle = { signal: combined, bump: handle.bump, end: handle.end };
      currentHandle = tickHandle;
      // Race the tick against its own abort: a tick stuck in an await that
      // ignores the signal (a hung hook, a bug) must not wedge the daemon.
      // The abandoned tick's later store writes are suppressed by its signal.
      const report = await Promise.race([monitor.tick(tickHandle), abandoned(combined)]);
      currentHandle = null;
      ticks += 1;
      log.info("heartbeat", { ticks, backoffMs: watchdog.currentBackoffMs, stalls: watchdog.stallCount });
      opts.onTick?.(report, ticks);
      if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
      if (stop.signal.aborted) break;
      await sleep(config.healthPollMs + watchdog.currentBackoffMs, stop.signal);
    }
  } finally {
    clearInterval(wdTimer);
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
    await store.close();
    log.info("stopped", { ticks, reason: stopReason || "maxTicks" });
  }
  return { ticks };
}
