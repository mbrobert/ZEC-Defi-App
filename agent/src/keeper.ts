import { createPublicClient, createWalletClient, http, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { BORROW_ASSET, HF_LADDER, collateralAssetsFor, type CollateralSymbol } from "@zyo/shared";
import { accountCreatedEvent, strategyRouterAbi } from "./abi/oilskin.js";
import { ConfigError, describeConfig, loadConfig, type KeeperConfig } from "./config.js";
import { KeeperDispatcher } from "./dispatch/keeperDispatcher.js";
import { ObserveOnlyDispatcher } from "./dispatch/observeOnly.js";
import type { Dispatcher } from "./dispatch/types.js";
import { buildFeedPolicies, FeedSelfCheckError, logFeedPolicies, policyMap, selfCheckFeeds, type FeedPolicy } from "./engine/feeds.js";
import { Logger, stdoutSink, type LogSink } from "./log.js";
import { logChannel, MultiNotifier, webhookChannel, type Channel, type KeeperEvent, type Notifier } from "./notify/notifier.js";
import { ownerHistoryChannel } from "./notify/ownerNotifier.js";
import { HealthMonitor, type TickReport } from "./monitors/healthMonitor.js";
import { AaveReader, aaveAddressesFor, reserveSpecsFor } from "./services/chain.js";
import { sleep } from "./services/deadline.js";
import { AccountDiscovery } from "./services/discovery.js";
import { RouterEntryHfReader } from "./services/entryHf.js";
import { UnsupportedVenueError, VenueReader } from "./services/venues.js";
import { KeeperStore } from "./store/keeperStore.js";
import { ProgressWatchdog, type TickHandle } from "./watchdog.js";
import type { Address } from "./types/evm.js";

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
  /** Extra delivery channel (tests, or an operator's own transport). Person-facing unless it says otherwise. */
  notifyChannel?: { name: string; reachesAPerson?: boolean; send: (e: KeeperEvent) => Promise<void> };
  /** Replaces the whole notifier (tests). */
  notifier?: Notifier;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
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
  // Every address below comes from the chain's table (packages/shared CHAINS) — never from the
  // mainnet constants when CHAIN_ID says otherwise (slice 6, 2026-09-10; audit wave 2 S-MED-1).
  const viemChain = config.chainId === baseSepolia.id ? baseSepolia : base;
  if (config.chainId !== base.id) {
    log.warn("NOT BASE MAINNET — a rehearsal chain; what this run can and cannot prove:", { chain: config.chain.name, notes: config.chain.notes });
  }
  const reserveSpecs = reserveSpecsFor(config.chain, config.tokens);
  const collateral = collateralAssetsFor(config.chain, config.tokens);

  const client =
    opts.makeClient?.(config) ??
    (createPublicClient({
      chain: viemChain,
      transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }),
    }) as PublicClient);

  let currentHandle: TickHandle | null = null;
  const onProgress = () => currentHandle?.bump();

  const reader = new AaveReader(client, aaveAddressesFor(config.chain), reserveSpecs, {
    deadlineMs: config.rpcDeadlineMs,
    onProgress,
  });

  // Chain identity before anything else: a wrong RPC must not populate a store.
  const chainId = await reader.chainId();
  if (chainId !== config.chainId) {
    throw new Error(`RPC reports chain id ${chainId}, config expects ${config.chainId}`);
  }

  // ---- venues: every account is valued through the Aave pool AND through every venue the ----
  // ---- registry names for its collateral (audit wave 2, M-HIGH-2) -------------------------
  // The router names the registry; the registry names, per asset, the current venue and every
  // previous one. Each is read through ICollateralVenue on every tick and cross-checked against the
  // keeper's own Chainlink feeds (engine/venueValuation.ts). Startup is FATAL only for a venue the
  // reader cannot talk to at all — every account would be UNKNOWN on every tick — and a WARNING for
  // a venue that answers but is not the Aave venue over the pool the G1–G4 valuation reads.
  let venues: VenueReader | null = null;
  if (config.routerAddress) {
    venues = new VenueReader(client, config.routerAddress, {
      deadlineMs: config.rpcDeadlineMs,
      onProgress,
      usdc: config.tokens.USDC.address,
      aaveProvider: config.chain.aave.poolAddressesProvider,
      assets: Object.fromEntries((Object.keys(collateral) as CollateralSymbol[]).map((s) => [s, { address: collateral[s].address, decimals: collateral[s].decimals }])) as Record<
        CollateralSymbol,
        { address: `0x${string}`; decimals: number }
      >,
    });
    try {
      const probe = await venues.probe();
      const describe = (v: { venue: string; kind: string; provider: string | null; assets: { symbol: string; role: string; enabled: boolean; liquidationThresholdBps: bigint | null }[] }) => ({
        venue: v.venue,
        kind: v.kind,
        provider: v.provider,
        assets: v.assets.map((a) => `${a.symbol}:${a.role}${a.enabled ? "" : ":disabled"}${a.liquidationThresholdBps !== null ? `:lt=${a.liquidationThresholdBps}` : ""}`),
      });
      if (probe.otherVenues.length) {
        log.warn(
          "NON-AAVE VENUE(S) IN THE REGISTRY: these are read through ICollateralVenue and cross-checked against the keeper's Chainlink feeds " +
            "(V1–V4); the keeper's protective unwind is resolved by the router to the venue holding the asset. Accepting a venue switch on " +
            "mainnet remains the registry owner's explicit step — nothing here does it",
          { registry: probe.registry, otherVenues: probe.otherVenues.map(describe) }
        );
      }
      log.info("venue probe passed — every registered asset resolves to a venue this keeper can read", {
        registry: probe.registry,
        venues: probe.venues.map(describe),
        unregistered: probe.unregistered,
      });
    } catch (e) {
      if (e instanceof UnsupportedVenueError) {
        log.error("VENUE PROBE FAILED — refusing to start blind", { problems: e.problems });
      }
      throw e;
    }
  } else {
    log.warn(
      "VENUE READER OFF: STRATEGY_ROUTER_ADDRESS is not set, so the keeper cannot find the registry and values every account through the " +
        "Aave pool only — a position on any other venue is invisible here (audit wave 2, M-HIGH-2). Set the router to watch every venue"
    );
  }

  // ---- feed self-check: the keeper must not run silently blind ------------
  // Every wired feed is probed for its OWN cadence and the bound that will be
  // enforced is logged. If that policy would make every account UNKNOWN, this
  // is a loud fatal — the alternative is what shipped: a daemon that heartbeats
  // for ever and protects nobody (audit C-HIGH-2).
  const feedPolicies: FeedPolicy[] = await buildFeedPolicies(
    reader,
    reserveSpecs,
    (await reader.head()).timestamp,
    {
      fallbackMaxAgeS: config.priceMaxAgeS,
      minMaxAgeS: config.feedMinMaxAgeS,
      slack: config.feedHeartbeatSlack,
      rounds: config.feedHeartbeatRounds,
      minWindowS: config.feedHeartbeatWindowS,
      overrides: config.priceMaxAgeOverridesS,
    }
  );
  logFeedPolicies(log, feedPolicies);
  const priceMaxAgeBySymbol = policyMap(feedPolicies);
  const check = selfCheckFeeds(feedPolicies, BORROW_ASSET, (Object.keys(collateral) as CollateralSymbol[]).filter((s) => config.chain.aaveReserves.includes(s)));
  if (check.fatal) {
    log.error("FEED SELF-CHECK FAILED — the configured staleness policy would make every account UNKNOWN", {
      reason: check.reason,
      stale: check.stale,
      mode: config.feedSelfCheck,
    });
    if (config.feedSelfCheck === "fatal") throw new FeedSelfCheckError(check.reason ?? "unknown");
  } else if (check.stale.length) {
    log.warn("some feeds are stale against their own measured cadence", { stale: check.stale });
  }

  const store = new KeeperStore(config.storePath, {
    keepTerminalPerAccount: config.storeKeepTerminalPerAccount,
    lockStaleMs: config.storeLockStaleMs,
  });
  await store.open();
  if (store.recoveredFromBackup) {
    log.error("STORE RECOVERED FROM BACKUP — the primary store was unreadable; episode/idempotency state may be behind", {
      path: config.storePath,
    });
  }
  log.info("store open", { path: config.storePath, accounts: store.listAccounts().length, counters: store.counters });

  const discovery = new AccountDiscovery(client, {
    factory: config.factoryAddress,
    event: accountCreatedEvent,
    argNames: { owner: "owner", account: "account" },
    chunkBlocks: config.discoveryChunkBlocks,
    deadlineMs: config.rpcDeadlineMs,
    onProgress,
  });

  // ---- notifications: every rung and every escalation leaves this process --
  const channels: Channel[] = [logChannel(log), ownerHistoryChannel(store)];
  if (opts.notifyChannel) channels.push({ reachesAPerson: opts.notifyChannel.reachesAPerson ?? true, ...opts.notifyChannel });
  if (config.notifyWebhookUrl) {
    channels.push(webhookChannel({ url: config.notifyWebhookUrl, token: config.notifyWebhookToken, fetchImpl: opts.fetchImpl }));
  }
  const notifier: Notifier = opts.notifier ?? new MultiNotifier(log, channels, config.notifyDeadlineMs);
  if (!notifier.hasPersonChannel) {
    // The keeper's own log and store accept every event and reach nobody. Running with only those
    // used to make every warning NOTIFIED and terminal (audit wave 2, N-MED-1). Refuse unless an
    // operator has said, by name, that a log-only keeper is what they want.
    const msg =
      "NO PERSON-FACING NOTIFICATION CHANNEL: set NOTIFY_WEBHOOK_URL. Rung warnings and escalations would reach this log and " +
      "the keeper's own store and nothing else — the user is shown a per-rung promise before they sign, and it cannot be kept from here";
    if (!config.notifyAllowLogOnly) {
      log.error(msg + " (set NOTIFY_ALLOW_LOG_ONLY=1 to run anyway; warnings are then recorded LOGGED_ONLY, never NOTIFIED)");
      await store.close();
      throw new ConfigError("NOTIFY_WEBHOOK_URL", "no person-facing notification channel; set it, or NOTIFY_ALLOW_LOG_ONLY=1 to run log-only");
    }
    log.warn(msg + " — NOTIFY_ALLOW_LOG_ONLY=1: running log-only; warnings are recorded LOGGED_ONLY, never NOTIFIED");
  }

  let dispatcher: Dispatcher;
  if (opts.makeDispatcher) {
    dispatcher = opts.makeDispatcher(config, log);
  } else if (config.keeperPrivateKey && config.routerAddress) {
    // The key becomes a viem account here and is never referenced again.
    const account = privateKeyToAccount(config.keeperPrivateKey);
    const wallet =
      opts.makeWallet?.(config, account) ??
      createWalletClient({ account, chain: viemChain, transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }) });
    // Router wiring is read from the router itself so nothing here can drift from the deployment.
    const [usdc, lpVenue] = await Promise.all([
      client.readContract({ address: config.routerAddress, abi: strategyRouterAbi, functionName: "USDC" }),
      client.readContract({ address: config.routerAddress, abi: strategyRouterAbi, functionName: "LP_VENUE" }),
    ]);
    // The direct Slipstream venue (2026-09-11): zero on a deployment without it, and a router from
    // before it has no such view at all — both mean "engine venue only", never a fatal start.
    let lpVenueDirect: Address | null = null;
    try {
      const v = await client.readContract({ address: config.routerAddress, abi: strategyRouterAbi, functionName: "LP_VENUE_DIRECT" });
      if (!/^0x0{40}$/i.test(v)) lpVenueDirect = v;
    } catch {
      lpVenueDirect = null;
    }
    dispatcher = new KeeperDispatcher({
      client,
      wallet,
      keeper: account.address,
      router: config.routerAddress,
      lpVenue,
      lpVenueDirect,
      usdc,
      reader,
      venues,
      ladder: HF_LADDER,
      log,
      config: {
        deadlineMs: config.rpcDeadlineMs,
        bandToleranceBps: config.bandToleranceBps,
        bandMaxToleranceBps: config.bandMaxToleranceBps,
        txDeadlineS: config.txDeadlineS,
        priceMaxAgeS: config.priceMaxAgeS,
        priceMaxAgeBySymbol,
        oracleDeviationBps: config.oracleDeviationBps,
        hfToleranceBps: config.hfToleranceBps,
        swapMaxSlippageBps: config.swapMaxSlippageBps,
        maxValueProbes: config.maxValueProbes,
        grantExpiryWarnS: config.grantExpiryWarnS,
      },
      notifier,
    });
    log.info("keeper mode", { keeper: account.address, router: config.routerAddress, lpVenue, lpVenueDirect, usdc });
  } else {
    dispatcher = new ObserveOnlyDispatcher(log, notifier);
    log.warn("observe-only: no KEEPER_PRIVATE_KEY — rungs are recorded and warnings delivered, on-chain actions refused");
  }

  // ---- lifecycle -----------------------------------------------------------
  const stop = new AbortController();
  let stopReason = "";
  let fatalStoreError: Error | null = null;

  // The entry HF the router recorded per account is what each account's ladder derives from (A4);
  // without a router every account runs the floor's ladder and its record says so.
  const entryHf = config.routerAddress ? new RouterEntryHfReader(client, config.routerAddress, { deadlineMs: config.rpcDeadlineMs }) : null;
  const monitor = new HealthMonitor({
    reader,
    venues,
    discovery,
    store,
    ladder: HF_LADDER,
    entryHf,
    dispatcher,
    log,
    config: {
      concurrency: config.concurrency,
      priceMaxAgeS: config.priceMaxAgeS,
      priceMaxAgeBySymbol,
      oracleDeviationBps: config.oracleDeviationBps,
      hfToleranceBps: config.hfToleranceBps,
      discoveryFromBlock: config.discoveryFromBlock,
      unknownEscalationStreak: opts.unknownEscalationStreak ?? KEEPER_DEFAULTS.unknownEscalationStreak,
      maxDispatchAttempts: opts.maxDispatchAttempts ?? KEEPER_DEFAULTS.maxDispatchAttempts,
      maxResumePerTick: config.maxResumePerTick,
      dispatchDeadlineMs: config.dispatchDeadlineMs,
      maxRecordStalls: config.maxRecordStalls,
      maxRungRefires: config.maxRungRefires,
      clockDriftMaxS: config.clockDriftMaxS,
    },
    notifier,
    onEscalate: (e) => {
      log.error("ESCALATION", e);
      opts.onEscalate?.(e);
    },
    onFatal: (e) => {
      // The store can no longer be trusted. Stop the loop and exit non-zero so
      // the supervisor restarts into a clean re-read, instead of staying up,
      // heartbeating, and being unable to fire a single rung.
      fatalStoreError = e;
      if (!stop.signal.aborted) stop.abort(e);
    },
  });

  const watchdog = new ProgressWatchdog({
    stallMs: config.watchdogStallMs,
    backoff: { initialMs: config.healthPollMs, maxMs: Math.max(config.backoffMaxMs, config.healthPollMs), factor: KEEPER_DEFAULTS.backoffFactor },
    onStall: (i) => log.error("WATCHDOG: tick stalled — aborted, backing off (process stays up)", i),
  });

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
    log.info("stopped", {
      ticks,
      reason: stopReason || (fatalStoreError ? "store fatal" : "maxTicks"),
      notifyFailures: notifier.failures,
      channels: notifier.channels,
    });
  }
  if (fatalStoreError) throw fatalStoreError;
  return { ticks };
}
