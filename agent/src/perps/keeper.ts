/**
 * Wires the perps keeper and runs the loop — the third chain's twin of `../keeper.ts` and
 * `../solana/keeper.ts`, same discipline: the chain's identity and the venue's immutables are checked before
 * a store is touched; the store lock is taken before the first tick; ticks are driven by the progress
 * watchdog; SIGTERM/SIGINT abort the tick, drain the store and exit 0; observe-only without a keeper key.
 * The keeper key becomes a viem account here and is never referenced again.
 */
import { createPublicClient, createWalletClient, http, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperEvm, hyperliquidEvmTestnet } from "viem/chains";
import { HYPERLIQUID } from "@zyo/shared";
import { accountCreatedEvent } from "../abi/oilskin.js";
import type { LadderRung } from "../engine/ladder.js";
import { Logger, stdoutSink, type LogSink } from "../log.js";
import { logChannel, MultiNotifier, webhookChannel, type Channel, type KeeperEvent, type Notifier } from "../notify/notifier.js";
import { ownerHistoryChannel } from "../notify/ownerNotifier.js";
import { sleep } from "../services/deadline.js";
import { AccountDiscovery } from "../services/discovery.js";
import { KeeperStore } from "../store/keeperStore.js";
import type { Address, Hex } from "../types/evm.js";
import { ProgressWatchdog, type TickHandle } from "../watchdog.js";
import { describePerpsConfig, loadPerpsConfig, type PerpsKeeperConfig } from "./config.js";
import { KeeperPerpsDispatcher, PerpsObserveOnlyDispatcher, type PerpsDispatcher } from "./dispatcher.js";
import { PerpsMonitor, perpLadderRungs, type PerpsTickReport } from "./monitor.js";
import { infoApiPriceSource, PerpsReader, type PerpsIndependentPriceSource, type PerpsVenueParams } from "./reader.js";
import type { PerpsValuationParams } from "./valuation.js";

export interface PerpsRunOptions {
  sink?: LogSink;
  onTick?: (report: PerpsTickReport, ticks: number) => void;
  maxTicks?: number;
  makeClient?: (config: PerpsKeeperConfig) => PublicClient;
  makeWallet?: (config: PerpsKeeperConfig, account: Account) => WalletClient<Transport, Chain, Account>;
  /** Test hook: replaces the independent mark source (a testnet has no API to check against). */
  independent?: PerpsIndependentPriceSource | null;
  makeDispatcher?: (config: PerpsKeeperConfig, log: Logger, reader: PerpsReader, notifier: Notifier) => PerpsDispatcher;
  notifyChannel?: Channel;
  notifier?: Notifier;
  fetchImpl?: typeof fetch;
  onEscalate?: (e: { account: string; reasons: string[]; streak: number }) => void;
}

export const PERPS_KEEPER_DEFAULTS = {
  concurrency: 4,
  maxResumePerTick: 10,
  maxRungRefires: 3,
  backoffFactor: 2,
} as const;

/**
 * The venue's immutables against the shared facts (rule 3: every number read from chain, dated, recorded).
 * On chain 999 a disagreement is fatal — the keeper would be sizing a market the facts do not describe; on
 * the testnet it is said and allowed, because the testnet's universe is its own.
 */
