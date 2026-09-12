/**
 * Wires the Solana keeper and runs the loop — the twin of `../keeper.ts`, same discipline: the store lock is
 * taken before the first tick; ticks are driven by the progress watchdog; SIGTERM/SIGINT abort the tick,
 * drain the store and exit 0; observe-only without a keeper key. The keeper key is read from the file
 * `KEEPER_SOLANA_KEYPAIR` names, only here, only into the dispatcher.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { HF_LADDER } from "@zyo/shared";
import type { LadderRung } from "../engine/ladder.js";
import { Logger, stdoutSink, type LogSink } from "../log.js";
import { logChannel, MultiNotifier, webhookChannel, type Channel, type KeeperEvent, type Notifier } from "../notify/notifier.js";
import { ownerHistoryChannel } from "../notify/ownerNotifier.js";
import { sleep } from "../services/deadline.js";
import { BASE58_ID_CODEC, KeeperStore } from "../store/keeperStore.js";
import { ProgressWatchdog } from "../watchdog.js";
import { describeSolanaConfig, loadSolanaConfig, type SolanaKeeperConfig } from "./config.js";
import { KeeperSolanaDispatcher, SolanaObserveOnlyDispatcher, type SolanaDispatcher } from "./dispatcher.js";
import { SolanaMonitor, type SolanaTickReport } from "./monitor.js";
import { OILSKIN_ERRORS } from "./layouts.js";
import { jupiterPriceSource, SolanaReader, type IndependentPriceSource } from "./reader.js";
import type { SolanaValuationParams } from "./valuation.js";

export interface SolanaRunOptions {
  sink?: LogSink;
  onTick?: (report: SolanaTickReport, ticks: number) => void;
  maxTicks?: number;
  makeConnection?: (config: SolanaKeeperConfig) => Connection;
  /** Test hook: replaces the independent price source (a localnet has no Jupiter). */
  independent?: IndependentPriceSource | null;
  makeDispatcher?: (config: SolanaKeeperConfig, log: Logger, reader: SolanaReader, notifier: Notifier) => SolanaDispatcher;
  notifyChannel?: Channel;
  notifier?: Notifier;
  fetchImpl?: typeof fetch;
  onEscalate?: (e: { account: string; reasons: string[]; streak: number }) => void;
}

export const SOLANA_KEEPER_DEFAULTS = {
  concurrency: 4,
  maxResumePerTick: 10,
  maxRungRefires: 3,
  backoffFactor: 2,
} as const;

/** The shared ladder as the keeper's engine consumes it — and the program-side index of each rung. */
export const SOLANA_LADDER: readonly LadderRung[] = HF_LADDER.map((r) => ({ id: r.id, hf: r.hf, disarmHf: r.disarmHf, severity: r.severity, action: r.action }));
export const rungIndexOf = (id: string): number | undefined => {
  const i = HF_LADDER.findIndex((r) => r.id === id);
  return i < 0 ? undefined : i;
};

/** Reads the keypair file the config names. The only place a key is read; never logged. */
export function loadKeeperKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error("KEEPER_SOLANA_KEYPAIR: not a 64-byte Solana keypair JSON");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

