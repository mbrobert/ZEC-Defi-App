"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { BASE_TOKENS, CHAIN_ID, COLLATERAL_ASSETS, isCollateralSymbol, type CollateralSymbol } from "@zyo/shared";
import { useAccountRead, useDeployment, useGate, useMarket, useSession } from "@/lib/hooks";
import { useMode } from "@/lib/mode";
import { fromAtomic } from "@/lib/math";
import { buildOpenPlan, deadlineFromNow, type OpenPlanInput } from "@/lib/plan";
import { grantTokenLimits, runOpen, type Emit } from "@/lib/execute";
import { WIZARD_STEPS, defaultWizardState, deriveReview, presetsFor, type WizardState } from "@/lib/wizard";
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
  const { gate } = useGate();
  const { deployment } = useDeployment();
  const { account } = useAccountRead(market);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(() => defaultWizardState(isCollateralSymbol(initial) && COLLATERAL_ASSETS[initial].enabled ? initial : "cbBTC"));
  const [deadline, setDeadline] = useState(() => deadlineFromNow());
  const patch = (p: Partial<WizardState>) => setState((st) => ({ ...st, ...p }));

  // If the live read says the chosen asset is unusable, fall back to the first usable one.
  useEffect(() => {
    if (!presetsFor(market, state.collateral)) {
      const usable = (["cbBTC", "WETH"] as CollateralSymbol[]).find((c) => presetsFor(market, c));
      if (usable && usable !== state.collateral) setState((st) => ({ ...st, collateral: usable }));
    }
  }, [market, state.collateral]);

  // Simple mode never carries Advanced overrides.
  useEffect(() => {
    if (mode === "simple" && (state.customWidthBps !== null || state.customDelayHours !== null || !state.keeperProtection)) {
      setState((st) => ({ ...st, customWidthBps: null, customDelayHours: null, keeperProtection: true, bandToleranceBps: defaultWizardState().bandToleranceBps }));
    }
  }, [mode, state.customWidthBps, state.customDelayHours, state.keeperProtection]);

  const presets = presetsFor(market, state.collateral);
  const review = useMemo(() => deriveReview(state, market, gate), [state, market, gate]);

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
      enginePoolId: lp ? (lp.pool.enginePoolId as `0x${string}` | undefined) : undefined,
      poolLabel: lp ? `${lp.pool.token0}/${lp.pool.token1}` : undefined,
      lpParams: review.lpParams ?? { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true },
      deployment,
      deadline,
      bandToleranceBps: state.bandToleranceBps,
      keeperProtection: state.keeperProtection,
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
        return !!presets && Number(state.amount) > 0 && !s.wrongNetwork;
      case 1:
        return !!presets?.find((p) => p.id === state.ltvPreset)?.offerable;
      case 2:
        return !!state.strategy;
      case 3:
        return !!review && review.problems.length === 0 && calls.length > 0;
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
    const r = market.reserves[state.collateral]!;
    const limits = grantTokenLimits(planInput.borrowUsdc, { address: BASE_TOKENS[state.collateral].address, decimals: BASE_TOKENS[state.collateral].decimals, priceUsd: r.priceUsd }, state.strategy?.kind === "lp" ? [BASE_TOKENS[state.strategy.entry.pool.token0 as keyof typeof BASE_TOKENS]?.address, BASE_TOKENS[state.strategy.entry.pool.token1 as keyof typeof BASE_TOKENS]?.address].filter(Boolean) as Address[] : []);
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
          {step === 1 && presets && (
            <SettingStep
              market={market}
              collateral={state.collateral}
              amount={Number(state.amount) || 0}
              presets={presets}
              selected={state.ltvPreset}
              onSelect={(id) => setState((st) => ({ ...st, ltvPreset: id }))}
              keeperProtection={state.keeperProtection}
            />
          )}
          {step === 2 && <StrategyStep gate={gate} state={state} ltvBps={review?.preset.ltvBps ?? 0} borrowAprPct={market.usdcBorrowAprPct} onChange={patch} />}
          {step === 3 && review && <ReviewStep state={state} d={review} calls={calls} marketSource={source} />}
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
              <P k="Setting" v={`${review.preset.ltvBps / 100}% LTV`} />
              <P k="Borrow" v={`${fmtUsd(review.loan.borrowUsdc)} USDC`} />
              <P k="Entry HF" v={review.loan.entryHf.toFixed(2)} />
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
            {source === "live" ? "Aave read live" : `Snapshot ${market.readAt.slice(0, 10)}`} · gate {gate.source} · {s.mode === "demo" ? "demo wallet" : "your wallet"} · {mode} mode
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
