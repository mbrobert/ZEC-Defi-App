/**
 * Read side of the Solana keeper — the twin of `services/chain.ts` + `services/discovery.ts`.
 *
 * Discovery is `getProgramAccounts` on the Oilskin program filtered by the `UserAccount` discriminator
 * (every account the program ever created, no cursor to lose). Valuation input is ONE simulated
 * transaction — refresh both reserves, refresh the obligation — whose returned account states are Kamino's
 * own refreshed numbers at the RPC's slot; nothing is signed (`sigVerify: false`) and the fee payer is a
 * pubkey that merely has to exist. The independent price is pluggable: Jupiter's quote on mainnet, nothing
 * on localnet (declared, never silent).
 */
import { Connection, PublicKey, Transaction, type AccountInfo } from "@solana/web3.js";
import { withDeadline } from "../services/deadline.js";
import {
  OILSKIN_ACCOUNT,
  PK,
  USDC_SCOPE_INDEX,
  USER_ACCOUNT_LEN,
  ZEC_SCOPE_INDEX,
  ata,
  decodeGrant,
  decodeObligation,
  decodeReserve,
  decodeScopeEntry,
  decodeUserAccount,
  grantPda,
  ixRefreshObligation,
  ixRefreshReserve,
  obligationPda,
  type GrantView,
  type UserAccountView,
} from "./layouts.js";
import type { IndependentPrice, SolanaSnapshot } from "./valuation.js";

export interface DiscoveredSolanaAccount {
  account: PublicKey;
  view: UserAccountView;
}

export interface IndependentPriceSource {
  name: string;
  zecUsd(signal?: AbortSignal): Promise<IndependentPrice>;
}

/** Jupiter's quote for 1 ZEC → USDC, read as a price. Mainnet only; a localnet has no Jupiter. */
export function jupiterPriceSource(quoteUrl: string, fetchImpl: typeof fetch = fetch, now: () => number = () => Date.now()): IndependentPriceSource {
  return {
    name: "jupiter",
    async zecUsd(signal) {
      const u = new URL(quoteUrl);
      u.searchParams.set("inputMint", PK.zecMint.toBase58());
      u.searchParams.set("outputMint", PK.usdcMint.toBase58());
      u.searchParams.set("amount", "100000000");
      u.searchParams.set("slippageBps", "50");
      const res = await fetchImpl(u, { signal });
      if (!res.ok) throw new Error(`jupiter quote HTTP ${res.status}`);
      const j = (await res.json()) as { outAmount?: string };
      if (!j.outAmount || !/^\d+$/.test(j.outAmount)) throw new Error("jupiter quote has no outAmount");
      return { priceUsd: Number(j.outAmount) / 1e6, atS: Math.floor(now() / 1000), source: "jupiter" };
    },
  };
}

export interface SolanaReaderOptions {
  deadlineMs: number;
  onProgress?: () => void;
  independent: IndependentPriceSource | null;
}

const splAmount = (info: AccountInfo<Buffer> | null): bigint => (info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n);

export class SolanaReader {
  constructor(
    readonly connection: Connection,
    readonly programId: PublicKey,
    private readonly opts: SolanaReaderOptions
  ) {}