export function checkVenueAgainstFacts(p: PerpsVenueParams, chainId: number): string[] {
  const diffs: string[] = [];
  if (p.perpAsset !== HYPERLIQUID.zec.index) diffs.push(`PERP_ASSET ${p.perpAsset} ≠ the facts' ZEC index ${HYPERLIQUID.zec.index}`);
  if (p.szDecimals !== HYPERLIQUID.zec.szDecimals) diffs.push(`SZ_DECIMALS ${p.szDecimals} ≠ ${HYPERLIQUID.zec.szDecimals}`);
  if (p.maxLeverage !== HYPERLIQUID.zec.maxLeverage) diffs.push(`MAX_LEVERAGE ${p.maxLeverage} ≠ ${HYPERLIQUID.zec.maxLeverage}`);
  if (p.usdcTokenIndex !== HYPERLIQUID.usdc.tokenIndex) diffs.push(`USDC_TOKEN_INDEX ${p.usdcTokenIndex} ≠ ${HYPERLIQUID.usdc.tokenIndex}`);
  if (p.usdcWeiDecimals !== HYPERLIQUID.usdc.weiDecimals) diffs.push(`USDC_WEI_DECIMALS ${p.usdcWeiDecimals} ≠ ${HYPERLIQUID.usdc.weiDecimals}`);
  if (p.usdcEvmDecimals !== HYPERLIQUID.usdc.evmDecimals) diffs.push(`USDC_EVM_DECIMALS ${p.usdcEvmDecimals} ≠ ${HYPERLIQUID.usdc.evmDecimals}`);
  void chainId;
  return diffs;
}

