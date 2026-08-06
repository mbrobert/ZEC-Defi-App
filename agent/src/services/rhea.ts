import type { BorrowAssetSymbol } from "@zyo/shared";

/**
 * Abstraction over Rhea Finance's cross-chain lending.
 *
 * The real implementation wraps @rhea-finance/cross-chain-sdk:
 *   • Multi-Chain Account (MCA) creation per user
 *   • intent-based native ZEC supply
 *   • borrow with cross-chain delivery (e.g. USDC → Base)
 *   • health-factor reads
 *
 * The SDK is imported dynamically so the agent builds and tests without it;
 * run with RHEA_MODE=mock until the SDK dependency is installed and wired.
 */

export interface RheaAccountState {
  mcaId: string;
  suppliedZecAtomic: string;
  borrowedAssets: { symbol: BorrowAssetSymbol; amountAtomic: string }[];
  healthFactor: number;
  /** Max additional borrow (USD) at current collateral. */
  borrowHeadroomUsd: number;
}

export interface BorrowRequest {
  mcaId: string;
  asset: BorrowAssetSymbol;
  amountAtomic: string;
  /** Chain + address the borrowed funds should be delivered to (e.g. the Base vault). */
  deliverTo: { chain: "base"; address: string };
}

export interface RheaService {
  /** Create (or fetch) the user's Multi-Chain Account. */
  ensureAccount(userKey: string): Promise<{ mcaId: string; zecDepositAddress: string }>;
  getAccountState(mcaId: string): Promise<RheaAccountState>;
  /** Supply ZEC that arrived at the MCA deposit address. */
  supplyZec(mcaId: string, amountAtomic: string): Promise<{ txId: string }>;
  /** Borrow and deliver cross-chain. */
  borrow(req: BorrowRequest): Promise<{ txId: string }>;
  repay(mcaId: string, asset: BorrowAssetSymbol, amountAtomic: string): Promise<{ txId: string }>;
  withdrawZec(mcaId: string, amountAtomic: string, toZcashAddress: string): Promise<{ txId: string }>;
}

/** Deterministic in-memory implementation for dev, tests, and demos. */
export class MockRheaService implements RheaService {
  private accounts = new Map<string, RheaAccountState>();
  private seq = 0;

  async ensureAccount(userKey: string) {
    const mcaId = `mca-${userKey.slice(0, 8)}.near`;
    if (!this.accounts.has(mcaId)) {
      this.accounts.set(mcaId, {
        mcaId,
        suppliedZecAtomic: "0",
        borrowedAssets: [],
        healthFactor: Infinity,
        borrowHeadroomUsd: 0,
      });
    }
    return { mcaId, zecDepositAddress: `t1MockDeposit${userKey.slice(0, 10)}` };
  }

  async getAccountState(mcaId: string): Promise<RheaAccountState> {
    const acc = this.accounts.get(mcaId);
    if (!acc) throw new Error(`unknown MCA ${mcaId}`);
    return structuredClone(acc);
  }

  async supplyZec(mcaId: string, amountAtomic: string) {
    const acc = await this.mustGet(mcaId);
    acc.suppliedZecAtomic = (
      BigInt(acc.suppliedZecAtomic) + BigInt(amountAtomic)
    ).toString();
    // crude: $50/ZEC placeholder, 60% max LTV → headroom in USD
    const zec = Number(acc.suppliedZecAtomic) / 1e8;
    acc.borrowHeadroomUsd = zec * 50 * 0.6;
    this.recomputeHf(acc);
    return { txId: `mock-supply-${++this.seq}` };
  }

  async borrow(req: BorrowRequest) {
    const acc = await this.mustGet(req.mcaId);
    const existing = acc.borrowedAssets.find((b) => b.symbol === req.asset);
    if (existing) {
      existing.amountAtomic = (
        BigInt(existing.amountAtomic) + BigInt(req.amountAtomic)
      ).toString();
    } else {
      acc.borrowedAssets.push({ symbol: req.asset, amountAtomic: req.amountAtomic });
    }
    this.recomputeHf(acc);
    return { txId: `mock-borrow-${++this.seq}` };
  }

  async repay(mcaId: string, asset: BorrowAssetSymbol, amountAtomic: string) {
    const acc = await this.mustGet(mcaId);
    const existing = acc.borrowedAssets.find((b) => b.symbol === asset);
    if (existing) {
      const next = BigInt(existing.amountAtomic) - BigInt(amountAtomic);
      existing.amountAtomic = (next > 0n ? next : 0n).toString();
    }
    this.recomputeHf(acc);
    return { txId: `mock-repay-${++this.seq}` };
  }

  async withdrawZec(mcaId: string, amountAtomic: string) {
    const acc = await this.mustGet(mcaId);
    const next = BigInt(acc.suppliedZecAtomic) - BigInt(amountAtomic);
    acc.suppliedZecAtomic = (next > 0n ? next : 0n).toString();
    this.recomputeHf(acc);
    return { txId: `mock-withdraw-${++this.seq}` };
  }

  /** Test hook: force a health factor (simulates ZEC price move). */
  setHealthFactor(mcaId: string, hf: number) {
    const acc = this.accounts.get(mcaId);
    if (acc) acc.healthFactor = hf;
  }

  private async mustGet(mcaId: string): Promise<RheaAccountState> {
    const acc = this.accounts.get(mcaId);
    if (!acc) throw new Error(`unknown MCA ${mcaId}`);
    return acc;
  }

  private recomputeHf(acc: RheaAccountState) {
    // Placeholder economics for the mock: collateral $ = zec*50, debt $ = USDC-equivalent 1:1e6.
    const collateralUsd = (Number(acc.suppliedZecAtomic) / 1e8) * 50;
    const debtUsd = acc.borrowedAssets.reduce(
      (s, b) => s + Number(b.amountAtomic) / 1e6,
      0
    );
    acc.healthFactor = debtUsd === 0 ? Infinity : (collateralUsd * 0.7) / debtUsd;
  }
}

/**
 * Real SDK wrapper. Kept behind a dynamic import so the workspace
 * builds/tests without the dependency installed.
 *
 * TODO(integration): `npm i @rhea-finance/cross-chain-sdk -w @zyo/agent`,
 * then map each method to the SDK's MCA + intent-deposit calls and delete
 * the NotWired errors. See docs/INTEGRATIONS.md.
 */
export class RheaSdkService implements RheaService {
  private sdk: unknown;

  static async create(networkId: "mainnet" | "testnet"): Promise<RheaSdkService> {
    const svc = new RheaSdkService();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      svc.sdk = await (Function('return import("@rhea-finance/cross-chain-sdk")')() as Promise<unknown>);
    } catch {
      throw new Error(
        "@rhea-finance/cross-chain-sdk is not installed. Run the agent with RHEA_MODE=mock, " +
          "or install the SDK and wire RheaSdkService (docs/INTEGRATIONS.md)."
      );
    }
    void networkId;
    return svc;
  }

  ensureAccount(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
  getAccountState(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
  supplyZec(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
  borrow(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
  repay(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
  withdrawZec(): never {
    throw new Error("RheaSdkService not wired yet — see docs/INTEGRATIONS.md");
  }
}
