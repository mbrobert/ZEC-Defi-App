"use client";

import { useState } from "react";
import type { OpenStep } from "@/lib/solana/plan";
import type { SolanaEmit, SolanaStepEvent } from "@/lib/solana/execute";
import { explorerTx } from "@/lib/solana/env";
import Chip from "@/components/Chip";
import SolanaWalletButton from "@/components/solana/SolanaWalletButton";

type State = "pending" | "signing" | "submitted" | "done" | "failed";

/**
 * Step 5: one wallet prompt per step, each introduced by one sentence. In demo mode nothing runs and the page says
 * what would be signed; a Solana wallet button offers the live path.
 */
export default function SolanaSignStep({ steps, afterwards = [], mode, run, onDone }: { steps: OpenStep[]; afterwards?: { id: string; title: string; sentence: string }[]; mode: "demo" | "live"; run: (emit: SolanaEmit) => Promise<string[]>; onDone?: () => void }) {
  const [states, setStates] = useState<Record<number, { state: State; signature?: string; error?: string }>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const emit: SolanaEmit = (e: SolanaStepEvent) => {
    setStates((s) => ({
      ...s,
      [e.step]: e.type === "signing" ? { state: "signing" } : e.type === "submitted" ? { state: "submitted", signature: e.signature } : e.type === "done" ? { state: "done", signature: e.signature } : { state: "failed", error: e.error },
    }));
  };
  const start = async () => {
    setRunning(true);
    try {
      await run(emit);
      setFinished(true);
      onDone?.();
    } catch {
      /* the failing step already says why */
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Sign</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">{mode === "live" ? "One wallet prompt per step. A submitted transaction keeps going on chain even if you close this page." : "Demo mode: nothing is signed and nothing moves. Connect a Solana wallet on a configured build to sign for real."}</p>
      </div>
      <ol className="space-y-3">
        {steps.map((s, i) => {
          const st = states[i]?.state ?? "pending";
          return (
            <li key={s.id} className="card p-4" data-testid={`sol-step-${s.id}`} data-state={st}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] font-semibold">
                  <span className="num text-oil-ink3">{i + 1}.</span> {s.title}
                </div>
                <Chip kind={st === "done" ? "good" : st === "failed" ? "crit" : st === "pending" ? "mute" : "info"}>{mode === "demo" ? "simulated" : st}</Chip>
              </div>
              <p className="mt-1 text-[13px] text-oil-ink2">{s.sentence}</p>
              {states[i]?.signature && (
                <p className="mt-1 text-[12px]">
                  <a className="underline" href={explorerTx(states[i]!.signature!)} target="_blank" rel="noreferrer">
                    {states[i]!.signature!.slice(0, 12)}… on the explorer
                  </a>
                </p>
              )}
              {states[i]?.error && <p className="mt-1 text-[13px] text-oil-crit">{states[i]!.error}</p>}
            </li>
          );
        })}
      </ol>
      {afterwards.length > 0 && (
        <div data-testid="sol-afterwards">
          <div className="text-[14px] font-semibold">Then, the crossing — not signable in this build</div>
          <p className="mt-1 text-[12.5px] text-oil-ink3">The loop you chose is four more signatures on two chains. This build lists them and cannot sign them yet; they land with the devnet ↔ Sepolia run. Your USDC stays in your Solana account until then.</p>
          <ol className="mt-2 space-y-2">
            {afterwards.map((a, i) => (
              <li key={a.id} className="card p-3" data-testid={`sol-after-${a.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13.5px] font-semibold"><span className="num text-oil-ink3">{steps.length + i + 1}.</span> {a.title}</div>
                  <Chip kind="mute">not in this build</Chip>
                </div>
                <p className="mt-1 text-[12.5px] text-oil-ink2">{a.sentence}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {mode === "live" ? (
        <button type="button" className="btn btn-brass btn-lg" onClick={start} disabled={running || finished} data-testid="sol-sign">
          {finished ? "Done" : running ? "Waiting for your wallet…" : `Sign ${steps.length} transaction${steps.length === 1 ? "" : "s"}`}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <SolanaWalletButton />
          <span className="text-[12.5px] text-oil-ink3">Connect a Solana wallet to sign; this build must also name the program (`NEXT_PUBLIC_OILSKIN_SOLANA_PROGRAM`).</span>
        </div>
      )}
    </div>
  );
}