function abandoned(signal: AbortSignal): Promise<PerpsTickReport> {
  return new Promise((resolve) => {
    const done = () => setTimeout(() => resolve({ head: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: true }), 250);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

export async function runPerpsKeeper(env: NodeJS.ProcessEnv, opts: PerpsRunOptions = {}): Promise<{ ticks: number }> {
  const config = loadPerpsConfig(env);
  const log = new Logger(opts.sink ?? stdoutSink, config.logLevel, { svc: "keeper-perps", pid: process.pid });
  log.info("starting", describePerpsConfig(config));
  const viemChain = config.chainId === hyperliquidEvmTestnet.id ? hyperliquidEvmTestnet : hyperEvm;
  if (config.chainId !== HYPERLIQUID.chainId) log.warn("NOT HYPEREVM MAINNET — the testnet; what this run proves is the D3 gate, not production");

  const client = opts.makeClient?.(config) ?? (createPublicClient({ chain: viemChain, transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }) }) as PublicClient);

  let currentHandle: TickHandle | null = null;
  const onProgress = () => currentHandle?.bump();

  // Independent mark: the venue's own API on mainnet; declared-absent on a testnet without one.
  let independent: PerpsIndependentPriceSource | null;
  if (opts.independent !== undefined) independent = opts.independent;
  else if (config.priceSource === "api") independent = infoApiPriceSource(config.infoApiUrl, HYPERLIQUID.zec.index, HYPERLIQUID.zec.coin, opts.fetchImpl ?? fetch);
  else independent = null;
  if (!independent) log.warn("NO INDEPENDENT MARK: valuation trusts the precompile alone. Testnet only — never run this against chain 999.");

  const reader = new PerpsReader(client, config.venueAddress, { deadlineMs: config.rpcDeadlineMs, onProgress, independent });

  // Chain identity, then the venue's immutables, before anything else: a wrong RPC or venue must not populate a store.
  const chainId = await reader.chainId();
  if (chainId !== config.chainId) throw new Error(`RPC reports chain id ${chainId}, config expects ${config.chainId}`);
  const params = await reader.venueParams();
  const diffs = checkVenueAgainstFacts(params, chainId);
  if (diffs.length && chainId === HYPERLIQUID.chainId) throw new Error(`PERPS_VENUE_ADDRESS ${config.venueAddress} is not the venue the shared facts describe: ${diffs.join("; ")}`);
  if (diffs.length) log.warn("the venue's immutables differ from the shared (mainnet) facts — allowed on the testnet", { diffs });
  log.info("venue", { ...params, maxNotionalE6: params.maxNotionalE6.toString() });

  const valuationParams: PerpsValuationParams = { independentMaxAgeS: config.independentMaxAgeS, oracleDeviationBps: config.oracleDeviationBps, requireIndependent: independent !== null };
  const floorLadder: readonly LadderRung[] = perpLadderRungs(params.minEntryDistanceBps);

  const watchdog = new ProgressWatchdog({
    stallMs: config.watchdogStallMs,
    backoff: { initialMs: config.healthPollMs, maxMs: config.healthPollMs * 16, factor: PERPS_KEEPER_DEFAULTS.backoffFactor },
    onStall: (info) => log.error("TICK STALLED — aborted; next tick waits poll + backoff", info),
  });

  const store = new KeeperStore<Address, Hex>(config.storePath);
  await store.open();

  const channels: Channel[] = [logChannel(log), ownerHistoryChannel(store)];
  if (config.notifyWebhookUrl) channels.push(webhookChannel({ url: config.notifyWebhookUrl, fetchImpl: opts.fetchImpl ?? fetch }));
  if (opts.notifyChannel) channels.push(opts.notifyChannel);
  const notifier: Notifier = opts.notifier ?? new MultiNotifier(log, channels, config.notifyDeadlineMs);

  const discovery = new AccountDiscovery(client, { factory: config.factoryAddress, event: accountCreatedEvent, argNames: { owner: "owner", account: "account" }, chunkBlocks: config.discoveryChunkBlocks, deadlineMs: config.rpcDeadlineMs, onProgress });

  let dispatcher: PerpsDispatcher;
  if (opts.makeDispatcher) {
    dispatcher = opts.makeDispatcher(config, log, reader, notifier);
  } else if (config.keeperPrivateKey) {
    const account = privateKeyToAccount(config.keeperPrivateKey);
    const wallet = opts.makeWallet?.(config, account) ?? createWalletClient({ account, chain: viemChain, transport: http(config.rpcUrl, { timeout: config.rpcDeadlineMs, retryCount: 1 }) });
    log.info("keeper mode", { keeper: account.address, venue: config.venueAddress, actionDelayBlocks: config.actionDelayBlocks, deriskFractionBps: config.deriskFractionBps });
    dispatcher = new KeeperPerpsDispatcher({
      client,
      wallet,
      keeper: account.address.toLowerCase() as Address,
      venue: config.venueAddress,
      reader,
      valuationParams,
      deriskFractionBps: config.deriskFractionBps,
      planMarginBps: config.planMarginBps,
      actionDelayBlocks: config.actionDelayBlocks,
      deadlineMs: config.rpcDeadlineMs,
      log,
      notifier,
    });
  } else {
    log.warn("OBSERVE-ONLY: no KEEPER_PERPS_PRIVATE_KEY — rungs are recorded and warnings delivered, every on-chain action is REFUSED by name");
    dispatcher = new PerpsObserveOnlyDispatcher(log, notifier);
  }

  let fatalStoreError: Error | null = null;
  const monitor = new PerpsMonitor({
    reader,
    discovery,
    store,
    floorLadder,
    dispatcher,
    log,
    config: {
      concurrency: PERPS_KEEPER_DEFAULTS.concurrency,
      unknownEscalationStreak: config.unknownEscalationStreak,
      maxDispatchAttempts: config.maxDispatchAttempts,
      maxResumePerTick: PERPS_KEEPER_DEFAULTS.maxResumePerTick,
      dispatchDeadlineMs: config.dispatchDeadlineMs,
      maxRungRefires: PERPS_KEEPER_DEFAULTS.maxRungRefires,
      discoveryFromBlock: config.discoveryFromBlock,
    },
    valuationParams,
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
  const wdTimer = setInterval(() => watchdog.check(), Math.max(250, Math.floor(config.watchdogStallMs / 4)));

  let ticks = 0;
  try {
    while (!stop.signal.aborted && !fatalStoreError) {
      const handle = watchdog.beginTick();
      const combined = AbortSignal.any([handle.signal, stop.signal]);
      const tickHandle: TickHandle = { signal: combined, bump: handle.bump, end: handle.end };
      currentHandle = tickHandle;
      const report = await Promise.race([monitor.tick(tickHandle), abandoned(combined)]);
      currentHandle = null;
      ticks += 1;
      log.info("heartbeat", { ticks, head: report.head?.toString() ?? null, evaluated: report.evaluated, discovered: report.discovered, resumed: report.resumed, backoffMs: watchdog.currentBackoffMs, stalls: watchdog.stallCount });
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
