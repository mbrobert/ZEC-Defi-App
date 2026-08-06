import { keccak256Bytes, bytesToHex, selector } from "../vendor/keccak.js";
import type { Address, Hex } from "../types/evm.js";

/**
 * What the agent needs from Base. The zero-dependency implementation below
 * covers all READS via bare JSON-RPC `eth_call`. WRITES (compound /
 * routeToZcash) require transaction signing, which we refuse to hand-roll —
 * wire `integrations/viem-basechain.example.ts` once viem is installable
 * (see docs/INTEGRATIONS.md).
 */
export interface OnchainPosition {
  owner: Address;
  adapter: Address;
  /** Engine pool registry key (bytes32), NOT a pool address. */
  poolKey: Hex;
  token: Address;
  shares: bigint;
  params: { rangeWidthBps: number; rebalanceDelay: number; autoCompound: boolean };
  /** 0 = COMPOUND, 1 = SEND_TO_ZCASH. */
  rewardPref: number;
  zcashAddress: string;
  createdAt: bigint;
  active: boolean;
}

export interface ChainService {
  getPosition(positionId: bigint): Promise<OnchainPosition>;
  getPendingRewards(
    adapter: Address,
    positionId: bigint
  ): Promise<{ tokens: Address[]; amounts: bigint[] }>;
  isInRange(adapter: Address, positionId: bigint): Promise<boolean>;
  compound(positionId: bigint): Promise<Hex>;
  routeToZcash(positionId: bigint, intentsDepositAddress: Address, quoteHash: Hex): Promise<Hex>;
}

// ---------------------------------------------------------------------------
// Minimal ABI helpers — scoped to exactly the shapes this service reads.
// ---------------------------------------------------------------------------

export function encodeUint256(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

function word(data: string, i: number): string {
  return data.slice(i * 64, (i + 1) * 64);
}

function wordToBigint(w: string): bigint {
  return BigInt(`0x${w || "0"}`);
}

function wordToAddress(w: string): Address {
  return `0x${w.slice(24)}` as Address;
}

function wordToBool(w: string): boolean {
  return wordToBigint(w) === 1n;
}

/** Decode an ABI `string` located at absolute word offset (in the tail). */
function decodeString(data: string, byteOffset: bigint): string {
  const wordIdx = Number(byteOffset / 32n);
  const len = Number(wordToBigint(word(data, wordIdx)));
  const hex = data.slice((wordIdx + 1) * 64, (wordIdx + 1) * 64 + len * 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function decodeDynArray<T>(data: string, byteOffset: bigint, mapWord: (w: string) => T): T[] {
  const wordIdx = Number(byteOffset / 32n);
  const len = Number(wordToBigint(word(data, wordIdx)));
  const out: T[] = [];
  for (let i = 0; i < len; i++) out.push(mapWord(word(data, wordIdx + 1 + i)));
  return out;
}

// ---------------------------------------------------------------------------

export class WritesNotConfiguredError extends Error {
  constructor(op: string) {
    super(
      `${op}: transaction signing is not available in the zero-dependency chain service. ` +
        `Install viem and wire integrations/viem-basechain.example.ts (docs/INTEGRATIONS.md).`
    );
    this.name = "WritesNotConfiguredError";
  }
}

/**
 * Read-only Base client over bare JSON-RPC. No dependencies, no key material.
 */
export class RpcReadOnlyChainService implements ChainService {
  private id = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly vaultAddress: Address,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async ethCall(to: Address, dataHex: string): Promise<string> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.id,
        method: "eth_call",
        params: [{ to, data: dataHex }, "latest"],
      }),
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) throw new Error(`rpc error: ${body.error.message}`);
    return (body.result ?? "0x").replace(/^0x/, "");
  }

  async getPosition(positionId: bigint): Promise<OnchainPosition> {
    const data = selector("getPosition(uint256)") + encodeUint256(positionId);
    const raw = await this.ethCall(this.vaultAddress, data);

    // Return value is a single struct with a dynamic member (string), so the
    // ABI wraps it: word0 = offset to tuple. Tuple layout (heads):
    //   0 owner  1 adapter  2 poolKey(bytes32)  3 token  4 shares
    //   5..7 params(uint24,uint64,bool)  8 rewardPref
    //   9 offset(zcashAddress) rel. to tuple start  10 createdAt  11 active
    const tupleOffset = wordToBigint(word(raw, 0)); // bytes
    const base = Number(tupleOffset / 32n);
    const w = (i: number) => word(raw, base + i);

    const strOffsetRel = wordToBigint(w(9));
    return {
      owner: wordToAddress(w(0)),
      adapter: wordToAddress(w(1)),
      poolKey: `0x${w(2)}` as Hex,
      token: wordToAddress(w(3)),
      shares: wordToBigint(w(4)),
      params: {
        rangeWidthBps: Number(wordToBigint(w(5))),
        rebalanceDelay: Number(wordToBigint(w(6))),
        autoCompound: wordToBool(w(7)),
      },
      rewardPref: Number(wordToBigint(w(8))),
      zcashAddress: decodeString(raw, tupleOffset + strOffsetRel),
      createdAt: wordToBigint(w(10)),
      active: wordToBool(w(11)),
    };
  }

  async getPendingRewards(adapter: Address, positionId: bigint) {
    const data = selector("pendingRewards(uint256)") + encodeUint256(positionId);
    const raw = await this.ethCall(adapter, data);
    const tokensOffset = wordToBigint(word(raw, 0));
    const amountsOffset = wordToBigint(word(raw, 1));
    return {
      tokens: decodeDynArray(raw, tokensOffset, wordToAddress),
      amounts: decodeDynArray(raw, amountsOffset, wordToBigint),
    };
  }

  async isInRange(adapter: Address, positionId: bigint): Promise<boolean> {
    const data = selector("inRange(uint256)") + encodeUint256(positionId);
    const raw = await this.ethCall(adapter, data);
    return wordToBool(word(raw, 0));
  }

  async compound(): Promise<Hex> {
    throw new WritesNotConfiguredError("compound");
  }

  async routeToZcash(): Promise<Hex> {
    throw new WritesNotConfiguredError("routeToZcash");
  }
}

/** Convenience: keccak hash of arbitrary bytes as 0x hex (re-export). */
export function keccakHex(bytes: Uint8Array): Hex {
  return bytesToHex(keccak256Bytes(bytes));
}
