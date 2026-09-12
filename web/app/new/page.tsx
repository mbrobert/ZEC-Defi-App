"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { ENTRY_HF_FLOOR, isCollateralSymbol, lpPoolId, type CollateralSymbol } from "@zyo/shared";
import { BASE_TOKENS, CHAIN_ID, COLLATERAL_ASSETS } from "@/lib/chain";
import { useAccountRead, useDeployment, useForecast, useGate, useMarket, useSession } from "@/lib/hooks";
import { gateForDeployment } from "@/lib/gate";
import { useMode } from "@/lib/mode";
import { fromAtomic } from "@/lib/math";
import { buildOpenPlan, deadlineFromNow, type OpenPlanInput } from "@/lib/plan";
import { grantPoolTokenPricing, grantTokenLimits, poolImpliedUsdPrices, runOpen, type Emit } from "@/lib/execute";
import { WIZARD_STEPS, clampEntryHf, defaultWizardState, deriveReview, hfBoundsFor, needsHfAcknowledgment, type WizardState } from "@/lib/wizard";
import { DEMO_ACCOUNT } from "@/lib/demo";
import { fmtUsd } from "@/lib/format";
import Steps from "@/components/Steps";
import CollateralStep from "@/components/wizard/CollateralStep";
import SettingStep from "@/components/wizard/SettingStep";
import StrategyStep from "@/components/wizard/StrategyStep";
import ReviewStep from "@/components/wizard/ReviewStep";
import SignStep from "@/components/wizard/SignStep";

export default function NewPositionPage() {
  return (
    <Suspense fallback={null}>
      <Wizard />
    </Suspense>
  );
}

