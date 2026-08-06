import type { Strategy, LpParams, BorrowAssetSymbol, CuratedPool } from "@zyo/shared";
import { poolById } from "@zyo/shared";
import type { RheaService } from "../services/rhea.js";
import type { StrategyStore } from "../store/strategyStore.js";

export interface UpgradeRequest {
  strategyId: string;
  borrowAsset: BorrowAssetSymbol;
  /** Atomic units of the borrow asset. */
  borrowAmountAtomic: string;
  poolId: string;
  lpParams: LpParams;
  /** Base vault address the borrowed funds are delivered to. */
  vaultAddress: string;
}

/**
 * Simple → Full Strategy upgrade.
 *
 * Steps (each idempotent; status is persisted between steps so a crashed
 * agent resumes instead of double-borrowing):
 *   1. BORROWING          — rhea.borrow with cross-chain delivery to the vault
 *   2. BRIDGING_TO_BASE   — wait for funds to arrive at the vault
 *   3. ENTERING_LP        — operator calls vault.openFor with the user's params
 *   4. ACTIVE_FULL
 *
 * Step 3 is executed by the caller (needs BaseChainService + arrival amount);
 * this class owns the borrow + state machine.
 */
export class UpgradeExecutor {
  constructor(
    private readonly rhea: RheaService,
    private readonly store: StrategyStore
  ) {}

  validate(req: UpgradeRequest, strategy: Strategy): { pool: CuratedPool } {
    if (strategy.mode !== "SIMPLE_LENDING") {
      throw new Error(`strategy ${strategy.id} is not in Simple mode`);
    }
    if (strategy.status !== "ACTIVE_SIMPLE") {
      throw new Error(`strategy ${strategy.id} not upgradable from status ${strategy.status}`);
    }
    const pool = poolById(req.poolId);
    if (!pool) throw new Error(`unknown pool ${req.poolId}`);
    if (pool.entryAsset !== req.borrowAsset) {
      throw new Error(
        `pool ${pool.id} entry asset ${pool.entryAsset} != borrow asset ${req.borrowAsset}`
      );
    }
    return { pool };
  }

  /** Steps 1–2: borrow with delivery to the Base vault. */
  async startUpgrade(req: UpgradeRequest): Promise<Strategy> {
    const strategy = await this.store.get(req.strategyId);
    if (!strategy) throw new Error(`strategy ${req.strategyId} not found`);
    const { pool } = this.validate(req, strategy);

    await this.store.update(strategy.id, { status: "BORROWING" });

    const { txId } = await this.rhea.borrow({
      mcaId: strategy.lending.mcaId,
      asset: req.borrowAsset,
      amountAtomic: req.borrowAmountAtomic,
      deliverTo: { chain: "base", address: req.vaultAddress },
    });
    console.log(`[upgrade] ${strategy.id} borrow tx ${txId}`);

    return this.store.update(strategy.id, {
      status: "BRIDGING_TO_BASE",
      mode: "FULL_STRATEGY",
      lending: {
        ...strategy.lending,
        borrowedAsset: req.borrowAsset,
        borrowedAmountAtomic: req.borrowAmountAtomic,
      },
      lp: {
        protocol: pool.protocol,
        poolId: pool.id,
        depositToken: req.borrowAsset,
        depositAmountAtomic: req.borrowAmountAtomic,
        params: req.lpParams,
      },
    });
  }

  /** Step 4: record the opened vault position. */
  async completeUpgrade(strategyId: string, vaultPositionId: number): Promise<Strategy> {
    const strategy = await this.store.get(strategyId);
    if (!strategy?.lp) throw new Error(`strategy ${strategyId} has no LP leg`);
    return this.store.update(strategyId, {
      status: "ACTIVE_FULL",
      lp: { ...strategy.lp, vaultPositionId },
    });
  }
}
