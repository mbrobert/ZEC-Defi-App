/**
 * Solana runtime configuration — PUBLIC (NEXT_PUBLIC_*), like lib/env.ts. Every address is selected by the
 * named cluster and nothing falls back to mainnet by accident (SOLANA-ARCHITECTURE.md §6): with no cluster
 * named the Solana surfaces run in demo mode only; "localnet" points at the harness on 127.0.0.1:8899; the
 * program id is never defaulted — the deploy gives it (DEPLOYMENTS.md).
 */
import { SOLANA_CLUSTER } from "@zyo/shared";

export type SolanaClusterName = "mainnet-beta" | "localnet";
const CLUSTER_RAW = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "";
const cluster: SolanaClusterName | null = CLUSTER_RAW === "mainnet-beta" || CLUSTER_RAW === "localnet" ? CLUSTER_RAW : null;
const isKey = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export const SOLANA_ENV = {
  cluster,
  /** JSON-RPC for reads and for the wallet's sends; the cluster's public endpoint by default, the harness on localnet. */
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? (cluster === "localnet" ? "http://127.0.0.1:8899" : SOLANA_CLUSTER.rpcDefault),
  /** The Oilskin program on this cluster. Unset = reads skipped, writes disabled, demo only. */
  programId: process.env.NEXT_PUBLIC_OILSKIN_SOLANA_PROGRAM ?? "",
  /** The Oilskin keeper's Solana public key (optional): enables the revocable protection grant step. */
  keeper: process.env.NEXT_PUBLIC_OILSKIN_SOLANA_KEEPER ?? "",
  explorerUrl: SOLANA_CLUSTER.explorerUrl,
  /**
   * The cross-chain loop's DEPLOY choice (ROADMAP §3: the loop ships behind a flag until the devnet ↔ Sepolia run
   * has passed). Off: the wizard still shows the loop's forecast, and says the crossing cannot be chosen in this
   * build. On: a pool may be chosen; the crossing's own transactions are listed as not yet signable here.
   */
  loopEnabled: process.env.NEXT_PUBLIC_CROSS_CHAIN_LOOP === "1",
} as const;

export function solanaConfigured(): boolean {
  return SOLANA_ENV.cluster !== null && isKey(SOLANA_ENV.programId);
}
export function solanaKeeperConfigured(): boolean {
  return solanaConfigured() && isKey(SOLANA_ENV.keeper);
}
/** Explorer link for a signature; a localnet link carries the custom RPC so it resolves. */
export function explorerTx(signature: string): string {
  return SOLANA_ENV.cluster === "localnet" ? `${SOLANA_ENV.explorerUrl}/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(SOLANA_ENV.rpcUrl)}` : `${SOLANA_ENV.explorerUrl}/tx/${signature}`;
}
export function explorerAccount(address: string): string {
  return SOLANA_ENV.cluster === "localnet" ? `${SOLANA_ENV.explorerUrl}/account/${address}?cluster=custom&customUrl=${encodeURIComponent(SOLANA_ENV.rpcUrl)}` : `${SOLANA_ENV.explorerUrl}/account/${address}`;
}
