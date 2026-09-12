/**
 * The one on-chain number the risk slider cannot go under (BUILD-PLAN-2026-09-12 D7 / §2b):
 * `CollateralRegistry.entryHfFloorWad()`. Read live, like the rates, so `/v1/forecast` refuses
 * `entry_hf_below_floor` against the floor the venue will actually enforce — not against the shared
 * constant, which is only the deploy default. Strict: a zero, short or unreadable answer throws, and
 * the server keeps serving the last good read (marked stale past `staleAfterMs`) or, with no read at
 * all, the shared constant, saying which (`entryHfFloorSource`).
 */
import { hfFromWad } from "@zyo/shared";
import type { Address } from "../types.js";
import type { RpcClient } from "./rpc.js";

/** `entryHfFloorWad()` — keccak256("entryHfFloorWad()")[:4], pinned by contracts/abi/oilskin-abi.json. */
export const SEL_ENTRY_HF_FLOOR_WAD = "0xe2baeb4e";

export class RegistryDecodeError extends Error {
  constructor(what: string, detail: string) {
    super(`registry ${what}: ${detail}`);
    this.name = "RegistryDecodeError";
  }
}

export interface EntryHfFloorSample {
  /** The floor as a number, four decimals (the truncation the keeper and the site apply to a wad). */
  floor: number;
  /** The raw word, decimal string, so a reader can check the truncation. */
  wad: string;
  sampledAt: string;
}

export class RegistrySource {
  constructor(
    private readonly rpc: RpcClient,
    readonly registry: Address,
    private readonly now: () => number = () => Date.now()
  ) {}

  async entryHfFloor(): Promise<EntryHfFloorSample> {
    const raw = await this.rpc.ethCall(this.registry, SEL_ENTRY_HF_FLOOR_WAD);
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      throw new RegistryDecodeError("entryHfFloorWad", `expected one 32-byte word, got ${typeof raw === "string" ? raw.slice(0, 20) + "…" : typeof raw}`);
    }
    const wad = BigInt(raw);
    if (wad <= 0n) throw new RegistryDecodeError("entryHfFloorWad", "zero — the registry has no floor");
    const floor = hfFromWad(wad);
    if (!(floor >= 1)) throw new RegistryDecodeError("entryHfFloorWad", `floor ${floor} is under 1.0`);
    return { floor, wad: wad.toString(), sampledAt: new Date(this.now()).toISOString() };
  }
}