function abandoned(signal: AbortSignal): Promise<SolanaTickReport> {
  return new Promise((resolve) => {
    const done = () => setTimeout(() => resolve({ slot: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: true }), 250);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

export async function runSolanaKeeper(env: NodeJS.ProcessEnv, opts: SolanaRunOptions = {}): Promise<{ ticks: number }> {
  const config = loadSolanaConfig(env);
  const log = new Logger(opts.sink ?? stdoutSink, config.logLevel, { svc: "keeper-solana", pid: process.pid });
  log.info("starting", describeSolanaConfig(config));

  const connection = opts.makeConnection?.(config) ?? new Connection(config.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: false });

  // Independent price: Jupiter on mainnet; declared-absent on localnet.
  let independent: IndependentPriceSource | null;
  if (opts.independent !== undefined) independent = opts.independent;
  else if (config.priceSource === "jupiter") independent = jupiterPriceSource(config.jupiterQuoteUrl, opts.fetchImpl ?? fetch);
  else independent = null;
  if (!independent) {
    log.warn("NO INDEPENDENT PRICE: valuation trusts Kamino's Scope oracle alone. Localnet only — never run this against mainnet.");
  }
  const valuationParams: SolanaValuationParams = {
    priceMaxAgeS: config.priceMaxAgeS,
    independentMaxAgeS: config.independentMaxAgeS,
    oracleDeviationBps: config.oracleDeviationBps,
    hfToleranceBps: config.hfToleranceBps,
    requireIndependent: independent !== null,
  };

  const watchdog = new ProgressWatchdog({
    stallMs: config.watchdogStallMs,
    backoff: { initialMs: config.healthPollMs, maxMs: config.healthPollMs * 16, factor: SOLANA_KEEPER_DEFAULTS.backoffFactor },
    onStall: (info) => log.error("TICK STALLED — aborted; next tick waits poll + backoff", info),
  });
  let currentHandle: { bump: () => void } | null = null;
  const reader = new SolanaReader(connection, config.programId, { deadlineMs: config.rpcDeadlineMs, onProgress: () => currentHandle?.bump(), independent });

  // Chain identity before anything else: the program must exist where we are pointed.
  const programInfo = await connection.getAccountInfo(config.programId, "confirmed");
  if (!programInfo || !programInfo.executable) throw new Error(`OILSKIN_SOLANA_PROGRAM_ID ${config.programId.toBase58()} is not an executable program on ${config.rpcUrl}`);

  const store = new KeeperStore<string, string>(config.storePath, { idCodec: BASE58_ID_CODEC });
  await store.open();

  const channels: Channel[] = [logChannel(log), ownerHistoryChannel(store)];
  if (config.notifyWebhookUrl) channels.push(webhookChannel({ url: config.notifyWebhookUrl, fetchImpl: opts.fetchImpl ?? fetch }));
  if (opts.notifyChannel) channels.push(opts.notifyChannel);
  const notifier: Notifier = opts.notifier ?? new MultiNotifier(log, channels, config.notifyDeadlineMs);

  let keeperPubkey: PublicKey | null = null;
  let dispatcher: SolanaDispatcher;
  if (opts.makeDispatcher) {
    dispatcher = opts.makeDispatcher(config, log, reader, notifier);
  } else if (config.keeperKeypairPath) {
    const keeper = loadKeeperKeypair(config.keeperKeypairPath);
    keeperPubkey = keeper.publicKey;
    log.info("keeper mode", { keeper: keeper.publicKey.toBase58(), maxSaleUsdc: config.keeperMaxSaleUsdc.toString() });
    dispatcher = new KeeperSolanaDispatcher({
      connection,
      reader,
      programId: config.programId,
      keeper,
      rungs: HF_LADDER.map((r, i) => ({ id: i, disarmHf: r.disarmHf })),
      rungIndex: rungIndexOf,
      valuationParams,
      saleDiscountBps: config.saleDiscountBps,
      keeperMaxSaleUsdc: config.keeperMaxSaleUsdc,
      planMarginBps: config.planMarginBps,
      confirmTimeoutMs: config.dispatchDeadlineMs,
      idlErrors: OILSKIN_ERRORS,
      log,
      notifier,
    });
  } else {
    log.warn("OBSERVE-ONLY: no KEEPER_SOLANA_KEYPAIR — rungs are recorded and warnings delivered, every on-chain action is REFUSED by name");
    dispatcher = new SolanaObserveOnlyDispatcher(log, notifier);
  }
  const simPayer = keeperPubkey ?? config.simPayer;

  let fatalStoreError: Error | null = null;
  const monitor = new SolanaMonitor({
    reader,
    store,
    ladder: SOLANA_LADDER,
    dispatcher,
    log,
    config: {
      concurrency: SOLANA_KEEPER_DEFAULTS.concurrency,
      unknownEscalationStreak: config.unknownEscalationStreak,
      maxDispatchAttempts: config.maxDispatchAttempts,
      maxResumePerTick: SOLANA_KEEPER_DEFAULTS.maxResumePerTick,
      dispatchDeadlineMs: config.dispatchDeadlineMs,
      maxRungRefires: SOLANA_KEEPER_DEFAULTS.maxRungRefires,
    },
    valuationParams,
    simPayer,
    notifier,
    onEscalate: opts.onEscalate,
    onFatal: (e) => {
      fatalStoreError = e;
    },
  });

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
  // Deliberately not unref'd: the timer is part of what keeps the daemon alive between ticks.
  const wdTimer = setInterval(() => watchdog.check(), Math.max(250, Math.floor(config.watchdogStallMs / 4)));

  let ticks = 0;
  try {
    while (!stop.signal.aborted && !fatalStoreError) {
      const handle = watchdog.beginTick();
      const combined = AbortSignal.any([handle.signal, stop.signal]);
      const tickHandle = { signal: combined, bump: handle.bump, end: handle.end };
      currentHandle = tickHandle;
      // Race the tick against its own abort so a hung await cannot wedge the daemon.
      const report = await Promise.race([monitor.tick(tickHandle), abandoned(combined)]);
      currentHandle = null;
      ticks += 1;
      log.info("heartbeat", { ticks, slot: report.slot?.toString() ?? null, evaluated: report.evaluated, discovered: report.discovered, resumed: report.resumed, backoffMs: watchdog.currentBackoffMs, stalls: watchdog.stallCount });
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
    log.info("stopped", { ticks, reason: stopReason || (fatalStoreError ? "store fatal" : "maxTicks") });
  }
  if (fatalStoreError) throw fatalStoreError;
  return { ticks };
}

export type { KeeperEvent };