  private dl<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withDeadline(label, this.opts.deadlineMs, signal, fn).then((v) => {
      this.opts.onProgress?.();
      return v;
    });
  }

  async slot(signal?: AbortSignal): Promise<bigint> {
    return BigInt(await this.dl("getSlot", () => this.connection.getSlot("confirmed"), signal));
  }

  async blockTime(slot: bigint, signal?: AbortSignal): Promise<bigint> {
    const t = await this.dl(`getBlockTime(${slot})`, () => this.connection.getBlockTime(Number(slot)), signal);
    if (t === null) throw new Error(`no block time for slot ${slot}`);
    return BigInt(t);
  }

  /** Every UserAccount the program owns. */
  async discover(signal?: AbortSignal): Promise<DiscoveredSolanaAccount[]> {
    const accounts = await this.dl(
      "getProgramAccounts(UserAccount)",
      () =>
        this.connection.getProgramAccounts(this.programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_ACCOUNT_LEN }, { memcmp: { offset: 0, bytes: bs58Disc(OILSKIN_ACCOUNT.userAccount) } }],
        }),
      signal
    );
    const out: DiscoveredSolanaAccount[] = [];
    for (const a of accounts) {
      try {
        out.push({ account: a.pubkey, view: decodeUserAccount(a.account.data) });
      } catch {
        // Not one of ours (a size collision): skip, never guess.
      }
    }
    return out;
  }

  async readGrant(account: PublicKey, keeper: PublicKey, signal?: AbortSignal): Promise<GrantView | null> {
    const info = await this.dl("getAccountInfo(grant)", () => this.connection.getAccountInfo(grantPda(this.programId, account, keeper), "confirmed"), signal);
    if (!info || !info.owner.equals(this.programId)) return null;
    return decodeGrant(info.data);
  }

  /**
   * Kamino's own refreshed view of the position, from a simulation nobody signs, plus the Scope entries the
   * reserves read, the Account's balances and the independent price.
   */
  async snapshot(account: PublicKey, view: UserAccountView, simPayer: PublicKey, signal?: AbortSignal): Promise<SolanaSnapshot> {
    const obligation = obligationPda(account);
    const [obInfo, scopeInfo, zecAtaInfo, usdcAtaInfo] = await this.dl(
      "getMultipleAccountsInfo(obligation, scope, atas)",
      () => this.connection.getMultipleAccountsInfo([obligation, PK.scopePrices, ata(account, PK.zecMint), ata(account, PK.usdcMint)], "confirmed"),
      signal
    );
    if (!scopeInfo || !scopeInfo.owner.equals(PK.scope)) throw new Error("Scope OraclePrices unreadable");
    const scopeZec = decodeScopeEntry(scopeInfo.data, ZEC_SCOPE_INDEX);
    const scopeUsdc = decodeScopeEntry(scopeInfo.data, USDC_SCOPE_INDEX);
    const accountZec = splAmount(zecAtaInfo);
    const accountUsdc = splAmount(usdcAtaInfo);
    const open = !!obInfo && obInfo.owner.equals(PK.klend);
    const peek = open ? decodeObligation(obInfo!.data) : null;
    if (peek && !peek.owner.equals(account)) throw new Error(`obligation ${obligation.toBase58()} is not owned by the Account`);

    // One simulated refresh: reserves, then the obligation with exactly the reserves it references.
    const tx = new Transaction({ feePayer: simPayer, recentBlockhash: PublicKey.default.toBase58() });
    tx.add(ixRefreshReserve(PK.zecReserve), ixRefreshReserve(PK.usdcReserve));
    if (peek) tx.add(ixRefreshObligation(obligation, [...peek.depositReserves, ...peek.borrowReserves]));
    const addresses = [PK.zecReserve.toBase58(), PK.usdcReserve.toBase58(), ...(peek ? [obligation.toBase58()] : [])];
    const sim = await this.dl(
      "simulateTransaction(refresh)",
      () => this.connection.simulateTransaction(tx, undefined, addresses.map((a) => new PublicKey(a))),
      signal
    );
    if (sim.value.err) throw new Error(`refresh simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-4).join(" | ")}`);
    const returned = sim.value.accounts ?? [];
    const dataOf = (i: number): Buffer => {
      const a = returned[i];
      if (!a || !a.data || a.data[1] !== "base64") throw new Error(`simulation returned no account ${i}`);
      return Buffer.from(a.data[0], "base64");
    };
    const zecReserve = decodeReserve(dataOf(0));
    const usdcReserve = decodeReserve(dataOf(1));
    const obligationView = peek ? decodeObligation(dataOf(2)) : null;
    const slot = BigInt(sim.context.slot);
    const nowS = await this.blockTime(slot, signal);

    let independent: IndependentPrice | null = null;
    if (this.opts.independent) {
      try {
        independent = await this.dl(`independent price (${this.opts.independent.name})`, () => this.opts.independent!.zecUsd(signal), signal);
      } catch {
        independent = null; // S4 names it
      }
    }
    return { slot, nowS, obligation: obligationView, zecReserve, usdcReserve, scopeZec, scopeUsdc, independent, accountUsdc, accountZec };
  }

  async tokenBalance(owner: PublicKey, mint: PublicKey, signal?: AbortSignal): Promise<bigint> {
    const info = await this.dl("getAccountInfo(ata)", () => this.connection.getAccountInfo(ata(owner, mint), "confirmed"), signal);
    return splAmount(info);
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58 of an 8-byte discriminator (what `memcmp.bytes` wants). */
export function bs58Disc(d: Uint8Array): string {
  let n = 0n;
  for (const b of d) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of d) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
