import { createServer, type Server } from "node:http";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  padHex,
  toHex,
  type AbiEvent,
  type Hex,
  type PublicClient,
} from "viem";
import { aaveOracleAbi, aavePoolAbi, aavePoolDataProviderAbi, chainlinkAggregatorAbi } from "../src/abi/aave.js";
import type { Address } from "../src/types/evm.js";
import { MAX_UINT256 } from "../src/types/evm.js";

/**
 * In-memory Base stand-in. Serves real ABI-encoded answers to real calldata,
 * so the reader's encoding/decoding is exercised end to end. Faults are
 * injectable per call label for adversarial tests.
 */

export interface MockReserve {
  symbol: string;
  asset: Address;
  decimals: number;
  liquidationThresholdBps: bigint;
  isActive: boolean;
  /** Aave oracle price, 8 decimals. */
  aavePrice: bigint;
  feed: Address | null;
  chainlink: { roundId: bigint; answer: bigint; updatedAt: bigint; answeredInRound: bigint; decimals: number } | null;
  /** Seconds between this feed's published rounds (drives getRoundData history). */
  heartbeatS?: bigint;
  /**
   * Gaps before each round walking BACK from the latest, newest first: index 0
   * is `latest − (latest − 1)`. Beyond the array, `heartbeatS` applies. This is
   * how a real Chainlink feed behaves — short deviation-driven gaps in an
   * active market, then heartbeat-length ones when it calms (FEED-MED-1).
   */
  gapScheduleS?: bigint[];
  /** Historical rounds are unavailable on this proxy (probe falls back). */
  noRoundHistory?: boolean;
}

export interface MockUserReserve {
  aTokenBalance: bigint;
  stableDebt: bigint;
  variableDebt: bigint;
  usingAsCollateral: boolean;
}

export interface MockAccountOverride {
  totalCollateralBase?: bigint;
  totalDebtBase?: bigint;
  currentLiquidationThreshold?: bigint;
  healthFactor?: bigint;
}

export type Fault = { kind: "revert"; message?: string } | { kind: "hang" } | { kind: "garbage" } | { kind: "delay"; ms: number };

export interface MockLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export class MockChain {
  chainId = 8453;
  blockNumber = 1_000n;
  nowS = 1_800_000_000n;
  reserves = new Map<string, MockReserve>(); // key: asset lowercase
  users = new Map<string, Map<string, MockUserReserve>>(); // account → asset → data
  overrides = new Map<string, MockAccountOverride>();
  logs: MockLog[] = [];
  faults = new Map<string, Fault>(); // label → fault
  calls: { method: string; label: string }[] = [];
  /** Extra eth_call handlers keyed by `${to}` (lowercase) for contract mocks (e.g. OilskinAccount). */
  contracts = new Map<string, (data: Hex, from?: Address) => Promise<Hex> | Hex>();
  /** Raw transaction hook: receives the raw tx hex, returns the hash. */
  onSendRawTransaction: ((raw: Hex) => Promise<Hex> | Hex) | null = null;
  receipts = new Map<string, { status: "0x1" | "0x0"; blockNumber: bigint; logs?: MockLog[] }>();
  txCount = new Map<string, number>();
  gasPrice = 1_000_000n;

  constructor(
    readonly addresses: { pool: Address; dataProvider: Address; oracle: Address; factory: Address },
    readonly accountCreatedEvent: AbiEvent
  ) {}

  // ---- setup helpers ---------------------------------------------------------

  addReserve(r: MockReserve): void {
    this.reserves.set(r.asset.toLowerCase(), r);
  }

  setUserReserve(account: Address, asset: Address, u: Partial<MockUserReserve>): void {
    const a = account.toLowerCase();
    if (!this.users.has(a)) this.users.set(a, new Map());
    const m = this.users.get(a)!;
    const prev = m.get(asset.toLowerCase()) ?? { aTokenBalance: 0n, stableDebt: 0n, variableDebt: 0n, usingAsCollateral: false };
    m.set(asset.toLowerCase(), { ...prev, ...u });
  }

  /** Convenience: supply `collateral` of `asset` and borrow `debt` of `debtAsset` (atomic units). */
  setPosition(account: Address, pos: { collateral: { asset: Address; amount: bigint }[]; debt: { asset: Address; amount: bigint }[] }): void {
    this.users.set(account.toLowerCase(), new Map());
    for (const c of pos.collateral) this.setUserReserve(account, c.asset, { aTokenBalance: c.amount, usingAsCollateral: c.amount > 0n });
    for (const d of pos.debt) this.setUserReserve(account, d.asset, { variableDebt: d.amount });
  }

