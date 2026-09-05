/**
 * Indexer CACHE for the dashboard. The yield service's indexer folds Snuggle
 * events per owner; the dashboard paints from it while the chain read is in
 * flight and then overwrites every field the chain answers. It is never the
 * authority: a stale or missing cache only delays the first paint.
 */
import type { CuratedPool } from "@zyo/shared";
import { CURATED_POOLS } from "@zyo/shared";

export interface IndexedLpPosition {
  positionId: string;
  poolId: string;
  pool: CuratedPool | undefined;
  openedAt?: string;
  entryUsdc?: number;
  valueUsd?: number;
  inRange?: boolean;
  accruedRewardsUsd?: number;
  rangeWidthBps?: number;
  lastEventAt?: string;
}

export interface IndexedAccount {
  owner: string;
  account?: string;
  positions: IndexedLpPosition[];
  activity: { at: string; kind: string; text: string; tx?: string }[];
  indexedAt: string;
  /** Head block the indexer had folded at `indexedAt`. */
  block?: number;
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

export function normalizeIndexed(raw: unknown, owner: string): IndexedAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(r.positions) ? r.positions : []) as Record<string, unknown>[];
  const positions: IndexedLpPosition[] = [];
  for (const p of list) {
    const positionId = typeof p.positionId === "string" ? p.positionId : typeof p.tokenId === "string" ? p.tokenId : undefined;
    const poolId = typeof p.poolId === "string" ? p.poolId : undefined;
    if (!positionId || !poolId) continue;
    positions.push({
      positionId,
      poolId,
      pool: CURATED_POOLS.find((x) => x.id === poolId),
      openedAt: typeof p.openedAt === "string" ? p.openedAt : undefined,
      entryUsdc: num(p.entryUsdc),
      valueUsd: num(p.valueUsd),
      inRange: typeof p.inRange === "boolean" ? p.inRange : undefined,
      accruedRewardsUsd: num(p.accruedRewardsUsd),
      rangeWidthBps: num(p.rangeWidthBps),
      lastEventAt: typeof p.lastEventAt === "string" ? p.lastEventAt : undefined,
    });
  }
  const activity = (Array.isArray(r.activity) ? r.activity : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      at: String(a.at ?? ""),
      kind: String(a.kind ?? "event"),
      text: String(a.text ?? ""),
      tx: typeof a.tx === "string" ? a.tx : undefined,
    }))
    .filter((a) => a.at && a.text);
  return {
    owner,
    account: typeof r.account === "string" ? r.account : undefined,
    positions,
    activity,
    indexedAt: typeof r.indexedAt === "string" ? r.indexedAt : "",
    block: num(r.block),
  };
}

export async function fetchIndexedAccount(baseUrl: string, owner: string, signal?: AbortSignal): Promise<IndexedAccount | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/account/${owner}`, { signal, cache: "no-store" });
  if (!res.ok) return null;
  return normalizeIndexed(await res.json(), owner);
}
