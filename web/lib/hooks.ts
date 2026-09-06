"use client";

/**
 * Data hooks. Every hook resolves to a value plus a `source` so the UI can
 * label it: "live" (chain / yield service), "snapshot" (demo fallback) or
 * "cache" (indexer, pending the chain read).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { CHAIN_ID } from "@zyo/shared";
import { DEMO_KEEPER_GRANT, DEMO_MARKET, DEMO_OWNER, DEMO_PENDING_VENUES, demoGate } from "./demo";
import { ENV, contractsConfigured } from "./env";
import { fetchGate, type GateView } from "./gate";
import { fetchIndexedAccount, type IndexedAccount } from "./indexer";
import { readAccount, readDeployment, readKeeperGrant, readMarket, readPendingVenues, type AccountRead, type MarketRead, type PendingVenueRead } from "./reads";
import type { KeeperGrantRead } from "./keeper";
import { DEMO_DEPLOYMENT, type Deployment } from "./plan";

export interface Session {
  mode: "demo" | "live";
  address: Address;
  connected: boolean;
  chainId: number | undefined;
  wrongNetwork: boolean;
  /** Skip every network call (e2e / static demo). */
  offline: boolean;
}

export function useSession(): Session {
  const { address, chainId, isConnected } = useAccount();
  const offline = ENV.forceDemo;
  const connected = !offline && isConnected && !!address;
  return {
    mode: connected ? "live" : "demo",
    address: connected ? (address as Address) : DEMO_OWNER,
    connected,
    chainId,
    wrongNetwork: connected && chainId !== CHAIN_ID,
    offline,
  };
}

export function useMarket() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { offline } = useSession();
  const q = useQuery<MarketRead>({
    queryKey: ["market", offline],
    queryFn: async () => {
      if (offline || !client) return DEMO_MARKET;
      try {
        return await readMarket(client);
      } catch {
        return DEMO_MARKET;
      }
    },
    placeholderData: DEMO_MARKET,
    refetchInterval: offline ? false : 60_000,
  });
  return { market: q.data ?? DEMO_MARKET, loading: q.isFetching, source: (q.data ?? DEMO_MARKET).source };
}

export function useGate() {
  const { offline } = useSession();
  const q = useQuery<GateView>({
    queryKey: ["gate", offline],
    queryFn: async () => {
      if (offline) return demoGate();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6_000);
        const v = await fetchGate(ENV.yieldUrl, ctrl.signal);
        clearTimeout(t);
        return v;
      } catch {
        return demoGate();
      }
    },
    placeholderData: demoGate(),
    refetchInterval: offline ? false : 120_000,
  });
  const gate = q.data ?? demoGate();
  return { gate, loading: q.isFetching, source: gate.source };
}

export function useIndexed(owner: Address | undefined, enabled: boolean) {
  const q = useQuery<IndexedAccount | null>({
    queryKey: ["indexed", owner],
    enabled: enabled && !!owner,
    queryFn: async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5_000);
        const v = await fetchIndexedAccount(ENV.indexerUrl, owner as string, ctrl.signal);
        clearTimeout(t);
        return v;
      } catch {
        return null;
      }
    },
  });
  return q.data ?? null;
}

/**
 * The Oilskin deployment: env names the factory + router (+ keeper); the
 * rest is READ from the router/registry. Demo mode → the synthetic
 * DEMO_DEPLOYMENT (never signable). `null` while unknown or unconfigured.
 */
export function useDeployment(): { deployment: Deployment | null; configured: boolean; error: string | null } {
  const s = useSession();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const configured = contractsConfigured();
  const q = useQuery<Deployment | null>({
    queryKey: ["deployment", s.mode, ENV.oilskinFactory, ENV.oilskinRouter],
    enabled: s.mode === "live" && configured && !!client,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      if (!client) return null;
      const keeper = /^0x[0-9a-fA-F]{40}$/.test(ENV.oilskinKeeper) ? (ENV.oilskinKeeper as Address) : null;
      return readDeployment(client, ENV.oilskinFactory as Address, ENV.oilskinRouter as Address, keeper);
    },
  });
  if (s.mode === "demo") return { deployment: DEMO_DEPLOYMENT, configured: true, error: null };
  return { deployment: q.data ?? null, configured, error: q.error ? (q.error as Error).message : null };
}

export function useAccountRead(market: MarketRead) {
  const s = useSession();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { deployment } = useDeployment();
  const opts = useMemo(
    () => ({
      factory: deployment && !deployment.demo ? deployment.factory : undefined,
      lpVenue: deployment && !deployment.demo ? deployment.lpVenue : undefined,
      engine: deployment && !deployment.demo ? deployment.engine : undefined,
      getBalance: client ? (a: { address: Address }) => client.getBalance(a) : undefined,
    }),
    [deployment, client],
  );
  const q = useQuery<AccountRead | null>({
    queryKey: ["account", s.address, s.mode, market.readAt, deployment?.factory ?? "none"],
    enabled: s.mode === "live" && !!client && !s.wrongNetwork,
    queryFn: async () => {
      if (!client) return null;
      try {
        return await readAccount(client, s.address, market, opts);
      } catch {
        return null;
      }
    },
    refetchInterval: 30_000,
  });
  return { account: q.data ?? null, loading: q.isFetching, error: q.data === null && q.isFetched && s.mode === "live", refetch: q.refetch };
}

/**
 * The keeper permission as it exists on the connected account. `null` means
 * "nothing granted / not readable", which the UI must render as "nobody is
 * protecting this position" — never as silence.
 */
export function useKeeperGrant(account: Address | null, deployment: Deployment | null): { grant: KeeperGrantRead | null; loading: boolean; refetch: () => void } {
  const s = useSession();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const enabled = s.mode === "live" && !!client && !!account && !!deployment && !deployment.demo && !!deployment.keeper;
  const q = useQuery<KeeperGrantRead | null>({
    queryKey: ["keeper-grant", account ?? "none", deployment?.router ?? "none", deployment?.keeper ?? "none"],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!client || !account || !deployment?.keeper) return null;
      try {
        return await readKeeperGrant(client as never, account, deployment.keeper, deployment.router);
      } catch {
        return null;
      }
    },
  });
  if (s.mode === "demo") return { grant: DEMO_KEEPER_GRANT, loading: false, refetch: () => {} };
  return { grant: q.data ?? null, loading: q.isFetching, refetch: () => void q.refetch() };
}

/**
 * Venue replacements the registry owner has PROPOSED but not yet applied. A
 * non-empty list is a pending redirection of the contract your collateral sits
 * in — the delay is the only warning users get, so the UI must show it.
 */
export function usePendingVenues(deployment: Deployment | null): PendingVenueRead[] {
  const s = useSession();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const enabled = s.mode === "live" && !!client && !!deployment && !deployment.demo;
  const q = useQuery<PendingVenueRead[]>({
    queryKey: ["pending-venues", deployment?.registry ?? "none"],
    enabled,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      if (!client || !deployment) return [];
      try {
        return await readPendingVenues(client as never, deployment.registry);
      } catch {
        return [];
      }
    },
  });
  if (s.mode === "demo") return DEMO_PENDING_VENUES;
  return q.data ?? [];
}
