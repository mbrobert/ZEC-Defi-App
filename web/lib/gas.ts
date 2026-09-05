/**
 * "Do I have enough ETH on Base for the fee?" — checked BEFORE the wallet is
 * asked, for every transaction, so a first-time user never hits an opaque
 * wallet error. Pure `assessGas` for tests; `estimateForWrite` does the reads.
 */
import type { Address, Hex } from "viem";
import { fromAtomic } from "./math";

/** Headroom on the estimate: base-fee moves and a wallet's own padding. Product policy, not a chain number. */
export const GAS_HEADROOM_BPS = 5_000; // ×1.5
export const MIN_ETH_RESERVE_WEI = 0n;

export interface GasAssessment {
  ok: boolean;
  gasUnits: bigint;
  gasPriceWei: bigint;
  /** Estimate × price × headroom. */
  costWei: bigint;
  balanceWei: bigint;
  shortfallWei: bigint;
  costEth: number;
  balanceEth: number;
  /** USD figures when an ETH price is known. */
  costUsd: number | null;
  shortfallUsd: number | null;
  /** One plain sentence for the user. */
  plain: string;
}

export function assessGas(gasUnits: bigint, gasPriceWei: bigint, balanceWei: bigint, ethPriceUsd: number | null): GasAssessment {
  const costWei = (gasUnits * gasPriceWei * BigInt(10_000 + GAS_HEADROOM_BPS)) / 10_000n;
  const shortfallWei = costWei > balanceWei ? costWei - balanceWei : 0n;
  const costEth = fromAtomic(costWei, 18);
  const balanceEth = fromAtomic(balanceWei, 18);
  const costUsd = ethPriceUsd !== null ? costEth * ethPriceUsd : null;
  const shortfallUsd = ethPriceUsd !== null ? fromAtomic(shortfallWei, 18) * ethPriceUsd : null;
  const ok = shortfallWei === 0n;
  const fmtEth = (x: number) => (x < 0.0001 ? x.toExponential(2) : x.toFixed(6));
  const plain = ok
    ? `Network fee about ${fmtEth(costEth)} ETH${costUsd !== null ? ` (≈ $${costUsd.toFixed(2)})` : ""}; you have ${fmtEth(balanceEth)} ETH on Base — enough.`
    : `This needs about ${fmtEth(costEth)} ETH on Base for the network fee${costUsd !== null ? ` (≈ $${costUsd.toFixed(2)})` : ""} and your wallet has ${fmtEth(balanceEth)} ETH — add at least ${fmtEth(fromAtomic(shortfallWei, 18))} ETH on Base (bridge or buy in your wallet) before signing.`;
  return { ok, gasUnits, gasPriceWei, costWei, balanceWei, shortfallWei, costEth, balanceEth, costUsd, shortfallUsd, plain };
}

export interface GasClient {
  estimateGas: (args: { account: Address; to: Address; data: Hex; value?: bigint }) => Promise<bigint>;
  getGasPrice: () => Promise<bigint>;
  getBalance: (args: { address: Address }) => Promise<bigint>;
}

/**
 * Estimate a wallet transaction. An estimate that REVERTS is returned as
 * `revert` with the message — the user sees why before the wallet does.
 */
export async function estimateForWrite(
  client: GasClient,
  from: Address,
  tx: { address: Address; data: Hex; value?: bigint },
  ethPriceUsd: number | null,
): Promise<{ gas: GasAssessment } | { revert: string }> {
  try {
    const [gasUnits, gasPriceWei, balanceWei] = await Promise.all([
      client.estimateGas({ account: from, to: tx.address, data: tx.data, value: tx.value }),
      client.getGasPrice(),
      client.getBalance({ address: from }),
    ]);
    return { gas: assessGas(gasUnits, gasPriceWei, balanceWei, ethPriceUsd) };
  } catch (e) {
    return { revert: shortenRevert((e as Error).message ?? String(e)) };
  }
}

/** Trim viem's long error text to the first meaningful line. */
export function shortenRevert(msg: string): string {
  const first = msg.split("\n").find((l) => l.trim().length > 0) ?? msg;
  return first.length > 220 ? `${first.slice(0, 220)}…` : first;
}
