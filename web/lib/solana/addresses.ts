/**
 * Every Solana address the web touches, from @zyo/shared (read live, VERIFIED-SOLANA-FACTS.md) and the PDAs the
 * program and klend derive. No Buffer: Next's browser bundle has no Node Buffer, so seeds are Uint8Arrays.
 */
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { KAMINO_ZCASH_MARKET, KLEND_SEEDS, SOLANA_PROGRAMS, SOLANA_TOKENS } from "@zyo/shared";

const pk = (s: string) => new PublicKey(s);
const seed = (s: string) => new TextEncoder().encode(s);

export const PK = {
  klend: pk(SOLANA_PROGRAMS.klend),
  scope: pk(SOLANA_PROGRAMS.scope),
  farms: pk(SOLANA_PROGRAMS.farms),
  tokenProgram: pk(SOLANA_PROGRAMS.splToken),
  associatedToken: pk(SOLANA_PROGRAMS.associatedToken),
  systemProgram: SystemProgram.programId,
  rent: SYSVAR_RENT_PUBKEY,
  instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  market: pk(KAMINO_ZCASH_MARKET.lendingMarket),
  scopePrices: pk(KAMINO_ZCASH_MARKET.scopeOraclePrices),
  zecMint: pk(SOLANA_TOKENS.ZEC.mint),
  usdcMint: pk(SOLANA_TOKENS.USDC.mint),
  zecReserve: pk(KAMINO_ZCASH_MARKET.reserves.ZEC.address),
  usdcReserve: pk(KAMINO_ZCASH_MARKET.reserves.USDC.address),
  zecLiquiditySupply: pk(KAMINO_ZCASH_MARKET.reserves.ZEC.liquiditySupplyVault),
  zecCollateralMint: pk(KAMINO_ZCASH_MARKET.reserves.ZEC.collateralMint),
  zecCollateralSupply: pk(KAMINO_ZCASH_MARKET.reserves.ZEC.collateralSupplyVault),
  usdcLiquiditySupply: pk(KAMINO_ZCASH_MARKET.reserves.USDC.liquiditySupplyVault),
  usdcFeeVault: pk(KAMINO_ZCASH_MARKET.reserves.USDC.liquidityFeeVault),
} as const;

export const ZEC_DECIMALS = SOLANA_TOKENS.ZEC.decimals;
export const USDC_DECIMALS = SOLANA_TOKENS.USDC.decimals;

/** The user's Oilskin Account: seeds ["account", owner] under the program. */
export function accountPda(program: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("account"), owner.toBytes()], program)[0];
}
/** A keeper's grant on an Account: seeds ["grant", account, keeper]. */
export function grantPda(program: PublicKey, account: PublicKey, keeper: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("grant"), account.toBytes(), keeper.toBytes()], program)[0];
}
/** klend's obligation PDA for an owner on this market: [tag 0, id 0, owner, market, default, default]. */
export function obligationPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new Uint8Array([0]), new Uint8Array([0]), owner.toBytes(), PK.market.toBytes(), PublicKey.default.toBytes(), PublicKey.default.toBytes()], PK.klend)[0];
}
export function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed(KLEND_SEEDS.userMetadata), owner.toBytes()], PK.klend)[0];
}
export function lendingMarketAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([seed(KLEND_SEEDS.lendingMarketAuthority), PK.market.toBytes()], PK.klend)[0];
}
/** Associated token account (off-curve owners allowed: the Account PDA holds its own ATAs). */
export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), PK.tokenProgram.toBytes(), mint.toBytes()], PK.associatedToken)[0];
}
