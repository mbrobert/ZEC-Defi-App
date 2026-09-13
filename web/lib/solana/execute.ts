/**
 * Sends the Solana steps: one transaction per step (together they exceed the packet size), each with a compute
 * budget wide enough for Kamino's refreshes, signed by the connected wallet, confirmed at `confirmed`. Every failure
 * is decoded to the program's error name and said in plain words; nothing is retried on the user's behalf.
 */
import { ComputeBudgetProgram, Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { grantPda, PK } from "./addresses";
import { anchorErrorName, ixBorrow, ixClosePosition, ixCreateAtaIdempotent, ixDeposit, ixGrant, ixInitAccount, ixRevokeAll, ixSplTransfer, ixTransferOut, type AccountKeys } from "./instructions";
import { grantParamsFor, openSteps, type SolanaOpenPlan } from "./plan";
import type { SolanaPosition } from "./reads";
import { solanaErrorPlain } from "./copy";

/** The compute budget every Kamino-touching instruction carries on localnet and mainnet alike (the specs' value). */
export const SOLANA_CU_LIMIT = 1_400_000;

export interface SolanaWalletLike {
  publicKey: PublicKey;
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
}
export type SolanaStepEvent =
  | { type: "signing"; step: number }
  | { type: "submitted"; step: number; signature: string }
  | { type: "done"; step: number; signature: string }
  | { type: "failed"; step: number; error: string; errorName: string | null };
export type SolanaEmit = (e: SolanaStepEvent) => void;

export class SolanaStepError extends Error {
  constructor(
    readonly step: number,
    readonly errorName: string | null,
    message: string
  ) {
    super(message);
    this.name = "SolanaStepError";
  }
}

async function logsOf(e: unknown, conn: Connection): Promise<string[] | null> {
  const any = e as { logs?: string[]; getLogs?: (c: Connection) => Promise<string[]> };
  if (Array.isArray(any?.logs)) return any.logs;
  if (typeof any?.getLogs === "function") {
    try {
      return await any.getLogs(conn);
    } catch {
      return null;
    }
  }
  return null;
}

/** Build, sign, send, confirm one step. */
export async function sendStep(conn: Connection, wallet: SolanaWalletLike, ixs: TransactionInstruction[], step: number, emit: SolanaEmit): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: SOLANA_CU_LIMIT }), ...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  emit({ type: "signing", step });
  let signature: string;
  try {
    signature = await wallet.sendTransaction(tx, conn);
  } catch (e) {
    const name = anchorErrorName(await logsOf(e, conn));
    const msg = e instanceof Error && /reject|cancel|denied/i.test(e.message) ? "You declined the transaction in your wallet. Nothing moved." : solanaErrorPlain(name);
    emit({ type: "failed", step, error: msg, errorName: name });
    throw new SolanaStepError(step, name, msg);
  }
  emit({ type: "submitted", step, signature });
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    let name: string | null = null;
    try {
      const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      name = anchorErrorName(t?.meta?.logMessages);
    } catch {
      /* the name stays null; the refusal is still said */
    }
    const msg = solanaErrorPlain(name);
    emit({ type: "failed", step, error: msg, errorName: name });
    throw new SolanaStepError(step, name, msg);
  }
  emit({ type: "done", step, signature });
  return signature;
}

export interface OpenRun {
  conn: Connection;
  wallet: SolanaWalletLike;
  programId: PublicKey;
  account: PublicKey;
  keeper: PublicKey | null;
  plan: SolanaOpenPlan;
  accountExists: boolean;
  /** Chain time for the grant's expiry (the chain clock, not the host's). */
  nowS: number;
  emit: SolanaEmit;
}
/** The open: init (if needed) → deposit → borrow → grant, one prompt each; stops at the first refusal. */
export async function runSolanaOpen(r: OpenRun): Promise<string[]> {
  const k: AccountKeys = { program: r.programId, owner: r.wallet.publicKey, account: r.account };
  const steps = openSteps(r.plan, { accountExists: r.accountExists, keeperConfigured: r.keeper !== null });
  const sigs: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const ixs: TransactionInstruction[] =
      s.id === "init"
        ? [ixInitAccount(k)]
        : s.id === "deposit"
          ? [ixDeposit(k, r.plan.collateralUnits)]
          : s.id === "borrow"
            ? [ixBorrow(k, r.plan.borrowUnits)]
            : [ixGrant(k, r.keeper!, grantPda(r.programId, r.account, r.keeper!), grantParamsFor(r.plan, r.nowS))];
    sigs.push(await sendStep(r.conn, r.wallet, ixs, i, r.emit));
  }
  return sigs;
}

