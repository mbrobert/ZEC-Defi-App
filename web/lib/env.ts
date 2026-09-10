/**
 * Runtime configuration. Everything here is PUBLIC (NEXT_PUBLIC_*): the web
 * app holds no secrets, signs nothing itself, and never broadcasts on the
 * user's behalf — the wallet does.
 */

import { chainTable, isSupportedChainId } from "@zyo/shared";

const CHAIN_ID_RAW = process.env.NEXT_PUBLIC_CHAIN_ID ?? "8453";
const CHAIN_ID_NUM = /^\d+$/.test(CHAIN_ID_RAW.trim()) ? Number(CHAIN_ID_RAW) : NaN;

export const ENV = {
  /**
   * Chain this build reads and signs on: 8453 (Base, the product) or 84532 (Base Sepolia, the
   * rehearsal). Anything else fails at load in lib/chain.ts, by name — never a mainnet address on
   * the wrong chain (slice 6, 2026-09-10).
   */
  chainId: CHAIN_ID_NUM,
  /** JSON-RPC used for reads: the chain's public endpoint by default; override per deploy. */
  baseRpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? (isSupportedChainId(CHAIN_ID_NUM) ? chainTable(CHAIN_ID_NUM).rpcDefault : "https://mainnet.base.org"),
  /**
   * Base Sepolia's cbZEC and AERO are deploy-time doubles (DeploySepolia's MockB20 / MockERC20):
   * required there, by name; refused on mainnet, where both are pinned.
   */
  cbzecAddress: process.env.NEXT_PUBLIC_CBZEC_ADDRESS ?? "",
  aeroAddress: process.env.NEXT_PUBLIC_AERO_ADDRESS ?? "",
  /** Yield service (services/yield): /v1/gate, /v1/rates, /v1/pools. */
  yieldUrl: process.env.NEXT_PUBLIC_YIELD_URL ?? "http://localhost:8787",
  /** Indexer cache for the dashboard (the yield service's account view). Chain is the authority. */
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? process.env.NEXT_PUBLIC_YIELD_URL ?? "http://localhost:8787",
  /**
   * WalletConnect Cloud project id. Required by WalletConnect-based wallets
   * only; injected (EIP-6963) and Coinbase Wallet work without it. The
   * placeholder makes WalletConnect show but fail to pair until a real id is set.
   */
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  /** CoW app code stamped on every order's app-data. */
  cowAppCode: process.env.NEXT_PUBLIC_COW_APP_CODE ?? "oilskin",
  /** Oilskin contracts (from the contracts engineer's deploy). Unset = writes disabled, reads skipped. Registry, venues, engine are READ from the router. */
  oilskinFactory: process.env.NEXT_PUBLIC_OILSKIN_FACTORY ?? "",
  oilskinRouter: process.env.NEXT_PUBLIC_OILSKIN_ROUTER ?? "",
  /** Oilskin keeper address (optional): enables the revocable protection grant step. Everything else is read from the router. */
  oilskinKeeper: process.env.NEXT_PUBLIC_OILSKIN_KEEPER ?? "",
  /** Force demo mode regardless of wallet state (used by e2e). */
  forceDemo: process.env.NEXT_PUBLIC_FORCE_DEMO === "1",
  /** Registers wagmi's test-only mock connector (used by e2e to exercise the connected wallet pill). Never on in production. */
  mockWallet: process.env.NEXT_PUBLIC_E2E_MOCK_WALLET === "1",
} as const;

export function contractsConfigured(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(ENV.oilskinFactory) && /^0x[0-9a-fA-F]{40}$/.test(ENV.oilskinRouter);
}
