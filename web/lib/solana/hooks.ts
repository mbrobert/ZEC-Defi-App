"use client";

/** React hooks for the Solana surfaces: the wallet session, the yield service's Kamino view, the user's position. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ENV } from "@/lib/env";
import { SOLANA_ENV, solanaConfigured, solanaKeeperConfigured } from "./env";
import { readSolanaPosition, type SolanaPosition } from "./reads";
import { demoSolanaBorrow, fetchSolanaBorrow, type SolanaBorrowQuery, type SolanaBorrowView } from "./yield";

export interface SolanaSession {
  mode: "demo" | "live";
  connected: boolean;
  publicKey: PublicKey | null;
  /** The program id is configured for a named cluster; without it every surface is demo. */
  configured: boolean;
  keeperConfigured: boolean;
  /** Skip every network call (e2e / static demo). */
  offline: boolean;
}
export function useSolanaSession(): SolanaSession {
  const { publicKey, connected } = useWallet();
  const offline = ENV.forceDemo;
  const configured = solanaConfigured();
  const live = !offline && configured && connected && publicKey !== null;
  return { mode: live ? "live" : "demo", connected: live, publicKey: live ? publicKey : null, configured, keeperConfigured: solanaKeeperConfigured(), offline };
}

/** The yield service's view of Kamino for this query; the demo snapshot when offline or unreachable (and said so). */
export function useSolanaBorrowView(q: SolanaBorrowQuery): { view: SolanaBorrowView; loading: boolean } {
  const { offline } = useSolanaSession();
  const key = [q.collateralZec ?? "", q.amountUsdc ?? "", q.entryHf ?? ""].join("|");
  const fq = useQuery<SolanaBorrowView>({
    queryKey: ["solana-borrow", offline, key],
    queryFn: async () => {
      if (offline) return demoSolanaBorrow();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6_000);
        const v = await fetchSolanaBorrow(ENV.yieldUrl, q, ctrl.signal);
        clearTimeout(t);
        return v;
      } catch {
        return demoSolanaBorrow();
      }
    },
    placeholderData: demoSolanaBorrow(),
    refetchInterval: offline ? false : 60_000,
  });
  return { view: fq.data ?? demoSolanaBorrow(), loading: fq.isFetching };
}

/** The connected wallet's Oilskin position on Solana; null in demo mode. */
export function useSolanaPosition(): { position: SolanaPosition | null; loading: boolean; error: string | null; refetch: () => void } {
  const { connection } = useConnection();
  const s = useSolanaSession();
  const [position, setPosition] = useState<SolanaPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const programId = useMemo(() => (s.configured ? new PublicKey(SOLANA_ENV.programId) : null), [s.configured]);
  const keeper = useMemo(() => (s.keeperConfigured ? new PublicKey(SOLANA_ENV.keeper) : null), [s.keeperConfigured]);
  useEffect(() => {
    if (!s.connected || !s.publicKey || !programId) {
      setPosition(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    readSolanaPosition(connection, programId, s.publicKey, keeper)
      .then((p) => {
        if (!cancelled) {
          setPosition(p);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, programId, keeper, s.connected, s.publicKey, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { position, loading, error, refetch };
}
