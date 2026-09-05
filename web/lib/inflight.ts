/**
 * In-flight signing state, persisted per browser so that closing the tab in
 * the middle of a multi-step flow loses nothing: on return the Sign page
 * shows which steps were done, the transaction links, and what is still
 * pending. A submitted transaction keeps going on-chain whether or not the
 * tab is open — the page says so in plain words.
 *
 * localStorage only (per-viewer convenience); every read/write is guarded.
 */

export type InflightStepState = "todo" | "signing" | "submitted" | "done" | "failed" | "skipped";

export interface InflightStep {
  step: number;
  kind: string;
  title: string;
  state: InflightStepState;
  txHash?: `0x${string}`;
  error?: string;
}

export interface InflightFlow {
  id: string;
  kind: "open" | "unwind" | "claim" | "grant" | "spot";
  wallet: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  steps: InflightStep[];
  account?: string;
  /** Set once every required step is done. */
  completedAt?: string;
}

const KEY = "oilskin.inflight";

export function loadInflight(): InflightFlow | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as InflightFlow;
    return f && Array.isArray(f.steps) ? f : null;
  } catch {
    return null;
  }
}

export function saveInflight(flow: InflightFlow): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...flow, updatedAt: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}

export function clearInflight(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** True when a flow has a step that was sent to the wallet but never resolved (tab closed mid-prompt or mid-confirmation). */
export function isInterrupted(flow: InflightFlow | null): boolean {
  if (!flow || flow.completedAt) return false;
  return flow.steps.some((s) => s.state === "signing" || s.state === "submitted");
}

export function nextPendingStep(flow: InflightFlow): InflightStep | undefined {
  return flow.steps.find((s) => s.state === "todo" || s.state === "signing" || s.state === "submitted" || s.state === "failed");
}
