"use client";

import { Suspense, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import Steps from "@/components/Steps";
import BridgedZecStep from "@/components/solana/wizard/BridgedZecStep";
import AmountStep from "@/components/solana/wizard/AmountStep";
import HfStep from "@/components/solana/wizard/HfStep";
import SolanaReviewStep from "@/components/solana/wizard/SolanaReviewStep";
import DeployStep from "@/components/solana/wizard/DeployStep";
import { useLoopForecast } from "@/lib/solana/hooks";
import { crossingSteps, DEFAULT_LOOP_CHOICE, planLoop, type LoopChoice } from "@/lib/solana/loop";
import SolanaSignStep from "@/components/solana/wizard/SolanaSignStep";
import { SOLANA_ENV } from "@/lib/solana/env";
import { runSolanaOpen, type SolanaEmit } from "@/lib/solana/execute";
import { useMode } from "@/lib/mode";
import { useSolanaBorrowView, useSolanaPosition, useSolanaSession } from "@/lib/solana/hooks";
import { clampSolanaHf, fromUnits, openSteps, planSolanaOpen, SOLANA_WIZARD_STEPS, solanaHfBounds } from "@/lib/solana/plan";
import { needsHfAcknowledgment } from "@/lib/wizard";
import { accountPda } from "@/lib/solana/addresses";

export default function SolanaNewPositionPage() {
  return (
    <Suspense fallback={null}>
      <SolanaWizard />
    </Suspense>
  );
}

function SolanaWizard() {
  const s = useSolanaSession();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { position } = useSolanaPosition();
  const [step, setStep] = useState(0);
  const [ackBridged, setAckBridged] = useState(false);
  const [amount, setAmount] = useState("");
  const [entryHf, setEntryHf] = useState<number>(Number.POSITIVE_INFINITY);
  const [hfTouched, setHfTouched] = useState(false);
  const [ackHf, setAckHf] = useState(false);
  const [ackReview, setAckReview] = useState(false);
  // where the borrowed USDC goes (the cross-chain loop, D6); the default is to keep it on Solana
  const [loop, setLoop] = useState<LoopChoice>(DEFAULT_LOOP_CHOICE);
  const [ackLoop, setAckLoop] = useState(false);
  // Advanced mode's one extra decision inside the grant; Simple mode takes Oilskin's default whatever was chosen before the switch
  const { mode: productMode } = useMode();
  const [keeperMaySellChoice, setKeeperMaySell] = useState(true);
  const keeperMaySell = productMode === "advanced" ? keeperMaySellChoice : true;

  const collateralZec = Number(amount) > 0 ? Number(amount) : 0;
  // the pool view (no query) for step 2; the priced view for steps 3–5 once an amount exists
  const { view: poolView } = useSolanaBorrowView({});
  const bounds = useMemo(() => solanaHfBounds(poolView), [poolView]);
  // the first time the user reaches the slider it sits at the most Kamino allows (the lowest HF offered), like Base's default mark
  const hf = hfTouched || !bounds ? entryHf : bounds.minHf;
  const draftPlan = useMemo(() => (collateralZec > 0 ? planSolanaOpen({ collateralZec, entryHf: hf, view: poolView }) : null), [collateralZec, hf, poolView]);
  const { view: pricedView } = useSolanaBorrowView(collateralZec > 0 ? { collateralZec, amountUsdc: draftPlan && draftPlan.borrowUsdc > 0 ? draftPlan.borrowUsdc : null, entryHf: Number.isFinite(hf) ? hf : null } : {});
  const view = collateralZec > 0 ? pricedView : poolView;
  const plan = useMemo(() => (collateralZec > 0 ? planSolanaOpen({ collateralZec, entryHf: hf, view: poolView }) : null), [collateralZec, hf, poolView]);
  const steps = plan ? openSteps(plan, { accountExists: position?.exists ?? false, keeperConfigured: s.keeperConfigured, keeperMaySell }) : [];
  const { forecast: loopForecast, loading: loopLoading } = useLoopForecast({ entryHf: Number.isFinite(hf) ? hf : undefined, depositUsd: plan?.collateralUsd, enabled: !!plan && plan.borrowUsdc > 0 });
  const loopPlan = plan ? planLoop(plan, loop, loopForecast) : null;
  const onLoop = (c: LoopChoice) => {
    setLoop(c);
    setAckLoop(false);
  };
  const walletZec = s.connected && position ? fromUnits(position.walletZec.amount, 8) : null;

  const onHf = (v: number) => {
    setHfTouched(true);
    setEntryHf(bounds ? clampSolanaHf(v, bounds) : v);
    setAckHf(false);
    setAckLoop(false);
  };
  const canContinue =
    step === 0 ? ackBridged
    : step === 1 ? collateralZec > 0 && !!plan
    : step === 2 ? !!plan && (!needsHfAcknowledgment(hf) || ackHf)
    : step === 3 ? loopPlan !== null && (loopPlan.kind === "keep" || (ackLoop && loopPlan.allowed))
    : step === 4 ? ackReview && view.allowed
    : false;

  const run = async (emit: SolanaEmit): Promise<string[]> => {
    if (!plan || !s.publicKey || !wallet.sendTransaction) throw new Error("no wallet");
    const programId = new PublicKey(SOLANA_ENV.programId);
    const slot = await connection.getSlot("confirmed");
    const nowS = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    return runSolanaOpen({
      conn: connection,
      wallet: { publicKey: s.publicKey, sendTransaction: (tx, c) => wallet.sendTransaction(tx, c) },
      programId,
      account: accountPda(programId, s.publicKey),
      keeper: s.keeperConfigured ? new PublicKey(SOLANA_ENV.keeper) : null,
      plan,
      accountExists: position?.exists ?? false,
      nowS,
      grantChoice: { keeperMaySell },
      emit,
    });
  };

  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <div>
        <h1 className="text-[24px]">ZEC on Solana → USDC on Kamino</h1>
        <p className="mt-1 text-[13.5px] text-oil-ink2">Six screens, one decision each. Every number is read from Solana and shown with its slot before you sign anything. {s.mode === "demo" ? "Demo mode: the market is a labelled snapshot and nothing can be signed." : ""}</p>
      </div>
      <Steps steps={[...SOLANA_WIZARD_STEPS]} current={step} />
      <div className="card p-6">
        {step === 0 && <BridgedZecStep acknowledged={ackBridged} onAcknowledge={setAckBridged} />}
        {step === 1 && <AmountStep amount={amount} onAmount={setAmount} view={view} walletZec={walletZec} mode={s.mode} />}
        {step === 2 && plan && bounds && <HfStep plan={plan} bounds={bounds} view={view} entryHf={hf} onChange={onHf} acknowledged={ackHf} onAcknowledge={setAckHf} keeperProtection={s.keeperConfigured} />}
        {step === 3 && plan && loopPlan && <DeployStep plan={plan} forecast={loopForecast} loading={loopLoading} choice={loop} loop={loopPlan} onChoice={onLoop} acknowledged={ackLoop} onAcknowledge={setAckLoop} />}
        {step === 4 && plan && <SolanaReviewStep plan={plan} view={view} steps={steps} loop={loopPlan} acknowledged={ackReview} onAcknowledge={setAckReview} mode={s.mode} productMode={productMode} keeperMaySell={keeperMaySell} onKeeperMaySell={setKeeperMaySell} />}
        {step === 5 && plan && <SolanaSignStep steps={steps} afterwards={loopPlan ? crossingSteps(loopPlan) : []} mode={s.mode} run={run} />}
        {step < 5 && (
          <div className="mt-6 flex justify-between">
            <button className="btn-ghost" onClick={() => setStep((x) => Math.max(0, x - 1))} disabled={step === 0} data-testid="sol-wizard-back">
              Back
            </button>
            <button className="btn btn-brass" onClick={() => setStep((x) => x + 1)} disabled={!canContinue} data-testid="sol-wizard-next">
              {step === 4 ? "Continue to sign" : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