export interface CloseRun {
  conn: Connection;
  wallet: SolanaWalletLike;
  programId: PublicKey;
  position: SolanaPosition;
  emit: SolanaEmit;
}
export type CloseStepId = "topup" | "close" | "transfer_zec" | "transfer_usdc";
/** The exit hatch, planned: top up USDC if the account is short, close (repay all + withdraw all), then move both tokens home. */
export function closeSteps(p: SolanaPosition): { id: CloseStepId; title: string; sentence: string; amount: bigint }[] {
  const steps: { id: CloseStepId; title: string; sentence: string; amount: bigint }[] = [];
  // the debt accrues between the read and the close: top up with a small margin so the close is not refused for a few units
  const margin = p.debtUsdcUnits / 1000n + 1n;
  const short = p.debtUsdcUnits + margin > p.accountUsdc.amount ? p.debtUsdcUnits + margin - p.accountUsdc.amount : 0n;
  if (p.debtUsdcUnits > 0n && short > 0n) steps.push({ id: "topup", title: `Move ${(Number(short) / 1e6).toFixed(2)} USDC into your account`, sentence: `Your account holds ${(Number(p.accountUsdc.amount) / 1e6).toFixed(2)} USDC against ${(Number(p.debtUsdcUnits) / 1e6).toFixed(2)} of debt; this moves the difference, plus 0.1 % for interest accruing meanwhile, from your wallet.`, amount: short });
  if (p.obligation && (p.debtUsdcUnits > 0n || p.collateralZecUnits > 0n)) steps.push({ id: "close", title: "Repay everything and withdraw all ZEC", sentence: "Repays the whole USDC debt from your account and withdraws all your ZEC from Kamino into your account, in one instruction. Kamino closes the emptied position.", amount: 0n });
  const zecAfter = p.accountZec.amount + p.collateralZecUnits;
  if (zecAfter > 0n) steps.push({ id: "transfer_zec", title: "Move your ZEC to your wallet", sentence: `Moves all ZEC in your Oilskin account to your wallet.`, amount: zecAfter });
  const usdcLeft = p.accountUsdc.amount > p.debtUsdcUnits ? p.accountUsdc.amount - p.debtUsdcUnits : 0n;
  steps.push({ id: "transfer_usdc", title: "Move any USDC left to your wallet", sentence: `Moves whatever USDC remains in your Oilskin account (about ${(Number(usdcLeft) / 1e6).toFixed(2)}) to your wallet.`, amount: usdcLeft });
  return steps;
}
export async function runSolanaClose(r: CloseRun): Promise<string[]> {
  const k: AccountKeys = { program: r.programId, owner: r.wallet.publicKey, account: r.position.account };
  const owner = r.wallet.publicKey;
  const steps = closeSteps(r.position);
  const sigs: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    let ixs: TransactionInstruction[];
    switch (s.id) {
      case "topup":
        ixs = [ixSplTransfer(ataOf(owner, PK.usdcMint), ataOf(r.position.account, PK.usdcMint), owner, s.amount)];
        break;
      case "close":
        ixs = [ixClosePosition(k)];
        break;
      case "transfer_zec":
        // the transfer is the whole balance at the time it runs; the amount planned is a lower bound (interest does not touch ZEC)
        ixs = [ixCreateAtaIdempotent(owner, owner, PK.zecMint), ixTransferOut(k, PK.zecMint, s.amount)];
        break;
      case "transfer_usdc":
        ixs = [ixCreateAtaIdempotent(owner, owner, PK.usdcMint), ixTransferOut(k, PK.usdcMint, s.amount)];
        break;
    }
    sigs.push(await sendStep(r.conn, r.wallet, ixs, i, r.emit));
  }
  return sigs;
}
import { ata as ataOf } from "./addresses";

export async function runSolanaRevokeAll(conn: Connection, wallet: SolanaWalletLike, programId: PublicKey, account: PublicKey, emit: SolanaEmit): Promise<string> {
  return sendStep(conn, wallet, [ixRevokeAll({ program: programId, owner: wallet.publicKey, account })], 0, emit);
}
