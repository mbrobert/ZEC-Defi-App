/**
 * Chain reads for the Solana surfaces: the user's Oilskin Account, its Kamino obligation, its token accounts and
 * the keeper's grant — decoded at the byte offsets the keeper uses (agent/src/solana/layouts.ts; verified against
 * klend-sdk 12.0.0 and a mainnet capture, VERIFIED-SOLANA-FACTS.md Addendum 2). No Buffer: DataView on Uint8Array.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { accountPda, ata, grantPda, obligationPda, PK } from "./addresses";
import { OILSKIN_SOLANA_IDL } from "./idl.generated";

export const USER_ACCOUNT_LEN = 154;
export const GRANT_LEN = 165;
export const OBLIGATION_LEN = 3344;
export const RESERVE_LEN = 8624;
export const TOKEN_ACCOUNT_LEN = 165;
export const SF_ONE = 1n << 60n;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const u64 = (b: Uint8Array, o: number): bigint => view(b).getBigUint64(o, true);
export const i64 = (b: Uint8Array, o: number): bigint => view(b).getBigInt64(o, true);
export const u128 = (b: Uint8Array, o: number): bigint => u64(b, o) + (u64(b, o + 8) << 64n);
const pubkeyAt = (b: Uint8Array, o: number): PublicKey => new PublicKey(b.subarray(o, o + 32));
const hasDisc = (b: Uint8Array, d: readonly number[]): boolean => d.every((x, i) => b[i] === x);

export class SolanaDecodeError extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: ${detail}`);
    this.name = "SolanaDecodeError";
  }
}

export interface UserAccountView {
  owner: PublicKey;
  bump: number;
  version: number;
  grantEpoch: bigint;
  obligation: PublicKey;
  createdSlot: bigint;
}
export function decodeUserAccount(b: Uint8Array): UserAccountView {
  if (b.length !== USER_ACCOUNT_LEN || !hasDisc(b, OILSKIN_SOLANA_IDL.accounts.UserAccount)) throw new SolanaDecodeError("UserAccount", `${b.length} bytes or wrong discriminator`);
  return { owner: pubkeyAt(b, 8), bump: b[40], version: b[41], grantEpoch: u64(b, 42), obligation: pubkeyAt(b, 50), createdSlot: u64(b, 82) };
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
export function decodeGrant(b: Uint8Array): GrantView {
  if (b.length !== GRANT_LEN || !hasDisc(b, OILSKIN_SOLANA_IDL.accounts.Grant)) throw new SolanaDecodeError("Grant", `${b.length} bytes or wrong discriminator`);
  let o = 8;
  const account = pubkeyAt(b, o);
  o += 32;
  const keeper = pubkeyAt(b, o);
  o += 32;
  o += 1; // bump
  const version = b[o];
  o += 1;
  const epoch = u64(b, o);
  o += 8;
  const expiryTs = i64(b, o);
  o += 8;
  const periodSecs = u64(b, o);
  o += 8;
  const periodStartTs = i64(b, o);
  o += 8;
  const repayUsdcPerPeriod = u64(b, o);
  o += 8;
  const repayUsdcSpent = u64(b, o);
  o += 8;
  const sellZecPerPeriod = u64(b, o);
  o += 8;
  const sellZecSpent = u64(b, o);
  o += 8;
  const maxSellSlippageBps = view(b).getUint16(o, true);
  o += 2;
  const allowedRungs = b[o];
  return { account, keeper, version, epoch, expiryTs, periodSecs, periodStartTs, repayUsdcPerPeriod, repayUsdcSpent, sellZecPerPeriod, sellZecSpent, maxSellSlippageBps, allowedRungs };
}
/** What is left in the grant's current period; `live` needs the epoch the Account carries and a chain time. */
export function grantRemaining(g: GrantView, accountEpoch: bigint, nowS: bigint): { live: boolean; repayLeft: bigint; sellLeft: bigint; rolled: boolean } {
  const live = g.expiryTs !== 0n && g.epoch === accountEpoch && nowS < g.expiryTs;
  const rolled = nowS >= g.periodStartTs + g.periodSecs;
  const repaySpent = rolled ? 0n : g.repayUsdcSpent;
  const sellSpent = rolled ? 0n : g.sellZecSpent;
  return { live, rolled, repayLeft: g.repayUsdcPerPeriod > repaySpent ? g.repayUsdcPerPeriod - repaySpent : 0n, sellLeft: g.sellZecPerPeriod > sellSpent ? g.sellZecPerPeriod - sellSpent : 0n };
}

