/**
 * Byte layouts, PDAs and instruction encoders for the Solana keeper — the twin of `abi/oilskin.ts`.
 *
 * Every discriminator here is pinned to `solana/idl/oilskin.json` by `scripts/verify-solana-idl.mjs` (the
 * seam runs inside `npm test`); every Kamino offset is the one `solana/programs/oilskin/src/kamino.rs` uses,
 * byte-verified against a live mainnet obligation and reserve on 2026-09-12; every address comes from
 * `@zyo/shared`. Nothing is typed from memory.
 */
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { KAMINO_ZCASH_MARKET, KLEND_SEEDS, SOLANA_PROGRAMS, SOLANA_TOKENS } from "@zyo/shared";

export const SF_ONE = 1n << 60n;

// ---------------------------------------------------------------- discriminators (solana/idl/oilskin.json)

export const OILSKIN_IX = {
  keeperProtect: Uint8Array.from([247, 39, 31, 102, 241, 154, 82, 177]),
} as const;
export const OILSKIN_ACCOUNT = {
  userAccount: Uint8Array.from([211, 33, 136, 16, 186, 110, 242, 127]),
  grant: Uint8Array.from([161, 166, 11, 205, 204, 135, 205, 54]),
} as const;
/** klend IDL 1.25.0 (`sha256("global:<name>")[..8]`, the same bytes the program CPIs with). */
export const KLEND_IX = {
  refreshReserve: Uint8Array.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refreshObligation: Uint8Array.from([33, 132, 147, 228, 151, 192, 72, 89]),
} as const;
/** Anchor account discriminators klend-sdk 12.0.0 ships. */
export const KLEND_ACCOUNT = {
  obligation: Uint8Array.from([168, 206, 141, 106, 88, 76, 172, 167]),
  reserve: Uint8Array.from([43, 242, 204, 202, 26, 247, 59, 127]),
} as const;
/** klend `PriceStatusFlags::ALL_CHECKS`. */
export const PRICE_STATUS_ALL_CHECKS = 0b0011_1111;

/** The program's error table (code → name), pinned to solana/idl/oilskin.json by scripts/verify-solana-idl.mjs. */
export const OILSKIN_ERRORS: readonly { code: number; name: string }[] = [
  { code: 6000, name: "NotOwner" },
  { code: 6002, name: "EntryHfTooLow" },
  { code: 6004, name: "ExitHfTooLow" },
  { code: 6005, name: "ObligationStale" },
  { code: 6006, name: "PriceNotChecked" },
  { code: 6011, name: "InvalidGrant" },
  { code: 6012, name: "GrantNotLive" },
  { code: 6013, name: "RungNotAllowed" },
  { code: 6014, name: "RungIsNotifyOnly" },
  { code: 6015, name: "UnknownRung" },
  { code: 6016, name: "RungNotCrossed" },
  { code: 6017, name: "RungUnderstated" },
  { code: 6018, name: "RepayBudgetExceeded" },
  { code: 6019, name: "SellBudgetExceeded" },
  { code: 6020, name: "ProtectionIneffective" },
  { code: 6021, name: "SaleBelowFloor" },
  { code: 6024, name: "InsufficientUsdcToClose" },
];

// ---------------------------------------------------------------- addresses (shared)

