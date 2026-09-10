"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { shortAddress } from "@zyo/shared";
import { BASE_CHAIN } from "@/lib/chain";
import type { Emit, StepEvent } from "@/lib/execute";
import type { QuotedSwap } from "@/lib/plan";
import type { GasAssessment } from "@/lib/gas";
import { clearInflight, isInterrupted, loadInflight, saveInflight, type InflightFlow, type InflightStep } from "@/lib/inflight";
import { planIsSignable, type PlannedCall } from "@/lib/plan";
import { useMode } from "@/lib/mode";
import Chip from "@/components/Chip";

type StepState = InflightStep["state"];

/**
 * Sign: one wallet prompt per step, each introduced by ONE plain sentence,
 * with the gas check shown before the prompt. State is persisted per browser
 * (lib/inflight) so a closed tab can be resumed; a submitted transaction
 * keeps going on-chain either way and the page says so.
 *
 * In demo mode every step is SIMULATED (clearly labelled) — no wallet, no
 * network, nothing moves.
 */
export default function SignStep({
  calls,
  mode,
  flowKind,
  summary,
  owner,
  demoAccount,
  run,
  onDone,
  doneTitle = "Your account",
  doneBody,
}: {
  calls: PlannedCall[];
  mode: "demo" | "live";
  flowKind: InflightFlow["kind"];
  summary: string;
  owner: Address;
  demoAccount: Address;
  /** Executes the plan against the wallet; resolves with the account address (open) or null on stop. */
  run: (emit: Emit) => Promise<{ account: Address } | null>;
  onDone?: (account: Address) => void;
  doneTitle?: string;
  doneBody?: string;
}) {
  const { mode: uiMode } = useMode();
  const [states, setStates] = useState<Record<number, StepState>>(() => Object.fromEntries(calls.map((c) => [c.step, c.required ? "todo" : "skipped"])));
  const [txs, setTxs] = useState<Record<number, Hex>>({});
  const [gas, setGas] = useState<Record<number, GasAssessment>>({});
  const [blocked, setBlocked] = useState<{ step: number; reason: string } | null>(null);
  const [quote, setQuote] = useState<QuotedSwap | null>(null);
  const [running, setRunning] = useState(false);
  const [account, setAccount] = useState<Address | null>(null);
  const [resumed, setResumed] = useState<InflightFlow | null>(null);
  const flowId = useRef<string>(`${flowKind}-${Date.now().toString(36)}`);
  const signable = mode === "demo" || planIsSignable(calls);
  const finished = account !== null;
  const nextStep = calls.find((c) => c.required && states[c.step] !== "done");

  // Resume: a previous flow was interrupted (tab closed while signing / waiting).
  useEffect(() => {
    if (mode !== "live") return;
    const prev = loadInflight();
    if (prev && !prev.completedAt && prev.kind === flowKind && prev.wallet.toLowerCase() === owner.toLowerCase() && isInterrupted(prev)) setResumed(prev);
  }, [mode, flowKind, owner]);

  // Persist every change while a live flow is in progress.
  const persist = useMemo(
    () => (st: Record<number, StepState>, tx: Record<number, Hex>, acct: Address | null) => {
      if (mode !== "live") return;
      saveInflight({
        id: flowId.current,
        kind: flowKind,
        wallet: owner,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        summary,
        steps: calls.map((c) => ({ step: c.step, kind: c.kind, title: c.title, state: st[c.step] ?? "todo", txHash: tx[c.step] })),
        account: acct ?? undefined,
        completedAt: acct ? new Date().toISOString() : undefined,
      });
    },
    [mode, flowKind, owner, summary, calls],
  );

  // Warn before the tab closes while a wallet prompt or confirmation is pending.
  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  const emit: Emit = (e: StepEvent) => {
    if (e.type === "gas") setGas((g) => ({ ...g, [e.step]: e.gas }));
    if (e.type === "quoted") setQuote(e.quote);
    if (e.type === "blocked") {
      setBlocked({ step: e.step, reason: e.reason });
      setStates((s) => ({ ...s, [e.step]: "todo" }));
    }
    if (e.type === "signing") setStates((s) => ({ ...s, [e.step]: "signing" }));
    if (e.type === "submitted") {
      setTxs((t) => ({ ...t, [e.step]: e.hash }));
      setStates((s) => {
        const n = { ...s, [e.step]: "submitted" as StepState };
        persist(n, { ...txs, [e.step]: e.hash }, null);
        return n;
      });
    }
    if (e.type === "done") {
      setStates((s) => {
        const n = { ...s, [e.step]: "done" as StepState };
        persist(n, txs, null);
        return n;
      });
    }
    if (e.type === "failed") {
      setBlocked({ step: e.step, reason: e.error });
      setStates((s) => ({ ...s, [e.step]: "failed" }));
    }
  };

  async function start() {
    setRunning(true);
    setBlocked(null);
    setResumed(null);
    try {
      if (mode === "demo") {
        for (const c of calls) {
          if (!c.required) continue;
          setStates((s) => ({ ...s, [c.step]: "signing" }));
          await new Promise((r) => setTimeout(r, 450));
          setStates((s) => ({ ...s, [c.step]: "done" }));
        }
        setAccount(demoAccount);
        onDone?.(demoAccount);
        return;
      }
      const res = await run(emit);
      if (res) {
        setAccount(res.account);
        persist({ ...states }, txs, res.account);
        clearInflight();
        onDone?.(res.account);
      }
    } catch (e) {
      setBlocked({ step: nextStep?.step ?? 0, reason: (e as Error).message ?? String(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="sign">
      <div>
        <h2 className="text-[19px]">Sign</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          {mode === "demo"
            ? "Demo mode: the steps below are simulated. No wallet is asked to sign; nothing moves."
            : "Your wallet will open once per step, in this order. Read the sentence above each button before you approve it. You can stop at any point; nothing is held between steps."}
        </p>
      </div>

      {resumed && (
        <div className="note note-warn" data-testid="resume-banner" role="status">
          <b className="text-oil-ink">You closed this page mid-way last time.</b> A transaction that was already submitted kept going on-chain — that is how the network works; closing the tab does not cancel it. Here is where it got to:
          <ul className="mt-1.5 list-disc pl-5">
            {resumed.steps.map((s) => (
              <li key={s.step}>
                {s.title}: {s.state}
                {s.txHash && (
                  <>
                    {" · "}
                    <a className="text-status-info" href={`${BASE_CHAIN.explorerUrl}/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                      view transaction {shortAddress(s.txHash)} ↗
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5">Check the dashboard before signing again — if the position is already open, do not open it twice.</p>
          <button className="btn-quiet mt-1 text-[12.5px]" onClick={() => { clearInflight(); setResumed(null); }}>
            Dismiss
          </button>
        </div>
      )}

      <ol className="space-y-3">
        {calls.map((c) => {
          const st = states[c.step];
          const isNext = nextStep?.step === c.step;
          const g = gas[c.step];
          return (
            <li key={c.step} className={`card px-4 py-3.5 ${st === "skipped" ? "opacity-55" : ""} ${isNext && !finished ? "border-brass/50" : ""}`} data-testid={`sign-step-${c.kind}`} data-state={st}>
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full border-2 text-[12px] font-bold ${
                    st === "done" ? "border-status-good bg-status-good/15 text-status-good" : st === "signing" || st === "submitted" ? "animate-pulse border-status-info text-status-info" : st === "failed" ? "border-status-crit text-status-crit" : "border-oil-line text-oil-ink3"
                  }`}
                >
                  {st === "done" ? "✓" : st === "failed" ? "!" : c.step}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                    {c.title}
                    <Chip kind="mute">{c.wallet === "signature" ? "signature · free" : "transaction · network fee"}</Chip>
                    {st === "skipped" && <Chip kind="mute">not needed</Chip>}
                    {st === "signing" && <Chip kind="info">{mode === "demo" ? "simulating" : "check your wallet"}</Chip>}
                    {st === "submitted" && <Chip kind="info">submitted — waiting for confirmation</Chip>}
                    {st === "done" && <Chip kind="good">{mode === "demo" ? "simulated" : "confirmed"}</Chip>}
                  </div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-oil-ink" data-testid={`plain-${c.kind}`}>
                    {c.plain}
                  </p>
                  {g && (
                    <p className={`num mt-1 text-[12.5px] ${g.ok ? "text-oil-ink3" : "text-status-warn"}`} data-testid={`gas-${c.kind}`}>
                      {g.plain}
                    </p>
                  )}
                  {quote && c.kind === "unwind" && (
                    <p className="num mt-1 text-[12.5px] text-oil-ink3" data-testid="swap-floor">
                      Priced at {Number(quote.quotedOut) / 1e6} USDC per {quote.tokenSymbol}; the swap is refused below{" "}
                      <b className="text-oil-ink">{(Number(quote.minOutForQuotedIn) / 1e6).toFixed(2)} USDC per {quote.tokenSymbol}</b> — that floor is read from the swap contract, not computed here.
                    </p>
                  )}
                  {txs[c.step] && (
                    <a className="mt-1 inline-block text-[12.5px] text-status-info" href={`${BASE_CHAIN.explorerUrl}/tx/${txs[c.step]}`} target="_blank" rel="noreferrer">
                      view transaction {shortAddress(txs[c.step])} on Basescan ↗
                    </a>
                  )}
                  {uiMode === "advanced" && (
                    <details className="mt-1.5 text-[12px] text-oil-ink3">
                      <summary className="cursor-pointer">Technical detail</summary>
                      <div className="mono mt-1">
                        {c.toLabel} · {c.functionName}
                      </div>
                      <dl className="mono mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                        {c.args.map((a) => (
                          <div key={a.name} className="contents">
                            <dt className="text-oil-ink3">{a.name}</dt>
                            <dd className="text-oil-ink2">{a.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="mt-1">{c.note}</p>
                    </details>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {blocked && (
        <div className="note note-crit" role="alert" data-testid="sign-blocked-reason">
          <b className="text-oil-ink">Stopped before step {blocked.step}.</b> {blocked.reason}
        </div>
      )}

      {!signable && !finished && (
        <div className="note note-warn" data-testid="sign-blocked">
          Signing is disabled: the Oilskin contracts are not deployed / configured for this site yet (NEXT_PUBLIC_OILSKIN_FACTORY and _ROUTER). The plan above is exactly what will be signed once they are.
        </div>
      )}

      {!finished ? (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-brass btn-lg" onClick={start} disabled={running || !signable} data-testid="sign-run">
            {running ? (mode === "demo" ? "Simulating…" : "Follow the prompts in your wallet…") : mode === "demo" ? "Simulate signing (demo)" : blocked ? "Try again from where it stopped" : `Start — step 1 of ${calls.filter((c) => c.required).length}`}
          </button>
          <span className="text-[12.5px] text-oil-ink3">
            {mode === "demo" ? "Nothing is sent anywhere." : "If you close this tab after a transaction is submitted, it still completes; come back here to see where it got to."}
          </span>
        </div>
      ) : (
        <div className="card p-5" data-testid="sign-done">
          <div className="flex flex-wrap items-center gap-2">
            <Chip kind="good">{mode === "demo" ? "Simulated" : "Done"}</Chip>
            <h3 className="text-[15px]">{doneTitle}</h3>
          </div>
          <p className="mt-2 text-[13.5px] text-oil-ink2">
            {doneBody ?? `This is the Oilskin account your wallet now owns${mode === "demo" ? " (demo address)" : ""}. Positions live under it; only your wallet can act from it; the keeper only within the permission you grant.`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-oil-ink3">Your Oilskin account address</span>
            <code className="mono rounded-lg border border-oil-line bg-oil-bg2 px-3 py-2 text-brass" data-testid="account-address">
              {account}
            </code>
          </div>
          <div className="mt-4 flex gap-2">
            <Link href="/dashboard" className="btn-brass">
              Go to dashboard
            </Link>
            {mode === "live" && account && (
              <a className="btn-ghost" href={`${BASE_CHAIN.explorerUrl}/address/${account}`} target="_blank" rel="noreferrer">
                View on Basescan ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