  emitAccountCreated(owner: Address, account: Address, blockNumber = this.blockNumber): void {
    const topics = encodeEventTopics({ abi: [this.accountCreatedEvent], eventName: this.accountCreatedEvent.name, args: { owner, account } as never });
    // Non-indexed args (if any) — our event indexes both, so data is empty.
    const nonIndexed = this.accountCreatedEvent.inputs.filter((i) => !i.indexed);
    const data = nonIndexed.length
      ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => (i.name === "owner" ? owner : account)))
      : "0x";
    this.logs.push({ address: this.addresses.factory, topics: topics as Hex[], data, blockNumber, logIndex: this.logs.length });
  }

  /** Aave-style derived totals for an account (unless overridden). */
  accountData(account: Address): [bigint, bigint, bigint, bigint, bigint, bigint] {
    const m = this.users.get(account.toLowerCase()) ?? new Map<string, MockUserReserve>();
    let collateral = 0n;
    let debt = 0n;
    let weightedLt = 0n;
    for (const [asset, u] of m) {
      const r = this.reserves.get(asset);
      if (!r) continue;
      const unit = 10n ** BigInt(r.decimals);
      if (u.aTokenBalance > 0n && u.usingAsCollateral) {
        const v = (u.aTokenBalance * r.aavePrice) / unit;
        collateral += v;
        weightedLt += v * r.liquidationThresholdBps;
      }
      const d = u.stableDebt + u.variableDebt;
      if (d > 0n) debt += (d * r.aavePrice) / unit;
    }
    const lt = collateral > 0n ? weightedLt / collateral : 0n;
    const hf = debt === 0n ? MAX_UINT256 : (collateral * lt * 10n ** 18n) / (debt * 10_000n);
    const o = this.overrides.get(account.toLowerCase()) ?? {};
    return [
      o.totalCollateralBase ?? collateral,
      o.totalDebtBase ?? debt,
      0n,
      o.currentLiquidationThreshold ?? lt,
      0n,
      o.healthFactor ?? hf,
    ];
  }

  // ---- fault injection --------------------------------------------------------

  private async applyFault(label: string): Promise<Hex | null> {
    const f = this.faults.get(label);
    if (!f) return null;
    if (f.kind === "revert") throw rpcError(3, `execution reverted${f.message ? `: ${f.message}` : ""}`);
    if (f.kind === "hang") return new Promise<Hex>(() => undefined);
    if (f.kind === "garbage") return "0xdeadbeef";
    await new Promise((r) => setTimeout(r, f.ms));
    return null;
  }

  // ---- JSON-RPC ----------------------------------------------------------------

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        this.calls.push({ method, label: "eth_chainId" });
        return numberToHex(this.chainId);
      case "eth_blockNumber": {
        this.calls.push({ method, label: "eth_blockNumber" });
        const f = await this.applyFault("eth_blockNumber");
        if (f) return f;
        return numberToHex(this.blockNumber);
      }
      case "eth_call":
        return this.ethCall(p[0] as { to: Address; data: Hex; from?: Address });
      case "eth_getLogs":
        return this.getLogs(p[0] as { address?: Address; topics?: (Hex | null)[]; fromBlock: Hex; toBlock: Hex });
      case "eth_gasPrice":
        return numberToHex(this.gasPrice);
      case "eth_maxPriorityFeePerGas":
        return numberToHex(1_000n);
      case "eth_getBlockByNumber": {
        this.calls.push({ method, label: "eth_getBlockByNumber" });
        const bf = await this.applyFault("eth_getBlockByNumber");
        if (bf) return bf;
        return {
          number: numberToHex(this.blockNumber),
          baseFeePerGas: numberToHex(this.gasPrice),
          timestamp: numberToHex(this.nowS),
          hash: padHex("0x1", { size: 32 }),
          parentHash: padHex("0x0", { size: 32 }),
          gasLimit: numberToHex(30_000_000n),
          gasUsed: "0x0",
          transactions: [],
          logsBloom: "0x" + "00".repeat(256),
          miner: padHex("0x0", { size: 20 }),
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          extraData: "0x",
          sha3Uncles: padHex("0x0", { size: 32 }),
          stateRoot: padHex("0x0", { size: 32 }),
          receiptsRoot: padHex("0x0", { size: 32 }),
          transactionsRoot: padHex("0x0", { size: 32 }),
          size: "0x0",
          totalDifficulty: "0x0",
          uncles: [],
          mixHash: padHex("0x0", { size: 32 }),
        };
      }
      case "eth_getTransactionCount": {
        const a = String(p[0]).toLowerCase();
        return numberToHex(this.txCount.get(a) ?? 0);
      }
      case "eth_estimateGas":
        return numberToHex(300_000n);
      case "eth_sendRawTransaction": {
        this.calls.push({ method, label: "eth_sendRawTransaction" });
        const f = await this.applyFault("eth_sendRawTransaction");
        if (f) return f;
        const raw = p[0] as Hex;
        const hash = this.onSendRawTransaction ? await this.onSendRawTransaction(raw) : keccak256(raw);
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const h = String(p[0]).toLowerCase();
        const r = this.receipts.get(h);
        if (!r) return null;
        return {
          transactionHash: h,
          status: r.status,
          blockNumber: numberToHex(r.blockNumber),
          blockHash: padHex("0x1", { size: 32 }),
          transactionIndex: "0x0",
          from: padHex("0x0", { size: 20 }),
          to: padHex("0x0", { size: 20 }),
          cumulativeGasUsed: "0x0",
          gasUsed: "0x0",
          effectiveGasPrice: numberToHex(this.gasPrice),
          contractAddress: null,
          logs: (r.logs ?? []).map((l, i) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: numberToHex(l.blockNumber),
            blockHash: padHex("0x1", { size: 32 }),
            transactionHash: h,
            transactionIndex: "0x0",
            logIndex: numberToHex(BigInt(i)),
            removed: false,
          })),
          logsBloom: "0x" + "00".repeat(256),
          type: "0x2",
        };
      }
      default:
        throw rpcError(-32601, `mock: unsupported method ${method}`);
    }
  }

  private async ethCall(tx: { to: Address; data: Hex; from?: Address }): Promise<Hex> {
    const to = tx.to.toLowerCase();
    const { pool, dataProvider, oracle } = this.addresses;

    if (to === pool.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: aavePoolAbi, data: tx.data });
      if (functionName === "getUserAccountData") {
        const [user] = args as [Address];
        const label = `getUserAccountData(${user.toLowerCase()})`;
        this.calls.push({ method: "eth_call", label });
        const f = await this.applyFault(label);
        if (f) return f;
        return encodeFunctionResult({ abi: aavePoolAbi, functionName, result: this.accountData(user) });
      }
    }
    if (to === dataProvider.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: aavePoolDataProviderAbi, data: tx.data });
      if (functionName === "getReserveConfigurationData") {
        const [asset] = args as [Address];
        const r = this.reserves.get(asset.toLowerCase());
        const label = `getReserveConfigurationData(${r?.symbol ?? asset.toLowerCase()})`;
        this.calls.push({ method: "eth_call", label });
        const f = await this.applyFault(label);
        if (f) return f;
        if (!r) return encodeFunctionResult({ abi: aavePoolDataProviderAbi, functionName, result: [0n, 0n, 0n, 0n, 0n, false, false, false, false, false] });
        return encodeFunctionResult({
          abi: aavePoolDataProviderAbi,
          functionName,
          result: [BigInt(r.decimals), 0n, r.liquidationThresholdBps, 0n, 0n, r.liquidationThresholdBps > 0n, true, false, r.isActive, false],
        });
      }
      if (functionName === "getUserReserveData") {
        const [asset, user] = args as [Address, Address];
        const r = this.reserves.get(asset.toLowerCase());
        const label = `getUserReserveData(${r?.symbol ?? asset.toLowerCase()},${user.toLowerCase()})`;
        this.calls.push({ method: "eth_call", label });
        const f = await this.applyFault(label);
        if (f) return f;
        const u = this.users.get(user.toLowerCase())?.get(asset.toLowerCase()) ?? {
          aTokenBalance: 0n,
          stableDebt: 0n,
          variableDebt: 0n,
          usingAsCollateral: false,
        };
        return encodeFunctionResult({
          abi: aavePoolDataProviderAbi,
          functionName,
          result: [u.aTokenBalance, u.stableDebt, u.variableDebt, 0n, 0n, 0n, 0n, 0, u.usingAsCollateral],
        });
      }
    }
    if (to === oracle.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: aaveOracleAbi, data: tx.data });
      if (functionName === "getAssetPrice") {
        const [asset] = args as [Address];
        const r = this.reserves.get(asset.toLowerCase());
        const label = `getAssetPrice(${r?.symbol ?? asset.toLowerCase()})`;
        this.calls.push({ method: "eth_call", label });
        const f = await this.applyFault(label);
        if (f) return f;
        return encodeFunctionResult({ abi: aaveOracleAbi, functionName, result: r?.aavePrice ?? 0n });
      }
    }
    for (const r of this.reserves.values()) {
      if (r.feed && to === r.feed.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: chainlinkAggregatorAbi, data: tx.data });
        const label = `${functionName}(${r.symbol})`;
        this.calls.push({ method: "eth_call", label });
        const f = await this.applyFault(label);
        if (f) return f;
        if (!r.chainlink) throw rpcError(3, "execution reverted");
        if (functionName === "latestRoundData") {
          const c = r.chainlink;
          return encodeFunctionResult({
            abi: chainlinkAggregatorAbi,
            functionName,
            result: [c.roundId, c.answer, c.updatedAt, c.updatedAt, c.answeredInRound],
          });
        }
        if (functionName === "getRoundData") {
          const c = r.chainlink;
          if (r.noRoundHistory) throw rpcError(3, "execution reverted: No data present");
          const { args } = decodeFunctionData({ abi: chainlinkAggregatorAbi, data: tx.data });
          const [want] = args as [bigint];
          if (want <= 0n || want > c.roundId) throw rpcError(3, "execution reverted: No data present");
          // A feed publishes on its heartbeat: round n was published
          // `heartbeat × (latest − n)` seconds before the latest one — unless a
          // gap schedule says otherwise for the most recent rounds.
          const beat = r.heartbeatS ?? 3600n;
          const back = Number(c.roundId - want);
          const sched = r.gapScheduleS;
          let elapsed = 0n;
          for (let k = 0; k < back; k++) elapsed += sched && k < sched.length ? sched[k] : beat;
          const updatedAt = c.updatedAt - elapsed;
          return encodeFunctionResult({
            abi: chainlinkAggregatorAbi,
            functionName,
            result: [want, c.answer, updatedAt, updatedAt, want],
          });
        }
        return encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: "decimals", result: r.chainlink.decimals });
      }
    }
    const custom = this.contracts.get(to);
    if (custom) {
      this.calls.push({ method: "eth_call", label: `custom(${to})` });
      return custom(tx.data, tx.from);
    }
    throw rpcError(3, `mock: no contract at ${tx.to}`);
  }

  private async getLogs(q: { address?: Address; topics?: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }): Promise<unknown[]> {
    const from = BigInt(q.fromBlock);
    const to = BigInt(q.toBlock);
    const label = `eth_getLogs(${from}-${to})`;
    this.calls.push({ method: "eth_getLogs", label });
    const f = await this.applyFault(label);
    if (f) throw rpcError(-32000, "mock: getLogs fault");
    const topic0 = q.topics?.[0];
    return this.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => !q.address || l.address.toLowerCase() === q.address.toLowerCase())
      .filter((l) => !topic0 || l.topics[0] === topic0)
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: numberToHex(l.blockNumber),
        blockHash: padHex("0x1", { size: 32 }),
        transactionHash: padHex(toHex(l.logIndex + 1), { size: 32 }),
        transactionIndex: "0x0",
        logIndex: numberToHex(l.logIndex),
        removed: false,
      }));
  }

  // ---- clients ------------------------------------------------------------

  transport() {
    return custom({ request: (args: { method: string; params?: unknown }) => this.request(args) }, { retryCount: 0 });
  }

  publicClient(): PublicClient {
    return createPublicClient({ transport: this.transport() }) as PublicClient;
  }

  /** Serve the mock over HTTP for the real-process liveness test. */
  async listen(): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const reply = (payload: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(payload));
        };
        try {
          const msg = JSON.parse(body) as { id: number; method: string; params?: unknown } | { id: number; method: string; params?: unknown }[];
          const handle = async (m: { id: number; method: string; params?: unknown }) => {
            try {
              return { jsonrpc: "2.0", id: m.id, result: await this.request(m) };
            } catch (e) {
              const err = e as { code?: number; message?: string; data?: string };
              return { jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32000, message: err.message ?? String(e), ...(err.data ? { data: err.data } : {}) } };
            }
          };
          reply(Array.isArray(msg) ? await Promise.all(msg.map(handle)) : await handle(msg));
        } catch (e) {
          reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e) } });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${addr.port}`,
      server,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}