export const PK = {
  klend: new PublicKey(SOLANA_PROGRAMS.klend),
  scope: new PublicKey(SOLANA_PROGRAMS.scope),
  farms: new PublicKey(SOLANA_PROGRAMS.farms),
  tokenProgram: new PublicKey(SOLANA_PROGRAMS.splToken),
  associatedToken: new PublicKey(SOLANA_PROGRAMS.associatedToken),
  market: new PublicKey(KAMINO_ZCASH_MARKET.lendingMarket),
  scopePrices: new PublicKey(KAMINO_ZCASH_MARKET.scopeOraclePrices),
  zecMint: new PublicKey(SOLANA_TOKENS.ZEC.mint),
  usdcMint: new PublicKey(SOLANA_TOKENS.USDC.mint),
  zecReserve: new PublicKey(KAMINO_ZCASH_MARKET.reserves.ZEC.address),
  usdcReserve: new PublicKey(KAMINO_ZCASH_MARKET.reserves.USDC.address),
  zecLiquiditySupply: new PublicKey(KAMINO_ZCASH_MARKET.reserves.ZEC.liquiditySupplyVault),
  zecCollateralMint: new PublicKey(KAMINO_ZCASH_MARKET.reserves.ZEC.collateralMint),
  zecCollateralSupply: new PublicKey(KAMINO_ZCASH_MARKET.reserves.ZEC.collateralSupplyVault),
  usdcLiquiditySupply: new PublicKey(KAMINO_ZCASH_MARKET.reserves.USDC.liquiditySupplyVault),
  usdcFeeVault: new PublicKey(KAMINO_ZCASH_MARKET.reserves.USDC.liquidityFeeVault),
} as const;
export const ZEC_SCOPE_INDEX = KAMINO_ZCASH_MARKET.reserves.ZEC.scopePriceChain[0];
export const ZEC_TWAP_INDEX = KAMINO_ZCASH_MARKET.reserves.ZEC.scopeTwapChain[0];
export const USDC_SCOPE_INDEX = KAMINO_ZCASH_MARKET.reserves.USDC.scopePriceChain[0];
export const ZEC_DECIMALS = SOLANA_TOKENS.ZEC.decimals;
export const USDC_DECIMALS = SOLANA_TOKENS.USDC.decimals;

// ---------------------------------------------------------------- PDAs

export function accountPda(program: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("account"), owner.toBuffer()], program)[0];
}
export function grantPda(program: PublicKey, account: PublicKey, keeper: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("grant"), account.toBuffer(), keeper.toBuffer()], program)[0];
}
export function obligationPda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), account.toBuffer(), PK.market.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    PK.klend
  )[0];
}
export function lendingMarketAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(KLEND_SEEDS.lendingMarketAuthority), PK.market.toBuffer()], PK.klend)[0];
}
export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), PK.tokenProgram.toBuffer(), mint.toBuffer()], PK.associatedToken)[0];
}

// ---------------------------------------------------------------- decoders

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const hasDisc = (b: Buffer, d: Uint8Array) => b.length >= 8 && Buffer.from(d).equals(b.subarray(0, 8));

export interface UserAccountView {
  owner: PublicKey;
  bump: number;
  version: number;
  grantEpoch: bigint;
  obligation: PublicKey;
  createdSlot: bigint;
  /**
   * The health factor recorded at the last `borrow`, in bps (D7 / SOLANA-ARCHITECTURE §14.1–14.2) — the
   * ladder this account runs on derives from it (`ladderBpsFor`); 0n = no record, the floor's ladder.
   */
  entryHfBps: bigint;
  /** The user's Base `OilskinAccount` left-padded to 32 bytes (§14.1); all zero = not linked. */
  baseAccount: Uint8Array;
}
/** 8 + owner 32 + bump 1 + version 1 + grant_epoch 8 + obligation 32 + created_slot 8 + entry_hf_bps 8 + base_account 32 + reserved 24. */
export const USER_ACCOUNT_LEN = 8 + 32 + 1 + 1 + 8 + 32 + 8 + 8 + 32 + 24;
export function decodeUserAccount(b: Buffer): UserAccountView {
  if (b.length !== USER_ACCOUNT_LEN || !hasDisc(b, OILSKIN_ACCOUNT.userAccount)) throw new Error(`not a UserAccount (${b.length} bytes)`);
  return {
    owner: pk(b, 8),
    bump: b[40],
    version: b[41],
    grantEpoch: u64(b, 42),
    obligation: pk(b, 50),
    createdSlot: u64(b, 82),
    entryHfBps: u64(b, 90),
    baseAccount: Uint8Array.from(b.subarray(98, 130)),
  };
}

