"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { BASE_CHAIN, BASE_TOKENS, CHAIN_ID, COLLATERAL_ASSETS, feeBreakdown, shortAddress, type CollateralSymbol } from "@zyo/shared";
import { useAccountRead, useDeployment, useIndexed, useKeeperGrant, useMarket, usePendingVenues, useSession } from "@/lib/hooks";
import { useMode } from "@/lib/mode";
import { DEMO_ACCOUNT, DEMO_ACCOUNT_STATE, DEMO_SNAPSHOT_AT } from "@/lib/demo";
import { currentLtvBps, hfBand, liveLiquidationPrice } from "@/lib/math";
import { fromDemo, mergePositions, type PositionView } from "@/lib/positions";
import { buildClaimPlan, buildGrantPlan, buildRevokeAllPlan, buildUnwindPlan, deadlineFromNow, DEFAULT_BAND_TOLERANCE_BPS, type PlannedCall, type QuotedSwap } from "@/lib/plan";
import { grantTokenLimits, runClaim, runGrant, runRevokeAll, runUnwind, type Emit, type RunContext } from "@/lib/execute";
import { fmtAgo, fmtAmount, fmtHf, fmtPct, fmtUsd, fmtUsd0 } from "@/lib/format";
import StatTile from "@/components/StatTile";
import HealthBand from "@/components/HealthBand";
import NotifyBanner from "@/components/NotifyBanner";
import PositionCard from "@/components/PositionCard";
import ActivityRail from "@/components/ActivityRail";
import Disclosures from "@/components/Disclosures";
import Chip from "@/components/Chip";
import SignStep from "@/components/wizard/SignStep";
import KeeperPanel from "@/components/KeeperPanel";

const ACTION_TITLE = { claim: "Claim rewards", unwind: "Unwind position", grant: "Keeper protection", revoke: "Revoke every permission" } as const;
const ACTION_DONE_TITLE = { claim: "Rewards sent to your wallet", unwind: "Position closed", grant: "Keeper protection granted", revoke: "Every permission revoked" } as const;
const ACTION_DONE_BODY = {
  claim: "The AERO rewards were collected into your Oilskin account, the performance fee came off, and the rest was moved to your wallet. If the engine had already re-numbered one of your positions, that id is reported and skipped rather than failing the whole thing — check the position list and claim again if a reward is still showing.",
  unwind: "The LP position was closed, the loan repaid and your collateral returned to your wallet. Your Oilskin account stays yours for next time.",
  grant: "The Oilskin keeper may now reduce or close this position for you, within the daily budgets shown, until the expiry date shown. You can revoke it at any time.",
  revoke: "Every permission on your Oilskin account is cancelled. Nobody but your own wallet can make it do anything — which also means nobody will act for you if your health factor falls.",
} as const;

type Action =
  | { kind: "claim" | "unwind"; position: PositionView }
  | { kind: "grant" | "revoke"; position?: undefined }
  | null;

