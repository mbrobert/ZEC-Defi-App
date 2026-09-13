/**
 * The cross-chain pair (BUILD-PLAN D6 / A5.2; SOLANA-ARCHITECTURE §14.7): a Solana Account whose `base_account`
 * names a Base `OilskinAccount` whose `solanaRecipient` is that Account's USDC token account — mutual, or not a
 * pair. Pure decision here; the reader wraps one `eth_call` on the Base router. Nothing in this module signs.
 */
import { PublicKey } from "@solana/web3.js";
import type { PublicClient } from "viem";
import { strategyRouterAbi } from "../abi/oilskin.js";
import { withDeadline } from "../services/deadline.js";
import type { Address } from "../types/evm.js";
import { PK, ata, type UserAccountView } from "./layouts.js";

export type PairStatus = "linked" | "half-linked-solana" | "half-linked-base" | "unlinked" | "unknown";

export interface PairView {
  /** The Base account the Solana Account recorded (checksummed), or null when unlinked on this side. */
  baseAccount: Address | null;
  /** What the Base router records for that account (bytes32 hex), or null when unread / none. */
  recipientOnBase: `0x${string}` | null;
  /** The Solana Account's USDC token account as bytes32 hex — what the Base side must say. */
  expectedRecipient: `0x${string}`;
  status: PairStatus;
}

const ZERO32 = new Uint8Array(32);
const hex = (b: Uint8Array): `0x${string}` => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
const isZero = (b: Uint8Array) => b.length === 32 && b.every((x) => x === 0);

/** The Base account recorded on a Solana Account, as an address, or null when the field is zero or not an EVM address. */
export function baseAccountOf(view: Pick<UserAccountView, "baseAccount">): Address | null {
  const b = view.baseAccount;
  if (!(b instanceof Uint8Array) || b.length !== 32 || isZero(b)) return null;
  for (let i = 0; i < 12; i++) if (b[i] !== 0) return null;
  return hex(b.subarray(12)) as Address;
}

/** The recipient CCTP mints to on Solana: the Account's USDC associated token account, as bytes32 hex. */
export function expectedRecipientOf(account: PublicKey): `0x${string}` {
  return hex(ata(account, PK.usdcMint).toBytes());
}

/**
 * The pair rule (§14.7): linked only when BOTH sides name each other. `recipientOnBase === null` means the
 * Base side was not read (no router configured or the read failed) → "unknown" when the Solana side is
 * linked, "unlinked" when it is not.
 */
export function pairStatus(baseAccount: Address | null, recipientOnBase: `0x${string}` | null, expectedRecipient: `0x${string}`): PairStatus {
  const baseSaysUs = recipientOnBase !== null && recipientOnBase.toLowerCase() === expectedRecipient.toLowerCase();
  const baseSaysNone = recipientOnBase === null || /^0x0{64}$/.test(recipientOnBase);
  if (baseAccount === null) return baseSaysNone || recipientOnBase === null ? "unlinked" : "half-linked-base";
  if (recipientOnBase === null) return "unknown";
  if (baseSaysUs) return "linked";
  return "half-linked-solana";
}

/**
 * Which way a fired rung goes for an account with this pair view (§14.6–14.7): rung 2 is always the Solana
 * repay from the reserve; rungs 3–4 go over the bridge when the Solana side cannot fix the position from the
 * USDC it already holds, the pair is linked, a Base burner exists and no burn is already in flight (younger
 * than the stall window); otherwise the single-chain path (the reserve, then the keeper-funded sale).
 *
 * `idleCoversNeed` is what makes the five-step sequence terminate: a delivery puts USDC in the Account and
 * moves no health factor, so the rung fires again — and on that firing the idle USDC now covers the need and
 * the route is Solana, which is the repay. Without it the keeper would bridge a second time.
 */
export function bridgeDecision(input: {
  action: string;
  status: PairStatus;
  burnerAvailable: boolean;
  inFlightAgeS: number | null;
  stallS: number;
  /** The Account's idle USDC already reaches the rung's disarm level: nothing has to cross a chain. */
  idleCoversNeed: boolean;
}): { route: "bridge" | "solana" | "wait"; reason: string } {
  if (input.action !== "derisk" && input.action !== "emergency-unwind") return { route: "solana", reason: `${input.action} is answered on Solana (the reserve)` };
  if (input.idleCoversNeed) return { route: "solana", reason: "the Account's own USDC reaches the disarm level — nothing needs to cross a chain" };
  if (input.status !== "linked") return { route: "solana", reason: `pair is ${input.status}: no Base leg to close` };
  if (!input.burnerAvailable) return { route: "solana", reason: "no Base burner configured (Stream C): the single-chain path" };
  if (input.inFlightAgeS !== null && input.inFlightAgeS < input.stallS) {
    return { route: "wait", reason: `a Base burn is in flight (${input.inFlightAgeS} s old; stall window ${input.stallS} s) — waiting for delivery` };
  }
  if (input.inFlightAgeS !== null) return { route: "solana", reason: `the Base burn in flight is ${input.inFlightAgeS} s old, past the stall window: the single-chain path` };
  return { route: "bridge", reason: "linked pair: close the Base leg and burn home" };
}

export interface PairReader {
  read(account: PublicKey, view: UserAccountView, signal?: AbortSignal): Promise<PairView>;
}

/** Reads `StrategyRouter.solanaRecipient(baseAccount)` on Base; a failed read yields `recipientOnBase: null` → "unknown". */
export class BasePairReader implements PairReader {
  constructor(
    private readonly client: PublicClient,
    private readonly router: Address,
    private readonly opts: { deadlineMs: number }
  ) {}

  async read(account: PublicKey, view: UserAccountView, signal?: AbortSignal): Promise<PairView> {
    const baseAccount = baseAccountOf(view);
    const expectedRecipient = expectedRecipientOf(account);
    if (!baseAccount) return { baseAccount: null, recipientOnBase: null, expectedRecipient, status: "unlinked" };
    let recipientOnBase: `0x${string}` | null = null;
    try {
      recipientOnBase = (await withDeadline("solanaRecipient", this.opts.deadlineMs, signal, () =>
        this.client.readContract({ address: this.router, abi: strategyRouterAbi, functionName: "solanaRecipient", args: [baseAccount] })
      )) as `0x${string}`;
    } catch {
      recipientOnBase = null;
    }
    return { baseAccount, recipientOnBase, expectedRecipient, status: pairStatus(baseAccount, recipientOnBase, expectedRecipient) };
  }
}

/** A pair view for an account with no Base side read at all (no router configured). */
export function unreadPair(account: PublicKey, view: UserAccountView): PairView {
  const baseAccount = baseAccountOf(view);
  const expectedRecipient = expectedRecipientOf(account);
  return { baseAccount, recipientOnBase: null, expectedRecipient, status: baseAccount ? "unknown" : "unlinked" };
}