/** klend `Obligation`: the ZEC deposit (cTokens) and the USDC debt, plus the health numbers the last refresh cached. */
export interface ObligationView {
  slot: bigint;
  stale: boolean;
  owner: PublicKey;
  zecDepositedCtokens: bigint;
  usdcBorrowedUnits: bigint;
  depositedValueSf: bigint;
  borrowFactorAdjustedDebtValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  hasDebt: boolean;
  /** unhealthy ÷ adjusted debt as cached at `slot`; null without debt. */
  cachedHf: number | null;
}
const OBLIGATION_DISC = [168, 206, 141, 106, 88, 76, 172, 167]; // sha256("account:Obligation")[..8], asserted by test/solana-reads.test.ts
export function decodeObligation(b: Uint8Array): ObligationView {
  if (b.length !== OBLIGATION_LEN || !hasDisc(b, OBLIGATION_DISC)) throw new SolanaDecodeError("Obligation", `${b.length} bytes or wrong discriminator`);
  let zecDepositedCtokens = 0n;
  for (let i = 0; i < 8; i++) {
    const base = 96 + i * 136;
    if (pubkeyAt(b, base).equals(PK.zecReserve)) zecDepositedCtokens = u64(b, base + 32);
  }
  let usdcBorrowedSf = 0n;
  for (let i = 0; i < 5; i++) {
    const base = 1208 + i * 200;
    if (pubkeyAt(b, base).equals(PK.usdcReserve)) usdcBorrowedSf = u128(b, base + 88);
  }
  const bfDebt = u128(b, 2208);
  const unhealthy = u128(b, 2256);
  return {
    slot: u64(b, 16),
    stale: b[24] !== 0,
    owner: pubkeyAt(b, 64),
    zecDepositedCtokens,
    usdcBorrowedUnits: usdcBorrowedSf / SF_ONE,
    depositedValueSf: u128(b, 1192),
    borrowFactorAdjustedDebtValueSf: bfDebt,
    unhealthyBorrowValueSf: unhealthy,
    hasDebt: b[2287] !== 0,
    cachedHf: bfDebt === 0n ? null : Number((unhealthy * 10_000n) / bfDebt) / 10_000,
  };
}

/** The ZEC reserve's cToken exchange rate inputs (offsets: available 224, borrowedSf 232, cToken supply 2592). */
export interface ReserveExchange {
  availableUnits: bigint;
  borrowedUnits: bigint;
  collateralTotalSupply: bigint;
}
export function decodeReserveExchange(b: Uint8Array): ReserveExchange {
  if (b.length !== RESERVE_LEN) throw new SolanaDecodeError("Reserve", `${b.length} bytes`);
  return { availableUnits: u64(b, 224), borrowedUnits: u128(b, 232) / SF_ONE, collateralTotalSupply: u64(b, 2592) };
}
export function ctokensToLiquidity(ctokens: bigint, r: ReserveExchange): bigint {
  const total = r.availableUnits + r.borrowedUnits;
  if (total === 0n || r.collateralTotalSupply === 0n) return ctokens;
  return (ctokens * total) / r.collateralTotalSupply;
}

/** SPL Token account: amount at 64, delegate Option<Pubkey> at 72 (u32 tag + 32), delegatedAmount at 121. */
export interface TokenAccountView {
  amount: bigint;
  delegate: PublicKey | null;
  delegatedAmount: bigint;
}
export function decodeTokenAccount(b: Uint8Array | null | undefined): TokenAccountView {
  if (!b || b.length < TOKEN_ACCOUNT_LEN) return { amount: 0n, delegate: null, delegatedAmount: 0n };
  const hasDelegate = view(b).getUint32(72, true) === 1;
  return { amount: u64(b, 64), delegate: hasDelegate ? pubkeyAt(b, 76) : null, delegatedAmount: u64(b, 121) };
}

export interface SolanaPosition {
  owner: PublicKey;
  account: PublicKey;
  exists: boolean;
  user: UserAccountView | null;
  obligation: ObligationView | null;
  /** ZEC the obligation holds, in liquidity units (cTokens × the reserve's exchange rate). */
  collateralZecUnits: bigint;
  debtUsdcUnits: bigint;
  accountZec: TokenAccountView;
  accountUsdc: TokenAccountView;
  walletZec: TokenAccountView;
  walletUsdc: TokenAccountView;
  grant: GrantView | null;
  readSlot: number;
}

/** One `getMultipleAccountsInfo` for everything the position page and the wizard need to know about `owner`. */
export async function readSolanaPosition(conn: Connection, programId: PublicKey, owner: PublicKey, keeper: PublicKey | null): Promise<SolanaPosition> {
  const account = accountPda(programId, owner);
  const obligation = obligationPda(account);
  const keys = [account, obligation, ata(account, PK.zecMint), ata(account, PK.usdcMint), ata(owner, PK.zecMint), ata(owner, PK.usdcMint), PK.zecReserve, ...(keeper ? [grantPda(programId, account, keeper)] : [])];
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const [acct, ob, aZec, aUsdc, wZec, wUsdc, reserve, grant] = value;
  const user = acct && acct.owner.equals(programId) ? decodeUserAccount(acct.data) : null;
  const obligationView = ob && ob.owner.equals(PK.klend) ? decodeObligation(ob.data) : null;
  if (obligationView && !obligationView.owner.equals(account)) throw new SolanaDecodeError("Obligation", "not owned by the Account PDA");
  const exchange = reserve && reserve.owner.equals(PK.klend) ? decodeReserveExchange(reserve.data) : null;
  const collateralZecUnits = obligationView && exchange ? ctokensToLiquidity(obligationView.zecDepositedCtokens, exchange) : (obligationView?.zecDepositedCtokens ?? 0n);
  return {
    owner,
    account,
    exists: user !== null,
    user,
    obligation: obligationView,
    collateralZecUnits,
    debtUsdcUnits: obligationView?.usdcBorrowedUnits ?? 0n,
    accountZec: decodeTokenAccount(aZec?.data),
    accountUsdc: decodeTokenAccount(aUsdc?.data),
    walletZec: decodeTokenAccount(wZec?.data),
    walletUsdc: decodeTokenAccount(wUsdc?.data),
    grant: grant && grant.owner.equals(programId) ? decodeGrant(grant.data) : null,
    readSlot: context.slot,
  };
}
