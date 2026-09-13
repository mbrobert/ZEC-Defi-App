/**
 * Hand-encoded Oilskin program instructions, pinned to the committed IDL (lib/solana/idl.generated.ts →
 * test/solana-idl.test.ts): discriminators from the IDL, accounts in the IDL's order with its flags, arguments
 * as anchor's borsh (little-endian integers, a 32-byte pubkey). No anchor client in the browser bundle.
 */
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { OILSKIN_SOLANA_IDL } from "./idl.generated";
import { ata, lendingMarketAuthority, obligationPda, PK, userMetadataPda } from "./addresses";

type IxName = keyof typeof OILSKIN_SOLANA_IDL.instructions;

const disc = (name: IxName): Buffer => Buffer.from(OILSKIN_SOLANA_IDL.instructions[name].discriminator);
export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
export function i64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
}
export function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}
/** Concatenates into the Buffer web3.js types instruction data as (the `buffer` package, browser-safe). */
export function concat(...parts: Uint8Array[]): Buffer {
  const out = Buffer.alloc(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

/** The `kamino` composite every Kamino-touching instruction carries, in IDL order. */
export function kaminoMetas(): AccountMeta[] {
  return [
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
    ro(PK.instructionsSysvar),
    ro(PK.tokenProgram),
  ];
}

export interface AccountKeys {
  program: PublicKey;
  owner: PublicKey;
  account: PublicKey;
}
const derived = (k: AccountKeys) => ({ obligation: obligationPda(k.account), userMetadata: userMetadataPda(k.account), accountZec: ata(k.account, PK.zecMint), accountUsdc: ata(k.account, PK.usdcMint), ownerZec: ata(k.owner, PK.zecMint), ownerUsdc: ata(k.owner, PK.usdcMint) });

export function ixInitAccount(k: AccountKeys): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({
    programId: k.program,
    keys: [w(k.owner, true), w(k.account), ro(PK.zecMint), ro(PK.usdcMint), w(d.accountZec), w(d.accountUsdc), w(d.userMetadata), w(d.obligation), ro(PK.market), ro(PK.klend), ro(PK.rent), ro(PK.systemProgram), ro(PK.tokenProgram), ro(PK.associatedToken)],
    data: disc("init_account"),
  });
}

export function ixDeposit(k: AccountKeys, amountZec: bigint): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({
    programId: k.program,
    keys: [w(k.owner, true), w(k.account), w(d.obligation), ro(d.userMetadata), ro(PK.rent), ro(PK.systemProgram), w(d.ownerZec), w(d.accountZec), ...kaminoMetas(), ro(PK.tokenProgram)],
    data: concat(disc("deposit"), u64le(amountZec)),
  });
}

export function ixBorrow(k: AccountKeys, amountUsdc: bigint): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), w(k.account), w(d.obligation), w(d.accountUsdc), ...kaminoMetas()], data: concat(disc("borrow"), u64le(amountUsdc)) });
}

export function ixRepay(k: AccountKeys, amountUsdc: bigint): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), w(k.account), w(d.obligation), w(d.accountUsdc), ...kaminoMetas()], data: concat(disc("repay"), u64le(amountUsdc)) });
}

export function ixWithdraw(k: AccountKeys, collateralAmount: bigint): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), w(k.account), w(d.obligation), w(d.accountZec), ...kaminoMetas()], data: concat(disc("withdraw"), u64le(collateralAmount)) });
}

export function ixClosePosition(k: AccountKeys): TransactionInstruction {
  const d = derived(k);
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), w(k.account), w(d.obligation), w(d.accountZec), w(d.accountUsdc), ...kaminoMetas()], data: disc("close_position") });
}

/** Move `amount` of `mint` from the Account's token account to the owner's wallet (owner-only). */
export function ixTransferOut(k: AccountKeys, mint: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: k.program,
    keys: [w(k.owner, true), ro(k.account), ro(mint), w(ata(k.account, mint)), w(ata(k.owner, mint)), ro(PK.tokenProgram), ro(PK.associatedToken), ro(PK.systemProgram)],
    data: concat(disc("transfer_out"), u64le(amount)),
  });
}

export interface GrantParams {
  expiryTs: bigint;
  periodSecs: bigint;
  repayUsdcPerPeriod: bigint;
  sellZecPerPeriod: bigint;
  maxSellSlippageBps: number;
  allowedRungs: number;
}
/** borsh of `GrantParams` in the IDL's field order (asserted by the seam test). */
export function encodeGrantParams(p: GrantParams): Uint8Array {
  const fields = OILSKIN_SOLANA_IDL.types.GrantParams.map(([name]) => name);
  const enc: Record<string, () => Uint8Array> = {
    expiry_ts: () => i64le(p.expiryTs),
    period_secs: () => u64le(p.periodSecs),
    repay_usdc_per_period: () => u64le(p.repayUsdcPerPeriod),
    sell_zec_per_period: () => u64le(p.sellZecPerPeriod),
    max_sell_slippage_bps: () => u16le(p.maxSellSlippageBps),
    allowed_rungs: () => {
      if (!Number.isInteger(p.allowedRungs) || p.allowedRungs < 0 || p.allowedRungs > 255) throw new RangeError("allowedRungs");
      return new Uint8Array([p.allowedRungs]);
    },
  };
  return concat(...fields.map((f) => (enc[f] ?? (() => { throw new Error(`GrantParams field ${f} has no encoder`); }))()));
}

export function ixGrant(k: AccountKeys, keeper: PublicKey, grant: PublicKey, params: GrantParams): TransactionInstruction {
  return new TransactionInstruction({ programId: k.program, keys: [w(k.owner, true), ro(k.account), w(grant), ro(PK.systemProgram)], data: concat(disc("grant"), keeper.toBytes(), encodeGrantParams(params)) });
}
export function ixRevoke(k: AccountKeys, keeper: PublicKey, grant: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), ro(k.account), w(grant)], data: concat(disc("revoke"), keeper.toBytes()) });
}
export function ixRevokeAll(k: AccountKeys): TransactionInstruction {
  return new TransactionInstruction({ programId: k.program, keys: [ro(k.owner, true), w(k.account)], data: disc("revoke_all") });
}

/** SPL Token `Transfer` (instruction 3): the owner tops up the Account's USDC before a close. */
export function ixSplTransfer(source: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({ programId: PK.tokenProgram, keys: [w(source), w(destination), ro(authority, true)], data: concat(new Uint8Array([3]), u64le(amount)) });
}
/** Associated Token Program `CreateIdempotent` (instruction 1): the owner's own ATA before a withdrawal lands in it. */
export function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PK.associatedToken,
    keys: [w(payer, true), w(ata(owner, mint)), ro(owner), ro(mint), ro(PK.systemProgram), ro(PK.tokenProgram)],
    data: Buffer.from([1]),
  });
}

/** The anchor error name in a failed transaction's logs, or null. */
export function anchorErrorName(logs: readonly string[] | null | undefined): string | null {
  if (!logs) return null;
  for (const l of logs) {
    const byName = /Error Code: ([A-Za-z0-9_]+)\./.exec(l);
    if (byName) return byName[1];
    const byCode = /custom program error: 0x([0-9a-f]+)/i.exec(l);
    if (byCode) {
      const code = parseInt(byCode[1], 16);
      const e = OILSKIN_SOLANA_IDL.errors.find((x) => x.code === code);
      if (e) return e.name;
    }
  }
  return null;
}
