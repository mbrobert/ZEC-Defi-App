/**
 * Runtime configuration. Everything here is PUBLIC (NEXT_PUBLIC_*): the web
 * app holds no secrets, signs nothing itself, and never broadcasts on the
 * user's behalf — the wallet does.
 */

export const ENV = {
  /** Base JSON-RPC used for reads. Public endpoint by default; override per deploy. */
  baseRpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org",
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
