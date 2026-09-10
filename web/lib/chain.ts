/**
 * The chain this build runs on, selected by NEXT_PUBLIC_CHAIN_ID (slice 6, 2026-09-10). Every
 * address the web reads or signs against comes from HERE — never from the mainnet constants in
 * @zyo/shared directly — so a build pointed at Base Sepolia can never silently read the mainnet
 * Aave pool or feeds (audit wave 2, S-MED-1). An unsupported chain, or a Sepolia build missing the
 * deploy-time doubles (cbZEC / AERO), fails at module load with a NAMED error rather than
 * rendering "No debt" against the wrong chain.
 *
 * The names re-exported below are the ones the app used to import from @zyo/shared; on 8453 they
 * are the very same objects. Policy constants (fees, the ladder, presets, curated pools) stay on
 * @zyo/shared — they are not addresses.
 */
import { base, baseSepolia } from "viem/chains";
import {
  chainTable,
  collateralAssetsFor,
  resolveTokens,
  type ChainTable,
  type CollateralAsset,
  type CollateralSymbol,
  type TokenInfo,
  type TokenSymbol,
} from "@zyo/shared";
import { ENV } from "./env";

export interface ChainEnv {
  chainId: number;
  cbzecAddress: string;
  aeroAddress: string;
}

export interface ChainConfig {
  chain: ChainTable;
  chainId: ChainTable["id"];
  tokens: Readonly<Record<TokenSymbol, TokenInfo>>;
  collateral: Readonly<Record<CollateralSymbol, CollateralAsset>>;
  aave: ChainTable["aave"];
  permit2: `0x${string}`;
  /** What `BASE_CHAIN` used to be: id, name, explorer for links. */
  display: { id: ChainTable["id"]; name: string; nativeCurrency: { name: string; symbol: string; decimals: number }; explorerUrl: string };
  viemChain: typeof base | typeof baseSepolia;
  /** CoW Protocol's SDK and settlement are Base mainnet only. */
  cowSupported: boolean;
}

/**
 * Pure: the whole chain-dependent configuration from three env values. Throws
 * `UnsupportedChainError` for a chain without a table, `MissingChainAddressError` (naming the
 * NEXT_PUBLIC_* variable) for a Sepolia double that was not supplied, `PinnedChainAddressError`
 * for an override of a pinned mainnet token.
 */
export function buildChainConfig(env: ChainEnv): ChainConfig {
  const chain = chainTable(env.chainId);
  const tokens = resolveTokens(chain, { cbZEC: env.cbzecAddress, AERO: env.aeroAddress }, (symbol) => `NEXT_PUBLIC_${symbol.toUpperCase()}_ADDRESS`);
  const collateral = collateralAssetsFor(chain, tokens);
  return {
    chain,
    chainId: chain.id,
    tokens,
    collateral,
    aave: chain.aave,
    permit2: chain.permit2,
    display: { id: chain.id, name: chain.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, explorerUrl: chain.explorerUrl },
    viemChain: chain.id === baseSepolia.id ? baseSepolia : base,
    cowSupported: chain.id === base.id,
  };
}

const CFG = buildChainConfig(ENV);

export const CHAIN = CFG.chain;
export const CHAIN_ID = CFG.chainId;
export const BASE_TOKENS = CFG.tokens;
export const COLLATERAL_ASSETS = CFG.collateral;
export const AAVE_V3 = CFG.aave;
export const PERMIT2 = CFG.permit2;
export const BASE_CHAIN = CFG.display;
export const CBZEC_ADDRESS = CFG.tokens.cbZEC.address;
export const VIEM_CHAIN = CFG.viemChain;
export const COW_SUPPORTED = CFG.cowSupported;