export interface GrantView {
  account: PublicKey;
  keeper: PublicKey;
  version: number;
  epoch: bigint;
  expiryTs: bigint;
  periodSecs: bigint;
  periodStartTs: bigint;
  repayUsdcPerPeriod: bigint;
  repayUsdcSpent: bigint;
  sellZecPerPeriod: bigint;
  sellZecSpent: bigint;
  maxSellSlippageBps: number;
  allowedRungs: number;
}
export const GRANT_LEN = 8 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 32;
export function decodeGrant(b: Buffer): GrantView {
  if (b.length !== GRANT_LEN || !hasDisc(b, OILSKIN_ACCOUNT.grant)) throw new Error(`not a Grant (${b.length} bytes)`);
  let o = 8;
  const account = pk(b, o); o += 32;
  const keeper = pk(b, o); o += 32;
  o += 1; // bump
  const version = b[o]; o += 1;
  const epoch = u64(b, o); o += 8;
  const expiryTs = b.readBigInt64LE(o); o += 8;
  const periodSecs = u64(b, o); o += 8;
  const periodStartTs = b.readBigInt64LE(o); o += 8;
  const repayUsdcPerPeriod = u64(b, o); o += 8;
  const repayUsdcSpent = u64(b, o); o += 8;
  const sellZecPerPeriod = u64(b, o); o += 8;
  const sellZecSpent = u64(b, o); o += 8;
  const maxSellSlippageBps = b.readUInt16LE(o); o += 2;
  const allowedRungs = b[o];
  return { account, keeper, version, epoch, expiryTs, periodSecs, periodStartTs, repayUsdcPerPeriod, repayUsdcSpent, sellZecPerPeriod, sellZecSpent, maxSellSlippageBps, allowedRungs };
}

/** The grant as the program sees it at `nowS`: live?, and what is left this period (after the roll it would apply). */
export function grantRemaining(g: GrantView, accountEpoch: bigint, nowS: bigint): { live: boolean; repayLeft: bigint; sellLeft: bigint; rolled: boolean } {
  const live = g.expiryTs !== 0n && g.epoch === accountEpoch && nowS < g.expiryTs;
  const rolled = nowS >= g.periodStartTs + g.periodSecs;
  const repaySpent = rolled ? 0n : g.repayUsdcSpent;
  const sellSpent = rolled ? 0n : g.sellZecSpent;
  return { live, rolled, repayLeft: g.repayUsdcPerPeriod > repaySpent ? g.repayUsdcPerPeriod - repaySpent : 0n, sellLeft: g.sellZecPerPeriod > sellSpent ? g.sellZecPerPeriod - sellSpent : 0n };
}