function Wizard() {
  const params = useSearchParams();
  const initial = params.get("collateral");
  const s = useSession();
  const { mode } = useMode();
  const { market, source } = useMarket();
  const { gate: servedGate } = useGate();
  const { deployment } = useDeployment();
  // W3-LOW-3: a direct-venue pool is only offered where the deployment has the direct venue.
  const gate = useMemo(() => gateForDeployment(servedGate, deployment), [servedGate, deployment]);
  const { account } = useAccountRead(market);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(() => defaultWizardState(isCollateralSymbol(initial) && COLLATERAL_ASSETS[initial].enabled ? initial : "cbBTC"));
  const [deadline, setDeadline] = useState(() => deadlineFromNow());
  const patch = (p: Partial<WizardState>) => setState((st) => ({ ...st, ...p }));

  // The registry's entry floor, read from the deployment (the shared constant in demo mode): the slider's minimum.
  const floor = deployment?.entryHfFloor ?? ENTRY_HF_FLOOR;
  const bounds = useMemo(() => hfBoundsFor(market, state.collateral, floor), [market, state.collateral, floor]);

  // If the live read says the chosen asset is unusable, fall back to the first usable one.
  useEffect(() => {
    if (!bounds) {
      const usable = (["cbBTC", "WETH"] as CollateralSymbol[]).find((c) => hfBoundsFor(market, c, floor));
      if (usable && usable !== state.collateral) setState((st) => ({ ...st, collateral: usable }));
    }
  }, [market, state.collateral, bounds, floor]);

  // The HF the position is priced at: the chosen one, pulled up to the asset's offered minimum when it
  // sits under it (the Sheltered mark on an asset whose cap binds above it). Applied at read time, not
  // written into state, so a switch of collateral re-derives it and a chosen 1.95 survives the switch.
  const effective = useMemo<WizardState>(() => (bounds ? { ...state, entryHf: clampEntryHf(state.entryHf, bounds) } : state), [state, bounds]);
  // The sub-mark acknowledgment names the collateral and its drawdown: a change of either voids it.
  useEffect(() => {
    setState((st) => (st.hfAcknowledged ? { ...st, hfAcknowledged: false } : st));
  }, [state.collateral, state.amount]);

  // Simple mode never carries Advanced overrides.
  useEffect(() => {
    if (mode === "simple" && (state.customWidthBps !== null || state.customDelayHours !== null || !state.keeperProtection)) {
      setState((st) => ({ ...st, customWidthBps: null, customDelayHours: null, keeperProtection: true, bandToleranceBps: defaultWizardState().bandToleranceBps }));
    }
  }, [mode, state.customWidthBps, state.customDelayHours, state.keeperProtection]);

  // The forecast at THIS position: the chosen entry HF and the deposit's USD value (live mode asks
  // the service for the rate after this borrow; demo mode serves the snapshot at the floor).
  const depositUsdForQuery = (Number(state.amount) || 0) * (market.reserves[state.collateral]?.priceUsd ?? 0);
  const { forecast: servedForecast } = useForecast({
    collateral: state.collateral,
    entryHf: Number.isFinite(effective.entryHf) ? Math.round(effective.entryHf * 1e4) / 1e4 : undefined,
    depositUsd: depositUsdForQuery > 0 ? depositUsdForQuery : undefined,
  });
  // W3-LOW-3 again: a direct-venue pool is only openable where the deployment has the direct venue.
  const forecast = useMemo(
    () => (deployment?.lpVenueDirect ? servedForecast : { ...servedForecast, cells: servedForecast.cells.filter((c) => c.pool.protocol !== "DIRECT") }),
    [servedForecast, deployment]
  );
  const review = useMemo(() => deriveReview(effective, market, gate, forecast, floor), [effective, market, gate, forecast, floor]);

  // The acknowledgment names THIS position's numbers; any change to them un-ticks it.
  const ackKey = `${state.collateral}|${state.amount}|${effective.entryHf}|${state.strategy?.kind ?? ""}|${state.strategy?.kind === "lp" ? `${state.strategy.entry.poolId}/${state.strategy.entry.setting}` : ""}|${state.customWidthBps ?? ""}|${state.customDelayHours ?? ""}`;
  const [ackFor, setAckFor] = useState<string | null>(null);
  useEffect(() => {
    if (state.acknowledged && ackFor !== ackKey) setState((st) => ({ ...st, acknowledged: false }));
  }, [ackKey, ackFor, state.acknowledged]);
  const acknowledge = (v: boolean) => {
    setAckFor(v ? ackKey : null);
    setState((st) => ({ ...st, acknowledged: v }));
  };

  const balance = useMemo(() => {
    const raw = account?.walletBalances[state.collateral];
    return raw === undefined ? undefined : fromAtomic(raw, COLLATERAL_ASSETS[state.collateral].decimals);
  }, [account, state.collateral]);

  const predictedAccount: Address | null = s.mode === "demo" ? DEMO_ACCOUNT : (account?.account ?? null);

  const planInput = useMemo<OpenPlanInput | null>(() => {
    if (!review) return null;
    const lp = state.strategy?.kind === "lp" ? state.strategy.entry : null;
    return {
      owner: s.address,
      strategy: lp ? "lp" : "hold",
      accountDeployed: s.mode === "demo" ? false : !!account?.deployed,
      predictedAccount,
      collateral: state.collateral,
      collateralAmount: state.amount || "0",
      borrowUsdc: review.loan.borrowUsdc,
      // The engine's bytes32, or the pool address padded for a pool held on the direct venue.
      enginePoolId: lp ? lpPoolId(lp.pool) : undefined,
      poolVenue: lp ? (lp.pool.protocol === "DIRECT" ? "direct" : "engine") : undefined,
      poolLabel: lp ? `${lp.pool.token0}/${lp.pool.token1}` : undefined,
      lpParams: review.lpParams ?? { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true },
      deployment,
      deadline,
      bandToleranceBps: state.bandToleranceBps,
      // Audit wave 2, M-HIGH-2: never ask for a keeper permission the keeper cannot honour.
      keeperProtection: state.keeperProtection && !(deployment?.unsupportedVenues ?? []).includes(state.collateral),
      entryHf: review.loan.entryHf,
    };
  }, [review, s.address, s.mode, account, predictedAccount, state, deployment, deadline]);

  const calls = useMemo(() => {
    if (!planInput) return [];
    try {
      return buildOpenPlan(planInput);
    } catch {
      return [];
    }
  }, [planInput]);

  const canNext = (): boolean => {
    switch (step) {
      case 0:
        return !!bounds && Number(state.amount) > 0 && !s.wrongNetwork;
      case 1:
        // A finite HF at or above the offered minimum, acknowledged when it is under the Sheltered mark.
        return !!bounds && Number.isFinite(effective.entryHf) && effective.entryHf >= bounds.minHf - 1e-9 && (!needsHfAcknowledgment(effective.entryHf) || state.hfAcknowledged);
      case 2:
        return !!state.strategy;
      case 3:
        return !!review && review.problems.length === 0 && calls.length > 0 && state.acknowledged;
      default:
        return false;
    }
  };

  const next = () => {
    if (step === 3) setDeadline(deadlineFromNow());
    setStep((x) => Math.min(x + 1, WIZARD_STEPS.length - 1));
  };
  const back = () => setStep((x) => Math.max(x - 1, 0));

  // Live executor: wagmi wallet + viem reads/gas behind the small interfaces lib/execute expects.
  const run = async (emit: Emit) => {
    if (!planInput || !publicClient) return null;
    const r = market.reserves[state.collateral];
    // Every token in ITS OWN units at ITS OWN price; a token that cannot be priced blocks the
    // grant step with the reason instead of signing a wrong line (audit wave 2, G-HIGH-1).
    let limits: ReturnType<typeof grantTokenLimits> | Error;
    try {
      const lpPool = state.strategy?.kind === "lp" ? state.strategy.entry.pool : null;
      // A pool token Aave does not list (cbZEC) is sized at the pool's own USDC price (W3-MED-1).
      const implied = lpPool?.poolAddress ? await poolImpliedUsdPrices(publicClient as never, [{ poolAddress: lpPool.poolAddress as Address, token0: lpPool.token0, token1: lpPool.token1 }]) : {};
      limits = grantTokenLimits(
        planInput.borrowUsdc,
        { address: BASE_TOKENS[state.collateral].address, symbol: state.collateral, decimals: BASE_TOKENS[state.collateral].decimals, priceUsd: r?.priceUsd ?? NaN },
        lpPool ? grantPoolTokenPricing([lpPool.token0, lpPool.token1], market, implied) : [],
      );
    } catch (e) {
      limits = e as Error;
    }
    return runOpen(
      {
        wallet: {
          chainId: s.chainId,
          writeContract: (spec) => writeContractAsync({ address: spec.address, abi: spec.abi as never, functionName: spec.functionName, args: spec.args as never, chainId: CHAIN_ID }),
          signTypedData: (td) => signTypedDataAsync(td as never),
          waitForReceipt: async (hash) => {
            const rc = await publicClient.waitForTransactionReceipt({ hash });
            return { status: rc.status };
          },
        },
        read: publicClient as never,
        gas: publicClient as never,
        owner: s.address,
        ethPriceUsd: market.reserves.WETH?.priceUsd ?? null,
        nowSeconds: () => Math.floor(Date.now() / 1000),
      },
      planInput,
      calls,
      emit,
      limits,
    );
  };

  const summary = review ? `${state.amount} ${state.collateral} → borrow ${fmtUsd(review.loan.borrowUsdc)} USDC → ${state.strategy?.kind === "lp" ? `${state.strategy.entry.pool.token0}/${state.strategy.entry.pool.token1}` : "hold"}` : "";

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-[22px]">New position</h1>
      <p className="mt-1 text-[14px] text-oil-ink2">
        {mode === "simple" ? "Four choices, one transaction. Every number is read live and every step is explained before you sign anything." : "Supply → borrow → deploy, in one transaction from your wallet. Nothing moves before you have seen every number."}
      </p>
      <Steps steps={[...WIZARD_STEPS]} current={step} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="card min-w-0 p-5 sm:p-6">
          {step === 0 && (
            <CollateralStep
              market={market}
              collateral={state.collateral}
              amount={state.amount}
              balance={balance}
              wrongNetwork={s.wrongNetwork}
              onCollateral={(c) => setState((st) => ({ ...st, collateral: c, amount: defaultWizardState(c).amount, strategy: null }))}
              onAmount={(a) => setState((st) => ({ ...st, amount: a }))}
            />
          )}
          {step === 1 && bounds && (
            <SettingStep
              market={market}
              collateral={state.collateral}
              amount={Number(state.amount) || 0}
              bounds={bounds}
              entryHf={effective.entryHf}
              onChange={(hf) => setState((st) => ({ ...st, entryHf: hf, hfAcknowledged: false }))}
              acknowledged={state.hfAcknowledged}
              onAcknowledge={(v) => setState((st) => ({ ...st, hfAcknowledged: v }))}
              keeperProtection={state.keeperProtection}
            />
          )}
          {step === 2 && (
            <StrategyStep forecast={forecast} state={state} ltvBps={review?.loan.ltvBps ?? 0} borrowAprPct={market.usdcBorrowAprPct} onChange={patch} unsupportedVenues={deployment?.unsupportedVenues ?? []} />
          )}
          {step === 3 && review && <ReviewStep state={state} d={review} calls={calls} marketSource={source} onAcknowledge={acknowledge} />}
          {step === 4 && review && planInput && (
            <SignStep calls={calls} mode={s.mode} flowKind="open" summary={summary} owner={s.address} demoAccount={DEMO_ACCOUNT} run={run} />
          )}

          {step < 4 && (
            <div className="mt-7 flex justify-between">
              <button className="btn-ghost" onClick={back} disabled={step === 0} data-testid="wizard-back">
                Back
              </button>
              <button className="btn-brass" onClick={next} disabled={!canNext()} data-testid="wizard-next">
                {step === 3 ? "Continue to sign" : "Continue"}
              </button>
            </div>
          )}
        </div>

        {/* Live projection rail */}
        <aside className="card h-max min-w-0 p-5 lg:sticky lg:top-[82px]" data-testid="projection">
          <h2 className="text-[15px]">Projection</h2>
          {review ? (
            <dl className="num mt-2 divide-y divide-white/10 text-[13.5px]">
              <P k="Collateral" v={`${state.amount || 0} ${state.collateral}`} />
              <P k="Value" v={fmtUsd(review.loan.collateralUsd)} />
              <P k="Entry HF" v={Number.isFinite(review.loan.entryHf) ? review.loan.entryHf.toFixed(2) : "∞ (no loan)"} />
              <P k="Setting" v={`${(review.loan.ltvBps / 100).toFixed(2)}% LTV`} />
              <P k="Borrow" v={`${fmtUsd(review.loan.borrowUsdc)} USDC`} />
              <P k="Liquidation" v={`−${review.loan.liquidationDropPct.toFixed(1)}%`} />
              <P k="Borrow rate" v={`${review.borrowAprPct.toFixed(2)}%`} />
              {review.yieldPlan && <P k="Net / yr (model)" v={fmtUsd(review.yieldPlan.totalUsd)} tone={review.yieldPlan.totalUsd >= 0 ? "good" : "crit"} />}
              {(state.strategy?.kind === "hold" || state.strategy?.kind === "spot") && <P k="Strategy" v={state.strategy.kind === "hold" ? "hold USDC" : "spot via CoW"} />}
              {(state.strategy?.kind === "hold" || state.strategy?.kind === "spot") && <P k="Carry / yr" v={`−${fmtUsd(review.holdCostUsdPerYear)}`} tone={review.holdCostUsdPerYear > 0 ? "crit" : "good"} />}
            </dl>
          ) : (
            <p className="mt-2 text-[13px] text-oil-ink3">Venue read unavailable for {state.collateral}.</p>
          )}
          <p className="mt-3 text-[11.5px] text-oil-ink3">
            {source === "live" ? "Aave read live" : `Snapshot ${market.readAt.slice(0, 10)}`} · forecast {forecast.source} · {s.mode === "demo" ? "demo wallet" : "your wallet"} · {mode} mode
          </p>
        </aside>
      </div>
    </div>
  );
}

function P({ k, v, tone }: { k: string; v: string; tone?: "good" | "crit" }) {
  return (
    <div className="flex justify-between py-1.5">
      <dt className="text-oil-ink2">{k}</dt>
      <dd className={`font-semibold ${tone === "good" ? "text-status-good" : tone === "crit" ? "text-status-crit" : ""}`}>{v}</dd>
    </div>
  );
}
