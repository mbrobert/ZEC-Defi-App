"use client";

import { Suspense, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import Steps from "@/components/Steps";
import BridgedZecStep from "@/components/solana/wizard/BridgedZecStep";
import AmountStep from "@/components/solana/wizard/AmountStep";
import HfStep from "@/components/solana/wizard/HfStep";
import SolanaReviewStep from "@/components/solana/wizard/SolanaReviewStep";
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
  const walletZec = s.connected && position ? fromUnits(position.walletZec.amount, 8) : null;

  const onHf = (v: number) => {
    setHfTouched(true);
    setEntryHf(bounds ? clampSolanaHf(v, bounds) : v);
    setAckHf(false);
  };
  const canContinue = step === 0 ? ackBridged : step === 1 ? collateralZec > 0 && !!plan : step === 2 ? !!plan && (!needsHfAcknowledgment(hf) || ackHf) : step === 3 ? ackReview && view.allowed : false;

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
        <p className="mt-1 text-[13.5px] text-oil-ink2">Five screens, one decision each. Every number is read from Solana and shown with its slot before you sign anything. {s.mode === "demo" ? "Demo mode: the market is a labelled snapshot and nothing can be signed." : ""}</p>
      </div>
      <Steps steps={[...SOLANA_WIZARD_STEPS]} current={step} />
      <div className="card p-6">
        {step === 0 && <BridgedZecStep acknowledged={ackBridged} onAcknowledge={setAckBridged} />}
        {step === 1 && <AmountStep amount={amount} onAmount={setAmount} view={view} walletZec={walletZec} mode={s.mode} />}
        {step === 2 && plan && bounds && <HfStep plan={plan} bounds={bounds} view={view} entryHf={hf} onChange={onHf} acknowledged={ackHf} onAcknowledge={setAckHf} keeperProtection={s.keeperConfigured} />}
        {step === 3 && plan && <SolanaReviewStep plan={plan} view={view} steps={steps} acknowledged={ackReview} onAcknowledge={setAckReview} mode={s.mode} productMode={productMode} keeperMaySell={keeperMaySell} onKeeperMaySell={setKeeperMaySell} />}
        {step === 4 && plan && <SolanaSignStep steps={steps} mode={s.mode} run={run} />}
        {step < 4 && (
          <div className="mt-6 flex justify-between">
            <button className="btn-ghost" onClick={() => setStep((x) => Math.max(0, x - 1))} disabled={step === 0} data-testid="sol-wizard-back">
              Back
            </button>
            <button className="btn btn-brass" onClick={() => setStep((x) => x + 1)} disabled={!canContinue} data-testid="sol-wizard-next">
              {step === 3 ? "Continue to sign" : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