export interface ObligationView {
  slot: bigint;
  stale: boolean;
  priceStatus: number;
  owner: PublicKey;
  lendingMarket: PublicKey;
  depositReserves: PublicKey[];
  borrowReserves: PublicKey[];
  zecDepositedCtokens: bigint;
  usdcBorrowedAmountSf: bigint;
  depositedValueSf: bigint;
  borrowFactorAdjustedDebtValueSf: bigint;
  borrowedAssetsMarketValueSf: bigint;
  allowedBorrowValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  hasDebt: boolean;
}
export const OBLIGATION_LEN = 3344;
export function decodeObligation(b: Buffer): ObligationView {
  if (b.length !== OBLIGATION_LEN || !hasDisc(b, KLEND_ACCOUNT.obligation)) throw new Error(`not an Obligation (${b.length} bytes)`);
  const depositReserves: PublicKey[] = [];
  let zecDepositedCtokens = 0n;
  for (let i = 0; i < 8; i++) {
    const base = 96 + i * 136;
    const r = pk(b, base);
    if (r.equals(PublicKey.default)) continue;
    depositReserves.push(r);
    if (r.equals(PK.zecReserve)) zecDepositedCtokens = u64(b, base + 32);
  }
  const borrowReserves: PublicKey[] = [];
  let usdcBorrowedAmountSf = 0n;
  for (let i = 0; i < 5; i++) {
    const base = 1208 + i * 200;
    const r = pk(b, base);
    if (r.equals(PublicKey.default)) continue;
    borrowReserves.push(r);
    if (r.equals(PK.usdcReserve)) usdcBorrowedAmountSf = u128(b, base + 88);
  }
  return {
    slot: u64(b, 16),
    stale: b[24] !== 0,
    priceStatus: b[25],
    owner: pk(b, 64),
    lendingMarket: pk(b, 32),
    depositReserves,
    borrowReserves,
    zecDepositedCtokens,
    usdcBorrowedAmountSf,
    depositedValueSf: u128(b, 1192),
    borrowFactorAdjustedDebtValueSf: u128(b, 2208),
    borrowedAssetsMarketValueSf: u128(b, 2224),
    allowedBorrowValueSf: u128(b, 2240),
    unhealthyBorrowValueSf: u128(b, 2256),
    hasDebt: b[2287] !== 0,
  };
}

export interface ReserveView {
  slot: bigint;
  stale: boolean;
  priceStatus: number;
  status: number;
  loanToValuePct: number;
  liquidationThresholdPct: number;
  borrowFactorPct: bigint;
  liquidityMint: PublicKey;
  liquidityAvailable: bigint;
  liquidityBorrowedSf: bigint;
  marketPriceSf: bigint;
  mintDecimals: number;
  collateralTotalSupply: bigint;
  maxAgePriceSeconds: bigint;
  scopePriceFeed: PublicKey;
  scopePriceChain0: number;
}
export const RESERVE_LEN = 8624;
export function decodeReserve(b: Buffer): ReserveView {
  if (b.length !== RESERVE_LEN || !hasDisc(b, KLEND_ACCOUNT.reserve)) throw new Error(`not a Reserve (${b.length} bytes)`);
  return {
    slot: u64(b, 16),
    stale: b[24] !== 0,
    priceStatus: b[25],
    status: b[4856],
    loanToValuePct: b[4872],
    liquidationThresholdPct: b[4873],
    borrowFactorPct: u64(b, 5008),
    liquidityMint: pk(b, 128),
    liquidityAvailable: u64(b, 224),
    liquidityBorrowedSf: u128(b, 232),
    marketPriceSf: u128(b, 248),
    mintDecimals: Number(u64(b, 272)),
    collateralTotalSupply: u64(b, 2592),
    maxAgePriceSeconds: u64(b, 5096),
    scopePriceFeed: pk(b, 5112),
    scopePriceChain0: b.readUInt16LE(5144),
  };
}

/** ZEC liquidity (base units) that `ctokens` of the ZEC reserve redeem for, at the reserve's exchange rate. */
export function ctokensToLiquidity(ctokens: bigint, r: ReserveView): bigint {
  const total = r.liquidityAvailable + r.liquidityBorrowedSf / SF_ONE;
  if (total === 0n || r.collateralTotalSupply === 0n) return ctokens;
  return (ctokens * total) / r.collateralTotalSupply;
}

export interface ScopeEntry {
  index: number;
  value: bigint;
  exp: number;
  lastUpdatedSlot: bigint;
  unixTimestamp: bigint;
  priceUsd: number;
}
export const SCOPE_PRICES_LEN = 28712;
export function decodeScopeEntry(b: Buffer, index: number): ScopeEntry {
  if (b.length !== SCOPE_PRICES_LEN) throw new Error(`not an OraclePrices (${b.length} bytes)`);
  const o = 40 + index * 56;
  const value = u64(b, o);
  const exp = Number(u64(b, o + 8));
  return { index, value, exp, lastUpdatedSlot: u64(b, o + 16), unixTimestamp: u64(b, o + 24), priceUsd: Number(value) / 10 ** exp };
}

