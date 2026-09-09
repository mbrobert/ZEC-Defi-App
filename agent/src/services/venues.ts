import type { PublicClient } from "viem";
import { AAVE_V3, BASE_TOKENS, COLLATERAL_ASSETS, COLLATERAL_SYMBOLS, type CollateralSymbol } from "@zyo/shared";
import { aaveVenueAbi, collateralRegistryAbi, collateralVenueAbi, strategyRouterAbi } from "../abi/oilskin.js";
import type { Address } from "../types/evm.js";
import { withDeadline } from "./deadline.js";

/**
 * The venue-aware reader (audit wave 2, M-HIGH-2 — the real fix).
 *
 * Until this existed the keeper valued every account through the Aave v3 pool and data provider
 * from `packages/shared` (`services/chain.ts`) and nothing else, so an asset the registry pointed
 * anywhere else — the Morpho venue after `proposeVenue` → `acceptVenue`, or a future venue — was
 * `NO_DEBT` to this process: no rung, no escalation, while the dashboard said "active". The only
 * defence was a startup fatal whenever the registry disagreed with the keeper's Aave wiring.
 *
 * This reader follows the registry instead. Once per tick (`readContext`) it reads, for every
 * collateral asset the registry knows, `venueOf(asset)`, `previousVenues(asset)` (every venue the
 * asset was pointed at before — positions opened there are still live, M-HIGH-1) and `isEnabled`,
 * then classifies each distinct venue: an `AaveV3Venue` answering `PROVIDER()` with the Aave provider
 * in `@zyo/shared` is the pool the G1–G4 valuation already reads and is CROSS-CHECKED against it;
 * anything else is read through `ICollateralVenue` alone. Per account (`readAccount`) it calls
 * `healthFactor(account)`, `debt(account, USDC)` and, for a non-Aave venue, `collateral(account,
 * asset)` per enabled asset. `engine/venueValuation.ts` turns those words into a verdict, pricing
 * every non-Aave venue from the keeper's own Chainlink feeds so a venue can never vouch for itself.
 *
 * What is NOT here: nothing is cached across ticks (the registry can move an asset while the keeper
 * is up), nothing is defaulted (a failed read is recorded and the valuation fails closed), and the
 * startup probe (`probe`) is only FATAL for a venue that cannot be talked to at all — a venue that
 * answers the interface but is not Aave is a WARNING, because it is now read, not ignored.
 */

export type VenueKind = "aave" | "other";

export interface VenueAssetSpec {
  symbol: CollateralSymbol;
  asset: Address;
  decimals: number;
  /** "current": `venueOf(asset)` is this venue; "previous": it appears in `previousVenues(asset)`. */
  role: "current" | "previous";
  /** `registry.isEnabled(asset)`. Disabled assets are still WATCHED (positions may exist) but not priced. */
  enabled: boolean;
  /** `ICollateralVenue.liquidationThresholdBps(asset)`, read this tick; null when the read failed. */
  liquidationThresholdBps: bigint | null;
}

export interface VenueSpec {
  venue: Address;
  kind: VenueKind;
  /** What `PROVIDER()` answered, or null when the venue has no such view (not an AaveV3Venue). */
  provider: Address | null;
  assets: VenueAssetSpec[];
  /** Per-tick reads of this venue that failed (`enabled()`, an LT). The valuation fails closed for accounts exposed there. */
  problems: string[];
}

export interface VenueContext {
  registry: Address;
  venues: VenueSpec[];
  /** Registry reads that failed this tick (`venueOf` / `previousVenues` / `isEnabled`), per asset. */
  unreadableAssets: { symbol: CollateralSymbol; reason: string }[];
}

export interface VenueCollateralRead {
  symbol: CollateralSymbol;
  asset: Address;
  decimals: number;
  /** `ICollateralVenue.collateral(account, asset)`, raw units. */
  amount: bigint;
  liquidationThresholdBps: bigint | null;
}

