import type { PublicClient } from "viem";
import { AAVE_V3, COLLATERAL_ASSETS, COLLATERAL_SYMBOLS, type CollateralSymbol } from "@zyo/shared";
import { aaveVenueAbi, collateralRegistryAbi, strategyRouterAbi } from "../abi/oilskin.js";
import type { Address } from "../types/evm.js";
import { withDeadline } from "./deadline.js";

/**
 * The venue guard (audit wave 2, M-HIGH-2).
 *
 * This keeper values every account through the Aave v3 pool and data provider
 * from `packages/shared` (`services/chain.ts`). It does not read
 * `ICollateralVenue`. So if the registry points an ENABLED collateral asset at
 * any venue other than an `AaveV3Venue` over that same pool — the Morpho venue
 * after a `proposeVenue` → `acceptVenue`, or a future venue — every position
 * opened there is `NO_DEBT` to this process: no rung ever fires, no
 * escalation, while the dashboard's KeeperPanel still says "active".
 *
 * Until a venue-aware reader exists, the honest behaviour is to REFUSE TO
 * START. A keeper that heartbeats while blind to a class of positions is the
 * failure mode wave 1 found twice (C-HIGH-1, C-HIGH-2); a loud fatal at
 * startup is the fix shape D6 established for the feed policy.
 */

export interface VenueProblem {
  symbol: CollateralSymbol;
  asset: Address;
  venue: Address | null;
  reason: string;
}

export class UnsupportedVenueError extends Error {
  constructor(readonly problems: readonly VenueProblem[]) {
    super(
      "registry points an enabled asset at a venue this keeper cannot read: " +
        problems.map((p) => `${p.symbol} → ${p.venue ?? "0x0"} (${p.reason})`).join("; ") +
        " — the keeper values through the Aave pool only and would report NO_DEBT for every position there (audit wave 2, M-HIGH-2)"
    );
    this.name = "UnsupportedVenueError";
  }
}

export interface VenueGuardResult {
  registry: Address;
  /** Every enabled asset and the AaveV3Venue it resolved to. */
  checked: { symbol: CollateralSymbol; asset: Address; venue: Address }[];
  /** Assets the registry has disabled — not checked, nothing can be opened there. */
  skippedDisabled: CollateralSymbol[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Read `router.REGISTRY()`, then for every ENABLED collateral asset the venue
 * the registry names, and require that venue to answer `PROVIDER()` with the
 * Aave PoolAddressesProvider this keeper is compiled against. Throws
 * `UnsupportedVenueError` listing every asset that fails.
 */
export async function assertAaveVenues(client: PublicClient, router: Address, deadlineMs: number, signal?: AbortSignal): Promise<VenueGuardResult> {
  const call = <T>(label: string, work: () => Promise<T>) => withDeadline(label, deadlineMs, signal, work);
  const registry = (await call("router.REGISTRY", () =>
    client.readContract({ address: router, abi: strategyRouterAbi, functionName: "REGISTRY" })
  )) as Address;
  const problems: VenueProblem[] = [];
  const checked: VenueGuardResult["checked"] = [];
  const skippedDisabled: CollateralSymbol[] = [];
  for (const symbol of COLLATERAL_SYMBOLS) {
    const asset = COLLATERAL_ASSETS[symbol].address as Address;
    const enabled = (await call(`registry.isEnabled(${symbol})`, () =>
      client.readContract({ address: registry, abi: collateralRegistryAbi, functionName: "isEnabled", args: [asset] })
    )) as boolean;
    if (!enabled) {
      skippedDisabled.push(symbol);
      continue;
    }
    const venue = (await call(`registry.venueOf(${symbol})`, () =>
      client.readContract({ address: registry, abi: collateralRegistryAbi, functionName: "venueOf", args: [asset] })
    )) as Address;
    if (!venue || venue.toLowerCase() === ZERO) {
      problems.push({ symbol, asset, venue: null, reason: "registry names no venue" });
      continue;
    }
    let provider: string;
    try {
      provider = (await call(`venue.PROVIDER(${symbol})`, () =>
        client.readContract({ address: venue, abi: aaveVenueAbi, functionName: "PROVIDER" })
      )) as string;
    } catch (e) {
      problems.push({ symbol, asset, venue, reason: `venue does not answer PROVIDER(): not an AaveV3Venue (${errMsg(e)})` });
      continue;
    }
    if (provider.toLowerCase() !== AAVE_V3.poolAddressesProvider.toLowerCase()) {
      problems.push({ symbol, asset, venue, reason: `venue PROVIDER() is ${provider}, not the Aave provider ${AAVE_V3.poolAddressesProvider} this keeper reads` });
      continue;
    }
    checked.push({ symbol, asset, venue });
  }
  if (problems.length) throw new UnsupportedVenueError(problems);
  return { registry, checked, skippedDisabled };
}