// ---------------------------------------------------------------- instruction encoders

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const none = () => ro(PK.klend);
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

export function ixRefreshReserve(reserve: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PK.klend,
    keys: [w(reserve), ro(PK.market), none(), none(), none(), ro(PK.scopePrices)],
    data: Buffer.from(KLEND_IX.refreshReserve),
  });
}
export function ixRefreshObligation(obligation: PublicKey, reserves: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: PK.klend,
    keys: [ro(PK.market), w(obligation), ...reserves.map((r) => w(r))],
    data: Buffer.from(KLEND_IX.refreshObligation),
  });
}

/** Account order of `keeper_protect`, exactly as the IDL lists it (verified by scripts/verify-solana-idl.mjs). */
export const KEEPER_PROTECT_ACCOUNT_ORDER = [
  "keeper", "account", "grant", "obligation", "account_zec", "account_usdc",
  "kamino.klend_program", "kamino.lending_market", "kamino.lending_market_authority", "kamino.zec_reserve", "kamino.usdc_reserve",
  "kamino.zec_mint", "kamino.usdc_mint", "kamino.zec_liquidity_supply", "kamino.zec_collateral_mint", "kamino.zec_collateral_supply",
  "kamino.usdc_liquidity_supply", "kamino.usdc_fee_vault", "kamino.scope_prices", "kamino.farms_program", "kamino.instructions_sysvar",
  "kamino.token_program", "token_program",
] as const;

export interface KeeperProtectKeys {
  program: PublicKey;
  keeper: PublicKey;
  account: PublicKey;
  grant: PublicKey;
  obligation: PublicKey;
  accountZec: PublicKey;
  accountUsdc: PublicKey;
}
export function ixKeeperProtect(k: KeeperProtectKeys, rungId: number, repayUsdc: bigint, sellZec: bigint): TransactionInstruction {
  const data = Buffer.concat([Buffer.from(OILSKIN_IX.keeperProtect), Buffer.from([rungId]), u64le(repayUsdc), u64le(sellZec)]);
  return new TransactionInstruction({
    programId: k.program,
    keys: [
      ro(k.keeper, true),
      w(k.account),
      w(k.grant),
      w(k.obligation),
      w(k.accountZec),
      w(k.accountUsdc),
      ro(PK.klend),
      ro(PK.market),
      ro(lendingMarketAuthority()),
      w(PK.zecReserve),
      w(PK.usdcReserve),
      ro(PK.zecMint),
      ro(PK.usdcMint),
      w(PK.zecLiquiditySupply),
      w(PK.zecCollateralMint),
      w(PK.zecCollateralSupply),
      w(PK.usdcLiquiditySupply),
      w(PK.usdcFeeVault),
      ro(PK.scopePrices),
      ro(PK.farms),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ro(PK.tokenProgram),
      ro(PK.tokenProgram),
    ],
    data,
  });
}

/** SPL Token `Transfer` (instruction 3): source → destination, signed by `authority` (owner or delegate). */
export function ixSplTransfer(source: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PK.tokenProgram,
    keys: [w(source), w(destination), ro(authority, true)],
    data: Buffer.concat([Buffer.from([3]), u64le(amount)]),
  });
}

/** Decode the anchor error name out of a simulation/transaction log, or null. */
export function anchorErrorName(logs: readonly string[] | null | undefined, idlErrors: readonly { code: number; name: string }[]): string | null {
  if (!logs) return null;
  for (const l of logs) {
    const m = /Error Code: ([A-Za-z0-9_]+)\./.exec(l) ?? /custom program error: 0x([0-9a-f]+)/i.exec(l);
    if (!m) continue;
    if (m[0].startsWith("Error Code")) return m[1];
    const code = parseInt(m[1], 16);
    const e = idlErrors.find((x) => x.code === code);
    if (e) return e.name;
  }
  return null;
}