export interface VenueAccountRead {
  venue: Address;
  kind: VenueKind;
  /** `ICollateralVenue.healthFactor(account)` — WAD, `type(uint256).max` for no debt. */
  healthFactorWad: bigint;
  /** `ICollateralVenue.debt(account, USDC)` — raw USDC units. */
  debtUsdc: bigint;
  /** One row per ENABLED asset this venue serves (empty for the Aave venue: the pool snapshot carries it). */
  collateral: VenueCollateralRead[];
}

export interface VenueSnapshot {
  account: Address;
  venues: VenueAccountRead[];
  /** Venues where a per-account read failed. The valuation fails closed on any entry. */
  unreadable: { venue: Address; reason: string }[];
}

export interface VenueProblem {
  symbol: CollateralSymbol;
  asset: Address;
  venue: Address | null;
  reason: string;
}

/** A venue the registry names that this keeper cannot read through `ICollateralVenue` at all. */
export class UnsupportedVenueError extends Error {
  constructor(readonly problems: readonly VenueProblem[]) {
    super(
      "registry points an asset at a venue this keeper cannot read: " +
        problems.map((p) => `${p.symbol} → ${p.venue ?? "0x0"} (${p.reason})`).join("; ") +
        " — every account would be UNKNOWN on every tick, so refuse to start instead (audit wave 2, M-HIGH-2)"
    );
    this.name = "UnsupportedVenueError";
  }
}

export interface VenueProbe {
  registry: Address;
  /** Every venue that answers the interface, with the assets (and roles) it serves. */
  venues: VenueSpec[];
  /** The subset of `venues` that is NOT the AaveV3Venue over the pool the keeper's G1–G4 valuation reads. */
  otherVenues: VenueSpec[];
  /** Assets the registry does not know (`venueOf == 0`): nothing can be opened there. */
  unregistered: CollateralSymbol[];
}

export interface VenueReaderOptions {
  deadlineMs: number;
  /** Called after each completed RPC (feeds the progress watchdog). */
  onProgress?: () => void;
  /** The loan token every venue is asked `debt(account, …)` for. Defaults to Base USDC. */
  usdc?: Address;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function isZero(a: string | null | undefined): boolean {
  return !a || a.toLowerCase() === ZERO;
}

export class VenueReader {
  private registryAddress: Address | null = null;
  readonly usdc: Address;

  constructor(
    private readonly client: PublicClient,
    readonly router: Address,
    private readonly opts: VenueReaderOptions
  ) {
    this.usdc = opts.usdc ?? (BASE_TOKENS.USDC.address as Address);
  }

  private async call<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const v = await withDeadline(label, this.opts.deadlineMs, signal, work);
    this.opts.onProgress?.();
    return v;
  }

  /** `router.REGISTRY()` — immutable on the router, so read once. */
  async registry(signal?: AbortSignal): Promise<Address> {
    if (this.registryAddress) return this.registryAddress;
    const r = (await this.call("router.REGISTRY", signal, () =>
      this.client.readContract({ address: this.router, abi: strategyRouterAbi, functionName: "REGISTRY" })
    )) as Address;
    if (isZero(r)) throw new Error("router.REGISTRY() is the zero address");
    this.registryAddress = r;
    return r;
  }

