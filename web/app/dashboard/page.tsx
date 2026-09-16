"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { feeBreakdown, shortAddress, type CollateralSymbol, ladderForRecorded } from "@zyo/shared";
import { BASE_CHAIN, BASE_TOKENS, CHAIN_ID } from "@/lib/chain";
import { useAccountRead, useDeployment, useIndexed, useKeeperGrant, useMarket, usePendingVenues, useSession } from "@/lib/hooks";
import { useMode } from "@/lib/mode";
import { DEMO_ACCOUNT, DEMO_ACCOUNT_STATE, DEMO_SNAPSHOT_AT } from "@/lib/demo";
import { accountHf, currentLtvBps, hfBand, liveLiquidationPrice } from "@/lib/math";
import { fromDemo, mergePositions, type PositionView } from "@/lib/positions";
import { buildClaimPlan, buildGrantPlan, buildRevokeAllPlan, buildUnwindPlan, deadlineFromNow, DEFAULT_BAND_TOLERANCE_BPS, type PlannedCall, type QuotedSwap } from "@/lib/plan";
import { grantPoolTokenPricing, grantTokenLimits, poolImpliedUsdPrices, runClaim, runGrant, runRevokeAll, runUnwind, type Emit, type RunContext } from "@/lib/execute";
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
import ZecExitStep from "@/components/ZecExitStep";

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
        return { symbol: c.symbol as CollateralSymbol, amount: c.amount, usd: c.amount * r.priceUsd, ltBps: r.liquidationThresholdBps, priceUsd: r.priceUsd, venue: null, venueKind: "aave" as const };
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
        hf: hf as number | null,
        hasDebt: debtUsd > 0,
        accountUsdc: 0,
        positions: DEMO_ACCOUNT_STATE.positions.map(fromDemo),
        activity: DEMO_ACCOUNT_STATE.activity,
        readAt: market.readAt,
        dataSource: "demo" as const,
        venues: null,
      };
    }
    // One row per holding, whichever venue holds it: the Aave pool's rows carry the market read's
    // threshold; a row from another venue (the Morpho venue after acceptVenue) carries the threshold
    // that venue reports live — its LLTV (audit wave 2, M-HIGH-2).
    const holdings = (account?.collateral ?? []).map((c) => ({
      symbol: c.symbol,
      amount: c.amount,
      usd: c.usd,
      ltBps: c.liquidationThresholdBps ?? market.reserves[c.symbol]?.liquidationThresholdBps ?? 0,
      priceUsd: market.reserves[c.symbol]?.priceUsd ?? NaN,
      venue: c.venue ?? null,
      venueKind: c.venueKind ?? ("aave" as const),
    }));
    const venueAware = !!account?.venues;
    const collateralUsd = venueAware ? holdings.reduce((a, h) => a + h.usd, 0) : (account?.aave?.totalCollateralUsd ?? 0);
    // Debt: the Aave pool's own total plus whatever the other venues report owed, at the USDC price the market read carries.
    const debtUsd = (account?.aave?.totalDebtUsd ?? 0) + (account?.venues?.otherDebtUsdc ?? 0) * (market.reserves.USDC?.priceUsd ?? 1);
    const ltBps = venueAware && collateralUsd > 0 ? Math.round(holdings.reduce((a, h) => a + h.ltBps * h.usd, 0) / collateralUsd) : (account?.aave?.currentLiquidationThresholdBps ?? 0);
    return {
      accountAddr: account?.account ?? null,
      deployed: !!account?.deployed,
      holdings,
      collateralUsd,
      debtUsd,
      ltBps,
      // null = unreadable (no account read, the Aave leg failed, or a venue the registry names could not
      // be read); never +∞ (audit wave 2, N-MED-2). With the registry known this is the WORST venue's HF.
      hf: accountHf(account),
      venues: account?.venues ?? null,
      accountUsdc: account ? Number(account.accountUsdc) / 10 ** BASE_TOKENS.USDC.decimals : 0,
      // Slice A (RISKS §12): a refused `positionsOf` is UNREADABLE — cache rows may show, labelled
      // as cache, and the page says why; it never says "No LP positions".
      positions: mergePositions(account && !account.lpUnreadable ? account.lpPositions : null, indexed),
      lpUnreadable: account?.lpUnreadable ?? null,
      lpDirectOverflow: account?.lpDirectOverflow ?? null,
      // Slice C (RISKS §8): "no debt" is decided by the shared dust threshold on the USDC amounts the
      // read returned, never by a USD figure being exactly zero.
      hasDebt: account ? !account.debtIsDust && debtUsd > 0 : debtUsd > 0,
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
  // The position's ladder (A4, BUILD-PLAN D7): derived from the entry HF the router recorded at the
  // open — the same `ladderFor` the keeper runs — and the floor's when nothing is recorded, said.
  const recordedEntryHf = s.mode === "demo" ? DEMO_ACCOUNT_STATE.entryHf : (account?.entryHf ?? null);
  const { ladder, derived: ladderDerived } = ladderForRecorded(recordedEntryHf);
  const ladderNote = ladderDerived
    ? `derived from this position's recorded entry health factor ${recordedEntryHf!.toFixed(2)}`
    : s.mode === "demo" || !account
      ? "the floor's ladder"
      : account.entryHfStatus === "none"
        ? "no entry health factor is recorded for this account (opened before the record existed), so the keeper runs the floor's ladder"
        : account.entryHfStatus === "unreadable"
          ? "the router did not answer the entry-HF read; the floor's ladder is shown"
          : "no deployment configured; the floor's ladder is shown";
  const band = hfBand(view.hf, ladder);
  const ltvBps = currentLtvBps(view.collateralUsd, view.debtUsd);
  // Audit wave 2, M-HIGH-2: this page and the keeper read every venue the registry names through
  // ICollateralVenue. An asset on a venue that does not answer it is invisible to both, so say so
  // and offer no keeper grant for it.
  const unsupportedVenues = deployment?.unsupportedVenues ?? [];
  const venueSupported = !primary || !unsupportedVenues.includes(primary.symbol);
  // Every token the account's LP positions can pay out on close — what the keeper's grant must budget.
  const livePoolSymbols = [...new Set(view.positions.flatMap((p) => (p.pool ? [p.pool.token0, p.pool.token1] : [])))];
  const livePoolTokens = livePoolSymbols.flatMap((sym) => {
    const t = (BASE_TOKENS as Record<string, { address: Address } | undefined>)[sym];
    return t ? [{ address: t.address, symbol: sym }] : [];
  });
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
        venue: p.venue,
      });
    }
    return buildUnwindPlan({
      account: view.accountAddr,
      positionIds: ids,
      collateral: primary?.symbol ?? "cbBTC",
      deployment,
      deadline: deadlineFromNow(),
      bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS,
      positionVenue: p.venue,
      earlyPenalty: p.earlyPenalty ?? null,
      // How many lending venues hold the collateral right now: one Close returns it from all of
      // them (RISKS §8 "two-book Close", 2026-09-11), and the plain sentence says so when > 1.
      collateralPlaces: new Set((account?.collateral ?? []).map((c) => (c.venueKind === "other" ? (c.venue ?? "other") : "aave"))).size || 1,
      // The swap is quoted live at sign time — until then the plan says so and
      // is NOT signable. There is no fallback minimum.
      quote: lastQuote,
      poolLabel: label,
      // RISKS §8 residual (b): a venue whose price is disputed keeps its collateral — the Close
      // that would withdraw it is refused, with the reason, until the prices agree.
      withdrawRefusedReason: view.venues?.venues.map((v) => v.priceDisagreement).filter((r): r is string => typeof r === "string").join("; ") || null,
    });
  }, [action, view.accountAddr, view.venues, deployment, primary, lastQuote]);

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
      // The re-grant used to carry NO pool-token line, so an LP whose other leg is not the
      // collateral could never be closed by the keeper (audit wave 2, G-HIGH-1). Size every token
      // the account's live positions can pay out, each in its own units.
      let limits: ReturnType<typeof grantTokenLimits>;
      try {
        // A pool token Aave does not list (cbZEC) is sized at its pool's own USDC price (W3-MED-1).
        const implied = await poolImpliedUsdPrices(
          c.read,
          view.positions.flatMap((p) => (p.pool?.poolAddress ? [{ poolAddress: p.pool.poolAddress as Address, token0: p.pool.token0, token1: p.pool.token1 }] : [])),
        );
        limits = grantTokenLimits(view.debtUsd, { address: BASE_TOKENS[sym].address, symbol: sym, decimals: BASE_TOKENS[sym].decimals, priceUsd: r?.priceUsd ?? NaN }, grantPoolTokenPricing(livePoolSymbols, market, implied));
      } catch (e) {
        emit({ type: "blocked", step: 1, reason: `The keeper permission was not built: ${(e as Error).message}` });
        return null;
      }
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
          venue: p.venue,
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
      { account: view.accountAddr, positionIds: ids, collateral: primary?.symbol ?? "cbBTC", deployment, deadline: deadlineFromNow(), bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS, poolLabel: p.pool ? `${p.pool.token0}/${p.pool.token1}` : undefined, positionVenue: p.venue, earlyPenalty: p.earlyPenalty ?? null },
      { enginePoolId: p.enginePoolId, poolAddress: p.pool.poolAddress as Address, venue: p.venue },
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

      {unsupportedVenues.length > 0 && (
        <div className="note note-crit" role="alert" data-testid="unsupported-venue">
          <b className="text-oil-ink">This app cannot see positions on the current lending contract for {unsupportedVenues.join(", ")}.</b> Oilskin&rsquo;s registry points{" "}
          {unsupportedVenues.length === 1 ? "that asset" : "those assets"} at a venue that does not answer the venue interface this dashboard and the Oilskin keeper read, so a position
          opened there does not appear here, no rung fires for it, and no keeper permission protects it. Do not open a new position against {unsupportedVenues.join(" or ")} from this app until
          it is updated; anything you already hold you can still repay or close from your own account.
        </div>
      )}

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
          <NotifyBanner hf={view.hf} collateral={primary?.symbol ?? "your collateral"} ladder={ladder} />

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 lg:grid-cols-4">
            <StatTile label="Net value" value={fmtUsd0(netValue)} sub={`collateral ${fmtUsd0(view.collateralUsd)} + LP ${fmtUsd0(lpValue)}${view.accountUsdc > 0 ? ` + USDC ${fmtUsd0(view.accountUsdc)}` : ""} − debt ${fmtUsd0(view.debtUsd)}`} hint="Collateral + LP value + USDC held − debt. What a full unwind returns before exit costs." testId="tile-net" />
            <StatTile label="Health factor" value={fmtHf(view.hf)} sub={band.label} tone={band.kind} hint="Read from every lending venue Oilskin's registry names for your collateral; the worst one is shown. Liquidation at 1.0." testId="tile-hf" />
            <StatTile label="Borrowed" value={`${fmtUsd0(view.debtUsd)}`} sub={view.hasDebt ? `USDC · ${fmtPct(ltvBps / 100, 1)} LTV · ${fmtPct(market.usdcBorrowAprPct)} variable` : "no debt"} testId="tile-debt" />
            <StatTile label="Claimable rewards" value={fmtUsd(claimable.net)} sub={`${fmtUsd(claimable.gross)} accrued − ${fmtUsd(claimable.performanceFee)} fee`} hint="AERO emissions accrued by your engine positions, net of the performance fee. Claimed to your wallet." testId="tile-claim" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <div className="card p-5">
                <HealthBand hf={view.hf} priceUsd={primary?.priceUsd ?? 0} liquidationPriceUsd={liqPrice} symbol={primary?.symbol ?? "collateral"} ladder={ladder} ladderNote={ladderNote} />
                <div className="num mt-3 flex flex-wrap justify-between gap-2 text-[13px] text-oil-ink2">
                  <span>
                    {view.hasDebt ? (
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
                  {primary && view.hasDebt && (
                    <span>
                      Liquidation at <b className="text-status-crit">{fmtUsd0(liqPrice)}</b> · {primary.symbol} now <b className="text-oil-ink">{fmtUsd0(primary.priceUsd)}</b>
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11.5px] text-oil-ink3">
                  {source === "live"
                    ? view.venues
                      ? `Threshold, price and HF read from ${view.venues.venues.length} lending venue${view.venues.venues.length === 1 ? "" : "s"} the registry names (${view.venues.venues.map((v) => (v.kind === "aave" ? "Aave v3" : `venue ${shortAddress(v.venue)}`)).join(", ")})`
                      : "Threshold, price and HF read from Aave v3 on Base"
                    : `Snapshot ${market.readAt.slice(0, 10)}`}
                  ; venue LT {view.holdings.map((h) => `${h.symbol} ${fmtPct(h.ltBps / 100, 0)}`).join(", ") || "—"}. Anything you can do from the account, the keeper can only do within your grant.
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
                  {/* Door 1's destination step, at the end of an unwind and nowhere else — the USDC
                      is in the user's own account by then, so this is a choice about money already
                      withdrawn rather than a step in the flow. It renders NOTHING while
                      NEXT_PUBLIC_ZEC_EXIT_ENABLED is off, which is how it ships today
                      (docs/ZEC-FORMS-AND-DOORS-2026-09-15.md §6). */}
                  {action.kind === "unwind" && (
                    <div className="mt-4">
                      <ZecExitStep />
                    </div>
                  )}
                </div>
              )}

              <KeeperPanel
                grant={grant}
                deployment={deployment}
                collateral={primary?.symbol ?? "your collateral"}
                nowSeconds={nowSeconds}
                onGrant={s.mode === "live" && venueSupported ? () => setAction({ kind: "grant" }) : undefined}
                onRevoke={s.mode === "live" ? () => setAction({ kind: "revoke" }) : undefined}
                busy={!!action}
                venueSupported={venueSupported}
                livePoolTokens={livePoolTokens}
                ladder={ladder}
              />

              <div className="flex items-baseline justify-between">
                <h2 className="text-[17px]">Positions</h2>
                <span className="text-[11.5px] text-oil-ink3">{view.lpUnreadable ? "positions unreadable" : `${view.positions.length} engine position${view.positions.length === 1 ? "" : "s"}`}</span>
              </div>
              {view.lpUnreadable && (
                <div className="card p-5 text-[13.5px]" role="alert">
                  <div className="font-semibold">Positions could not be read.</div>
                  <p className="mt-1 text-oil-ink3">{view.lpUnreadable}. The keeper reads the same list and does not act on it either. You can still close a position by its id from your account.</p>
                </div>
              )}
              {view.lpDirectOverflow && view.lpDirectOverflow.held > view.lpDirectOverflow.scanned && (
                <p className="mt-1 text-[12.5px] text-oil-ink3" data-testid="lp-direct-overflow">
                  Your account holds {view.lpDirectOverflow.held} unstaked Aerodrome Slipstream tokens; only the first {view.lpDirectOverflow.scanned} are listed. Every position you staked through Oilskin is shown; the rest may have been sent by someone else.
                </p>
              )}
              {view.positions.length === 0 && !view.lpUnreadable && <div className="card p-8 text-center text-[13.5px] text-oil-ink3">No LP positions under this account.</div>}
              {view.positions.map((p) => (
                <PositionCard key={p.id} p={p} advanced={mode === "advanced"} onClaim={(pos) => setAction({ kind: "claim", position: pos })} onUnwind={(pos) => setAction({ kind: "unwind", position: pos })} busy={!!action} />
              ))}

              {view.holdings.length > 0 && (
                <div className="card p-5">
                  <h3 className="text-[15px]">Collateral (under your account)</h3>
                  <ul className="num mt-2 space-y-1 text-[13.5px]">
                    {view.holdings.map((h) => (
                      <li key={`${h.symbol}-${h.venue ?? "aave"}`} className="flex justify-between">
                        <span>
                          {fmtAmount(h.amount, 8)} {h.symbol}{" "}
                          <span className="text-oil-ink3">
                            · LT {fmtPct(h.ltBps / 100, 0)} · {h.venueKind === "aave" ? "Aave v3" : `venue ${h.venue ? shortAddress(h.venue) : "?"}`}
                          </span>
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
                    <dt className="text-oil-ink3">account data</dt>
                    <dd>
                      collateral {fmtUsd(view.collateralUsd)} · debt {fmtUsd(view.debtUsd)} · blended LT {view.ltBps} bps · HF {fmtHf(view.hf)}
                    </dd>
                    <dt className="text-oil-ink3">venues (ICollateralVenue)</dt>
                    <dd data-testid="raw-venues">
                      {view.venues
                        ? view.venues.venues.length
                          ? view.venues.venues
                              .map((v) => `${shortAddress(v.venue)} ${v.kind}${v.current ? "" : " (previous)"} · HF ${v.readable ? fmtHf(v.healthFactor) : "unreadable"} · debt ${v.debtUsdc === null ? "unreadable" : `${fmtAmount(v.debtUsdc, 2)} USDC`}`)
                              .join(" ; ")
                          : "registry names no venue"
                        : "registry unknown — Aave pool only"}
                      {view.venues?.unreadableReason ? ` — ${view.venues.unreadableReason}` : ""}
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