export default function DashboardPage() {
  const s = useSession();
  const { mode } = useMode();
  const { market, source } = useMarket();
  const { deployment } = useDeployment();
  const { account, loading, refetch } = useAccountRead(market);
  const indexed = useIndexed(s.mode === "live" ? s.address : undefined, s.mode === "live");
  const [action, setAction] = useState<Action>(null);
  const [lastQuote, setLastQuote] = useState<QuotedSwap | null>(null);
  const { grant, refetch: refetchGrant } = useKeeperGrant(s.mode === "demo" ? DEMO_ACCOUNT : (account?.account ?? null), deployment);
  const pendingVenues = usePendingVenues(deployment);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  // ---- Assemble the view: demo state or chain (+ cache) ----
  const view = useMemo(() => {
    if (s.mode === "demo") {
      const holdings = DEMO_ACCOUNT_STATE.collateral.map((c) => {
        const r = market.reserves[c.symbol]!;
        return { symbol: c.symbol as CollateralSymbol, amount: c.amount, usd: c.amount * r.priceUsd, ltBps: r.liquidationThresholdBps, priceUsd: r.priceUsd };
      });
      const collateralUsd = holdings.reduce((a, h) => a + h.usd, 0);
      const debtUsd = DEMO_ACCOUNT_STATE.debtUsdc;
      const ltBps = holdings.length ? Math.round(holdings.reduce((a, h) => a + h.ltBps * h.usd, 0) / collateralUsd) : 0;
      const hf = debtUsd > 0 ? ((collateralUsd * ltBps) / 10_000) / debtUsd : Number.POSITIVE_INFINITY;
      return {
        accountAddr: DEMO_ACCOUNT as Address,
        deployed: true,
        holdings,
        collateralUsd,
        debtUsd,
        ltBps,
        hf,
        accountUsdc: 0,
        positions: DEMO_ACCOUNT_STATE.positions.map(fromDemo),
        activity: DEMO_ACCOUNT_STATE.activity,
        readAt: market.readAt,
        dataSource: "demo" as const,
      };
    }
    const holdings = (account?.collateral ?? []).map((c) => ({
      symbol: c.symbol,
      amount: c.amount,
      usd: c.usd,
      ltBps: market.reserves[c.symbol]?.liquidationThresholdBps ?? 0,
      priceUsd: market.reserves[c.symbol]?.priceUsd ?? NaN,
    }));
    return {
      accountAddr: account?.account ?? null,
      deployed: !!account?.deployed,
      holdings,
      collateralUsd: account?.aave?.totalCollateralUsd ?? 0,
      debtUsd: account?.aave?.totalDebtUsd ?? 0,
      ltBps: account?.aave?.currentLiquidationThresholdBps ?? 0,
      hf: account?.aave?.healthFactor ?? Number.POSITIVE_INFINITY,
      accountUsdc: account ? Number(account.accountUsdc) / 10 ** BASE_TOKENS.USDC.decimals : 0,
      positions: mergePositions(account ? account.lpPositions : null, indexed),
      activity: indexed?.activity ?? [],
      readAt: account?.readAt ?? "",
      dataSource: account ? ("chain" as const) : indexed ? ("cache" as const) : ("chain" as const),
    };
  }, [s.mode, market, account, indexed]);

  const primary = view.holdings[0];
  const liqPrice = primary ? liveLiquidationPrice(view.collateralUsd, view.debtUsd, view.ltBps, primary.priceUsd) : 0;
  const lpValue = view.positions.reduce((a, p) => a + (p.valueUsd ?? 0), 0);
  const claimableGross = view.positions.reduce((a, p) => a + (p.accruedRewardsUsd ?? 0), 0);
  const claimable = feeBreakdown(claimableGross);
  const netValue = view.collateralUsd + lpValue + view.accountUsdc - view.debtUsd;
  const band = hfBand(view.hf);
  const ltvBps = currentLtvBps(view.collateralUsd, view.debtUsd);
  const empty = s.mode === "live" && !loading && (!account || !account.deployed);
  // Demo mode pins "now" to the snapshot so the grant's remaining days never drift.
  const nowSeconds = s.mode === "demo" ? Math.floor(Date.parse(DEMO_SNAPSHOT_AT) / 1000) : Math.floor(Date.now() / 1000);

  // ---- Action plans (claim / unwind) ----
  const actionPlan: PlannedCall[] = useMemo(() => {
    if (!action) return [];
    if (action.kind === "grant") return buildGrantPlan({ deployment, account: view.accountAddr, collateral: primary?.symbol ?? "cbBTC", nowSeconds: Math.floor(Date.now() / 1000) });
    if (action.kind === "revoke") return buildRevokeAllPlan({ account: view.accountAddr, deployment });
    const p = action.position!;
    const ids = p.positionId !== undefined ? [p.positionId] : [];
    const label = p.pool ? `${p.pool.token0}/${p.pool.token1}` : "the position";
    if (action.kind === "claim") {
      const tokens = [BASE_TOKENS.AERO, ...(p.pool ? [BASE_TOKENS[p.pool.token0 as keyof typeof BASE_TOKENS], BASE_TOKENS[p.pool.token1 as keyof typeof BASE_TOKENS]] : [])].filter(Boolean);
      return buildClaimPlan({
        account: view.accountAddr,
        positionIds: ids,
        sweepTokens: tokens.map((t) => ({ symbol: t.symbol, address: t.address })),
        deployment,
        deadline: deadlineFromNow(),
        bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS,
        poolLabel: label,
      });
    }
    return buildUnwindPlan({
      account: view.accountAddr,
      positionIds: ids,
      collateral: primary?.symbol ?? "cbBTC",
      deployment,
      deadline: deadlineFromNow(),
      bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS,
      // The swap is quoted live at sign time — until then the plan says so and
      // is NOT signable. There is no fallback minimum.
      quote: lastQuote,
      poolLabel: label,
    });
  }, [action, view.accountAddr, deployment, primary, lastQuote]);

  const ctx = (): RunContext | null =>
    publicClient
      ? {
          wallet: {
            chainId: s.chainId,
            writeContract: (spec) => writeContractAsync({ address: spec.address, abi: spec.abi as never, functionName: spec.functionName, args: spec.args as never, chainId: CHAIN_ID }),
            signTypedData: (td) => signTypedDataAsync(td as never),
            waitForReceipt: async (hash) => ({ status: (await publicClient.waitForTransactionReceipt({ hash })).status }),
          },
          read: publicClient as never,
          gas: publicClient as never,
          owner: s.address,
          ethPriceUsd: market.reserves.WETH?.priceUsd ?? null,
          nowSeconds: () => Math.floor(Date.now() / 1000),
        }
      : null;

  const runAction = async (emit: Emit) => {
    const c = ctx();
    if (!action || !c || !view.accountAddr || !deployment) return null;

    if (action.kind === "revoke") {
      const hash = await runRevokeAll(c, view.accountAddr, emit);
      if (hash) refetchGrant();
      return hash ? { account: view.accountAddr } : null;
    }
    if (action.kind === "grant") {
      const sym = primary?.symbol ?? "cbBTC";
      const r = market.reserves[sym];
      const limits = grantTokenLimits(view.debtUsd, { address: BASE_TOKENS[sym].address, decimals: BASE_TOKENS[sym].decimals, priceUsd: r?.priceUsd ?? NaN }, []);
      const hash = await runGrant(c, { account: view.accountAddr, deployment, tokenLimits: limits }, emit);
      if (hash) refetchGrant();
      return hash ? { account: view.accountAddr } : null;
    }

    const p = action.position!;
    const ids = p.positionId !== undefined ? [p.positionId] : [];
    if (action.kind === "claim") {
      const tokens = [BASE_TOKENS.AERO, ...(p.pool ? [BASE_TOKENS[p.pool.token0 as keyof typeof BASE_TOKENS], BASE_TOKENS[p.pool.token1 as keyof typeof BASE_TOKENS]] : [])].filter(Boolean);
      const hash = await runClaim(
        c,
        {
          account: view.accountAddr,
          positionIds: ids,
          sweepTokens: tokens.map((t) => ({ symbol: t.symbol, address: t.address })),
          deployment,
          deadline: deadlineFromNow(),
          bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS,
          poolLabel: p.pool ? `${p.pool.token0}/${p.pool.token1}` : undefined,
        },
        p.enginePoolId ?? null,
        emit,
      );
      if (hash) refetch();
      return hash ? { account: view.accountAddr } : null;
    }
    if (!p.enginePoolId || !p.pool?.poolAddress) return null;
    const hash = await runUnwind(
      c,
      { account: view.accountAddr, positionIds: ids, collateral: primary?.symbol ?? "cbBTC", deployment, deadline: deadlineFromNow(), bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS, poolLabel: p.pool ? `${p.pool.token0}/${p.pool.token1}` : undefined },
      { enginePoolId: p.enginePoolId, poolAddress: p.pool.poolAddress as Address },
      emit,
      setLastQuote,
    );
    if (hash) refetch();
    return hash ? { account: view.accountAddr } : null;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px]">{s.mode === "demo" ? "Demo dashboard" : "Your positions"}</h1>
          <div className="mono mt-1 flex flex-wrap items-center gap-2 text-oil-ink3">
            <span>
              your wallet <span className="text-oil-ink2">{shortAddress(s.address)}</span>
            </span>
            {view.accountAddr && (
              <span>
                · your Oilskin account{" "}
                <a className="text-brass" href={`${BASE_CHAIN.explorerUrl}/address/${view.accountAddr}`} target="_blank" rel="noreferrer" data-testid="account-link">
                  {shortAddress(view.accountAddr)}
                </a>
              </span>
            )}
            {s.mode === "demo" && <Chip kind="mute">demo</Chip>}
            {s.mode === "live" && <Chip kind={view.dataSource === "chain" ? "good" : "info"}>{view.dataSource === "chain" ? "read from chain" : "indexer cache"}</Chip>}
            {view.readAt && <span>· {loading ? "refreshing…" : s.mode === "demo" ? `snapshot ${view.readAt.slice(0, 10)}` : `updated ${fmtAgo(view.readAt)}`}</span>}
          </div>
        </div>
        <Link href="/new" className="btn-brass">
          New position
        </Link>
      </div>

      {pendingVenues.length > 0 && (
        <div className="note note-warn" role="alert" data-testid="pending-venue">
          <b className="text-oil-ink">A lending contract change has been announced.</b> Oilskin&rsquo;s registry owner has proposed moving{" "}
          {pendingVenues.map((p) => `${p.asset} to ${p.proposedVenue.slice(0, 6)}…${p.proposedVenue.slice(-4)} on ${new Date(p.eta * 1000).toISOString().slice(0, 10)}`).join("; ")}. The delay is fixed on chain and the change is
          announced before it can take effect, but it is a warning, not a prohibition: if you do not want to be in the new contract, close the position or revoke your keeper permission before that date.
        </div>
      )}

      {empty ? (
        <div className="card p-10 text-center">
          <p className="text-oil-ink2">No Oilskin account for this wallet yet{account?.account ? ` (it will be created at ${shortAddress(account.account)} when you open your first position)` : ""}.</p>
          <Link href="/new" className="btn-brass mt-4 inline-flex">
            Open your first position
          </Link>
        </div>
      ) : (
        <>
          <NotifyBanner hf={view.hf} collateral={primary?.symbol ?? "your collateral"} />

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 lg:grid-cols-4">
            <StatTile label="Net value" value={fmtUsd0(netValue)} sub={`collateral ${fmtUsd0(view.collateralUsd)} + LP ${fmtUsd0(lpValue)}${view.accountUsdc > 0 ? ` + USDC ${fmtUsd0(view.accountUsdc)}` : ""} − debt ${fmtUsd0(view.debtUsd)}`} hint="Collateral + LP value + USDC held − debt. What a full unwind returns before exit costs." testId="tile-net" />
            <StatTile label="Health factor" value={fmtHf(view.hf)} sub={band.label} tone={band.kind} hint="Aave account health, read from the pool. Liquidation at 1.0." testId="tile-hf" />
            <StatTile label="Borrowed" value={`${fmtUsd0(view.debtUsd)}`} sub={view.debtUsd > 0 ? `USDC · ${fmtPct(ltvBps / 100, 1)} LTV · ${fmtPct(market.usdcBorrowAprPct)} variable` : "no debt"} testId="tile-debt" />
            <StatTile label="Claimable rewards" value={fmtUsd(claimable.net)} sub={`${fmtUsd(claimable.gross)} accrued − ${fmtUsd(claimable.performanceFee)} fee`} hint="AERO emissions accrued by your engine positions, net of the performance fee. Claimed to your wallet." testId="tile-claim" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <div className="card p-5">
                <HealthBand hf={view.hf} priceUsd={primary?.priceUsd ?? 0} liquidationPriceUsd={liqPrice} symbol={primary?.symbol ?? "collateral"} />
                <div className="num mt-3 flex flex-wrap justify-between gap-2 text-[13px] text-oil-ink2">
                  <span>
                    {view.debtUsd > 0 ? (
                      <>
                        Borrowed <b className="text-oil-ink">{fmtUsd(view.debtUsd)} USDC</b> against{" "}
                        {view.holdings.map((h) => (
                          <b key={h.symbol} className="text-oil-ink">
                            {fmtAmount(h.amount, 6)} {h.symbol}{" "}
                          </b>
                        ))}
                        ({fmtUsd0(view.collateralUsd)}) · {fmtPct(ltvBps / 100, 1)} LTV · account threshold {fmtPct(view.ltBps / 100, 1)}
                      </>
                    ) : (
                      <>No borrow against {fmtUsd0(view.collateralUsd)} of collateral.</>
                    )}
                  </span>
                  {primary && view.debtUsd > 0 && (
                    <span>
                      Liquidation at <b className="text-status-crit">{fmtUsd0(liqPrice)}</b> · {primary.symbol} now <b className="text-oil-ink">{fmtUsd0(primary.priceUsd)}</b>
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11.5px] text-oil-ink3">
                  {source === "live" ? "Threshold, price and HF read from Aave v3 on Base" : `Snapshot ${market.readAt.slice(0, 10)}`}; registry LT {view.holdings.map((h) => `${h.symbol} ${fmtPct(h.ltBps / 100, 0)}`).join(", ") || "—"}. Anything you can do from the account, the keeper can only do within your grant.
                </p>
              </div>

              {action && (
                <div className="card border-brass/40 p-5" data-testid="action-panel">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-[17px]">{ACTION_TITLE[action.kind]}</h2>
                    <button className="btn-quiet" onClick={() => setAction(null)} aria-label="Close">
                      ✕
                    </button>
                  </div>
                  <SignStep
                    key={`${action.kind}-${action.position?.id ?? "account"}`}
                    calls={actionPlan}
                    mode={s.mode}
                    flowKind={action.kind}
                    summary={action.position ? `${action.kind} ${action.position.pool ? `${action.position.pool.token0}/${action.position.pool.token1}` : action.position.poolId}` : `${action.kind} keeper permission`}
                    owner={s.address}
                    demoAccount={DEMO_ACCOUNT}
                    run={runAction}
                    doneTitle={ACTION_DONE_TITLE[action.kind]}
                    doneBody={ACTION_DONE_BODY[action.kind]}
                  />
                </div>
              )}

              <KeeperPanel
                grant={grant}
                deployment={deployment}
                collateral={primary?.symbol ?? "your collateral"}
                nowSeconds={nowSeconds}
                onGrant={s.mode === "live" ? () => setAction({ kind: "grant" }) : undefined}
                onRevoke={s.mode === "live" ? () => setAction({ kind: "revoke" }) : undefined}
                busy={!!action}
              />

              <div className="flex items-baseline justify-between">
                <h2 className="text-[17px]">Positions</h2>
                <span className="text-[11.5px] text-oil-ink3">{view.positions.length} engine position{view.positions.length === 1 ? "" : "s"}</span>
              </div>
              {view.positions.length === 0 && <div className="card p-8 text-center text-[13.5px] text-oil-ink3">No LP positions under this account.</div>}
              {view.positions.map((p) => (
                <PositionCard key={p.id} p={p} advanced={mode === "advanced"} onClaim={(pos) => setAction({ kind: "claim", position: pos })} onUnwind={(pos) => setAction({ kind: "unwind", position: pos })} busy={!!action} />
              ))}

              {view.holdings.length > 0 && (
                <div className="card p-5">
                  <h3 className="text-[15px]">Collateral on Aave (under your account)</h3>
                  <ul className="num mt-2 space-y-1 text-[13.5px]">
                    {view.holdings.map((h) => (
                      <li key={h.symbol} className="flex justify-between">
                        <span>
                          {fmtAmount(h.amount, 8)} {h.symbol} <span className="text-oil-ink3">· LT {fmtPct(h.ltBps / 100, 0)} · {COLLATERAL_ASSETS[h.symbol].venue}</span>
                        </span>
                        <span>{fmtUsd(h.usd)}</span>
                      </li>
                    ))}
                    {view.accountUsdc > 0 && (
                      <li className="flex justify-between">
                        <span>
                          {fmtAmount(view.accountUsdc, 2)} USDC <span className="text-oil-ink3">· held in your account (not deployed)</span>
                        </span>
                        <span>{fmtUsd(view.accountUsdc)}</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {mode === "advanced" && (
                <div className="card p-5" data-testid="raw-account">
                  <h3 className="text-[15px]">Raw account data</h3>
                  <dl className="mono mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-oil-ink2">
                    <dt className="text-oil-ink3">wallet</dt>
                    <dd>{s.address}</dd>
                    <dt className="text-oil-ink3">Oilskin account</dt>
                    <dd>{view.accountAddr ?? "—"}</dd>
                    <dt className="text-oil-ink3">factory / router</dt>
                    <dd>{deployment ? `${deployment.factory} / ${deployment.router}${deployment.demo ? " (demo)" : ""}` : "not configured"}</dd>
                    <dt className="text-oil-ink3">registry / LP venue / Aave venue / engine</dt>
                    <dd>{deployment ? `${deployment.registry} / ${deployment.lpVenue} / ${deployment.aaveVenue} / ${deployment.engine}` : "—"}</dd>
                    <dt className="text-oil-ink3">Aave account data</dt>
                    <dd>
                      collateral {fmtUsd(view.collateralUsd)} · debt {fmtUsd(view.debtUsd)} · current LT {view.ltBps} bps · HF {fmtHf(view.hf)}
                    </dd>
                    <dt className="text-oil-ink3">keeper</dt>
                    <dd>{deployment?.keeper ?? "not configured"} — grants are revocable from your account (revokeAll)</dd>
                  </dl>
                </div>
              )}

              <Disclosures scope="dashboard" />
            </div>
            <ActivityRail items={view.activity} source={s.mode === "demo" ? "demo" : view.activity.length ? "cache" : "chain"} />
          </div>
        </>
      )}
    </div>
  );
}