  /**
   * Per-tick venue context: which venues the registry names for each asset (current + previous),
   * whether the asset is enabled, and each venue's kind and live liquidation thresholds.
   */
  async readContext(signal?: AbortSignal): Promise<VenueContext> {
    const registry = await this.registry(signal);
    const unreadableAssets: VenueContext["unreadableAssets"] = [];
    const byVenue = new Map<string, VenueSpec>();

    const perAsset = await Promise.all(
      COLLATERAL_SYMBOLS.map(async (symbol) => {
        const asset = COLLATERAL_ASSETS[symbol].address as Address;
        try {
          const [current, previous, enabled] = await Promise.all([
            this.call(`registry.venueOf(${symbol})`, signal, () =>
              this.client.readContract({ address: registry, abi: collateralRegistryAbi, functionName: "venueOf", args: [asset] })
            ) as Promise<Address>,
            this.call(`registry.previousVenues(${symbol})`, signal, () =>
              this.client.readContract({ address: registry, abi: collateralRegistryAbi, functionName: "previousVenues", args: [asset] })
            ) as Promise<readonly Address[]>,
            this.call(`registry.isEnabled(${symbol})`, signal, () =>
              this.client.readContract({ address: registry, abi: collateralRegistryAbi, functionName: "isEnabled", args: [asset] })
            ) as Promise<boolean>,
          ]);
          return { symbol, asset, current, previous: [...previous], enabled };
        } catch (e) {
          unreadableAssets.push({ symbol, reason: errMsg(e) });
          return null;
        }
      })
    );

    for (const row of perAsset) {
      if (!row || isZero(row.current)) continue; // not registered: nothing can be opened there
      const spec = COLLATERAL_ASSETS[row.symbol];
      const add = (venue: Address, role: "current" | "previous") => {
        const key = venue.toLowerCase();
        const v = byVenue.get(key) ?? { venue, kind: "other", provider: null, assets: [], problems: [] };
        if (!v.assets.some((a) => a.asset.toLowerCase() === row.asset.toLowerCase())) {
          v.assets.push({ symbol: row.symbol, asset: row.asset, decimals: spec.decimals, role, enabled: row.enabled, liquidationThresholdBps: null });
        }
        byVenue.set(key, v);
      };
      add(row.current, "current");
      for (const p of row.previous) if (!isZero(p) && p.toLowerCase() !== row.current.toLowerCase()) add(p, "previous");
    }

    await Promise.all(
      [...byVenue.values()].map(async (v) => {
        // Kind: an AaveV3Venue over the provider in @zyo/shared is the pool the G1–G4 valuation reads.
        try {
          const provider = (await this.call(`venue.PROVIDER(${v.venue})`, signal, () =>
            this.client.readContract({ address: v.venue, abi: aaveVenueAbi, functionName: "PROVIDER" })
          )) as Address;
          v.provider = provider;
          v.kind = provider.toLowerCase() === AAVE_V3.poolAddressesProvider.toLowerCase() ? "aave" : "other";
        } catch {
          v.provider = null;
          v.kind = "other";
        }
        try {
          const enabled = (await this.call(`venue.enabled(${v.venue})`, signal, () =>
            this.client.readContract({ address: v.venue, abi: collateralVenueAbi, functionName: "enabled" })
          )) as boolean;
          if (!enabled) v.problems.push("venue.enabled() is false");
        } catch (e) {
          v.problems.push(`venue.enabled(): ${errMsg(e)}`);
        }
        // Thresholds only for ENABLED assets; an unlisted asset makes some venues revert here, and a
        // disabled asset's position is still caught by healthFactor / debt below.
        await Promise.all(
          v.assets
            .filter((a) => a.enabled)
            .map(async (a) => {
              try {
                a.liquidationThresholdBps = (await this.call(`venue.liquidationThresholdBps(${a.symbol})`, signal, () =>
                  this.client.readContract({ address: v.venue, abi: collateralVenueAbi, functionName: "liquidationThresholdBps", args: [a.asset] })
                )) as bigint;
              } catch (e) {
                v.problems.push(`liquidationThresholdBps(${a.symbol}): ${errMsg(e)}`);
              }
            })
        );
      })
    );

    const venues = [...byVenue.values()].sort((a, b) => a.venue.toLowerCase().localeCompare(b.venue.toLowerCase()));
    return { registry, venues, unreadableAssets };
  }

