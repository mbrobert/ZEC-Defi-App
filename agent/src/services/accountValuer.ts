import type { TokenSymbol } from "@zyo/shared";
import { evaluateSnapshot, type ValuationParams } from "../engine/valuation.js";
import { evaluateVenues, type AccountValuation } from "../engine/venueValuation.js";
import type { Address } from "../types/evm.js";
import type { AaveReader, ReserveContextResult } from "./chain.js";
import { AbortedError } from "./deadline.js";
import type { VenueContext, VenueReader } from "./venues.js";

/**
 * The one place the monitor and the dispatcher value an account from, so the two can never
 * disagree about what a position is worth or where it sits (audit wave 2, M-HIGH-2).
 *
 * With a `VenueReader` (the router, hence the registry, is configured) every account is valued
 * through the Aave pool AND through every venue the registry names for its collateral, and the
 * combined verdict is the worst of them (`engine/venueValuation.ts`). Without one — observe-only
 * with no `STRATEGY_ROUTER_ADDRESS` — only the Aave pool is read, exactly as before, and
 * `runKeeper` says so at startup.
 */

export interface TickContexts {
  reserves: Map<TokenSymbol, ReserveContextResult>;
  /** null when no VenueReader is configured (Aave-only). */
  venues: VenueContext | null;
  /** Set when the venue context could not be read this tick: every account is then UNKNOWN. */
  venueError: string | null;
}

export interface Valuer {
  reader: AaveReader;
  venues: VenueReader | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

/** Per-tick context: Aave reserve contexts, and the registry's venues when a reader exists. */
export async function readTickContexts(v: Valuer, signal?: AbortSignal): Promise<TickContexts> {
  const [reserves, venueRes] = await Promise.all([
    v.reader.readReserveContexts(signal),
    v.venues
      ? v.venues
          .readContext(signal)
          .then((ctx) => ({ ctx, error: null as string | null }))
          .catch((e: unknown) => {
            if (e instanceof AbortedError || signal?.aborted) throw e;
            return { ctx: null, error: errMsg(e) };
          })
      : Promise.resolve({ ctx: null, error: null as string | null }),
  ]);
  return { reserves, venues: venueRes.ctx, venueError: venueRes.error };
}

/**
 * Read and value one account. Throws only when the Aave pool-level read fails (nothing to value at
 * all, as before); every other failure is a fail-closed UNKNOWN inside the result.
 */
export async function valueAccount(v: Valuer, account: Address, ctx: TickContexts, head: bigint, params: ValuationParams, signal?: AbortSignal): Promise<AccountValuation> {
  const snap = await v.reader.readAccount(account, ctx.reserves, head, signal);
  const aave = evaluateSnapshot(snap, params);
  if (!v.venues) return { valuation: aave, aave, venues: null };
  if (ctx.venueError !== null || !ctx.venues) {
    return { valuation: { kind: "UNKNOWN", reasons: [`V1 registry: venue context unreadable this tick (${ctx.venueError ?? "no context"}) — cannot tell where this account's collateral sits`] }, aave, venues: [] };
  }
  let venueSnap;
  try {
    venueSnap = await v.venues.readAccount(account, ctx.venues, signal);
  } catch (e) {
    if (e instanceof AbortedError || signal?.aborted) throw e;
    return { valuation: { kind: "UNKNOWN", reasons: [`V1 venue reads failed: ${errMsg(e)}`] }, aave, venues: [] };
  }
  const usdcSpec = v.reader.reserveSpecs.find((s) => s.asset.toLowerCase() === v.venues!.usdc.toLowerCase());
  return evaluateVenues(
    {
      aave,
      aaveSnapshot: snap,
      venues: venueSnap,
      context: ctx.venues,
      reserves: ctx.reserves,
      usdc: { asset: v.venues.usdc, decimals: usdcSpec?.decimals ?? 6 },
    },
    params
  );
}