  /**
   * Snapshot one account across every venue in the context. A venue whose `healthFactor` or
   * `debt` (or, for a non-Aave venue, a `collateral`) read failed lands in `unreadable`, never in
   * `venues` with a default.
   */
  async readAccount(account: Address, ctx: VenueContext, signal?: AbortSignal): Promise<VenueSnapshot> {
    const venues: VenueAccountRead[] = [];
    const unreadable: VenueSnapshot["unreadable"] = [];
    await Promise.all(
      ctx.venues.map(async (v) => {
        try {
          const [healthFactorWad, debtUsdc] = await Promise.all([
            this.call(`venue.healthFactor(${v.venue},${account})`, signal, () =>
              this.client.readContract({ address: v.venue, abi: collateralVenueAbi, functionName: "healthFactor", args: [account] })
            ) as Promise<bigint>,
            this.call(`venue.debt(${v.venue},${account})`, signal, () =>
              this.client.readContract({ address: v.venue, abi: collateralVenueAbi, functionName: "debt", args: [account, this.usdc] })
            ) as Promise<bigint>,
          ]);
          const collateral: VenueCollateralRead[] = [];
          if (v.kind === "other") {
            await Promise.all(
              v.assets
                .filter((a) => a.enabled)
                .map(async (a) => {
                  const amount = (await this.call(`venue.collateral(${v.venue},${a.symbol},${account})`, signal, () =>
                    this.client.readContract({ address: v.venue, abi: collateralVenueAbi, functionName: "collateral", args: [account, a.asset] })
                  )) as bigint;
                  collateral.push({ symbol: a.symbol, asset: a.asset, decimals: a.decimals, amount, liquidationThresholdBps: a.liquidationThresholdBps });
                })
            );
            collateral.sort((a, b) => a.symbol.localeCompare(b.symbol));
          }
          venues.push({ venue: v.venue, kind: v.kind, healthFactorWad, debtUsdc, collateral });
        } catch (e) {
          unreadable.push({ venue: v.venue, reason: errMsg(e) });
        }
      })
    );
    venues.sort((a, b) => a.venue.toLowerCase().localeCompare(b.venue.toLowerCase()));
    return { account, venues, unreadable };
  }

  /**
   * Startup probe. FATAL (`UnsupportedVenueError`) only for a venue the reader cannot talk to —
   * one that does not answer `enabled()` or a live threshold for an enabled asset, or a registry
   * whose pointers cannot be read — because every account would then be UNKNOWN on every tick.
   * A venue that answers but is not the Aave venue is returned in `otherVenues` for the caller
   * to WARN about: it is read through `ICollateralVenue` with the feed cross-check, not ignored.
   */
  async probe(signal?: AbortSignal): Promise<VenueProbe> {
    const ctx = await this.readContext(signal);
    const problems: VenueProblem[] = [];
    for (const u of ctx.unreadableAssets) {
      problems.push({ symbol: u.symbol, asset: COLLATERAL_ASSETS[u.symbol].address as Address, venue: null, reason: `registry unreadable: ${u.reason}` });
    }
    for (const v of ctx.venues) {
      const enabledAssets = v.assets.filter((a) => a.enabled);
      const ltMissing = enabledAssets.filter((a) => a.liquidationThresholdBps === null || a.liquidationThresholdBps === 0n);
      if (v.problems.length || ltMissing.length) {
        for (const a of v.assets) {
          const why = [
            ...v.problems,
            ...ltMissing.filter((m) => m.symbol === a.symbol).map((m) => (m.liquidationThresholdBps === 0n ? `liquidationThresholdBps(${m.symbol}) is 0: the venue does not know this asset` : "")),
          ].filter(Boolean);
          if (why.length) problems.push({ symbol: a.symbol, asset: a.asset, venue: v.venue, reason: why.join("; ") });
        }
      }
    }
    if (problems.length) throw new UnsupportedVenueError(problems);
    const known = new Set(ctx.venues.flatMap((v) => v.assets.map((a) => a.symbol)));
    return {
      registry: ctx.registry,
      venues: ctx.venues,
      otherVenues: ctx.venues.filter((v) => v.kind === "other"),
      unregistered: COLLATERAL_SYMBOLS.filter((s) => !known.has(s)),
    };
  }
}
