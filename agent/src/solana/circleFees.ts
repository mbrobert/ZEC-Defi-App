/**
 * Circle's fee schedule and Fast allowance, as the keeper reads them before a protective burn
 * (`docs/CROSSCHAIN-RUNBOOK-2026-09-13.md` §5's open item, closed 2026-09-25; BUILD-PLAN D6 / Stream C).
 *
 * Two unauthenticated GETs on the same service the attestation client talks to:
 *   `GET /v2/burn/USDC/fees/{sourceDomain}/{destDomain}` — the minimum fee per finality threshold, in basis
 *   points ("1 = 0.01%", Circle's API reference); and
 *   `GET /v2/fastBurn/USDC/allowance` — "the current USDC Fast Burn allowance remaining, in full units of USDC".
 * Both recorded live in `docs/research/cctp-fees-2026-09-25.json`. The parsing and the judgement live in
 * `@zyo/shared` (`parseCctpFeeResponse`, `parseCctpAllowanceResponse`, `chooseCctpFinality`); this module is
 * transport only, and it classifies every way the network can fail as `unavailable` — a read that did not
 * happen is not a number, and the chooser is told so rather than handed a guess.
 *
 * Nothing here signs, and nothing here decides: the choice is the pure function's, on what was read.
 */
import { CCTP_FAST_BURN_ALLOWANCE_PATH, cctpFeePath, parseCctpAllowanceResponse, parseCctpFeeResponse, type CctpFastBurnAllowance, type CctpFeeSchedule, type CctpFinalityInput } from "@zyo/shared";
import type { Logger } from "../log.js";
import { AbortedError } from "../services/deadline.js";

export type FeeScheduleResult = { kind: "ok"; fees: CctpFeeSchedule; readAtMs: number } | { kind: "unavailable"; why: string };
export type AllowanceResult = { kind: "ok"; allowance: CctpFastBurnAllowance; readAtMs: number } | { kind: "unavailable"; why: string };

export interface CircleFeeClientDeps {
  /** `CCTP_IRIS.mainnet` in production, `.testnet` on devnet ↔ Sepolia — the same base the attestation client uses. */
  baseUrl: string;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
  now?: () => number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

export class CircleFeeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly d: CircleFeeClientDeps) {
    this.fetchImpl = d.fetchImpl ?? fetch;
    this.now = d.now ?? (() => Date.now());
    try {
      const u = new URL(d.baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
    } catch {
      throw new RangeError(`Circle fee base URL is not a URL: ${String(d.baseUrl)}`);
    }
  }

  /** The schedule for one route — for the protective burn that is Base (6) → Solana (5). */
  async fees(sourceDomain: number, destDomain: number, signal?: AbortSignal): Promise<FeeScheduleResult> {
    const got = await this.get(cctpFeePath(sourceDomain, destDomain), signal);
    if (got.kind !== "ok") return got;
    try {
      return { kind: "ok", fees: parseCctpFeeResponse(got.body), readAtMs: got.readAtMs };
    } catch (e) {
      return { kind: "unavailable", why: `Circle's fee answer is not a schedule: ${errMsg(e)}` };
    }
  }

  /** The Fast allowance — one pool shared by every Fast route, so it is not asked per route. */
  async fastBurnAllowance(signal?: AbortSignal): Promise<AllowanceResult> {
    const got = await this.get(CCTP_FAST_BURN_ALLOWANCE_PATH, signal);
    if (got.kind !== "ok") return got;
    try {
      return { kind: "ok", allowance: parseCctpAllowanceResponse(got.body), readAtMs: got.readAtMs };
    } catch (e) {
      return { kind: "unavailable", why: `Circle's allowance answer is not an allowance: ${errMsg(e)}` };
    }
  }

  /**
   * Both reads at once, shaped for `chooseCctpFinality`: an unavailable read becomes `null` and a log line,
   * never a failure of the rung — the chooser has a rule for each absence. The allowance's age is measured from
   * Circle's own `lastUpdated`, not from when the request returned.
   */
  async finalityInputs(sourceDomain: number, destDomain: number, signal?: AbortSignal): Promise<Pick<CctpFinalityInput, "fees" | "allowance"> & { notes: string[] }> {
    const [f, a] = await Promise.all([this.fees(sourceDomain, destDomain, signal), this.fastBurnAllowance(signal)]);
    const notes: string[] = [];
    let fees: CctpFeeSchedule | null = null;
    if (f.kind === "ok") fees = f.fees;
    else {
      notes.push(`fees: ${f.why}`);
      this.d.log.warn("Circle's fee schedule could not be read — the chooser falls back to the ceiling", { why: f.why });
    }
    let allowance: CctpFinalityInput["allowance"] = null;
    if (a.kind === "ok") {
      const at = a.allowance.lastUpdatedIso ? Date.parse(a.allowance.lastUpdatedIso) : NaN;
      const ageS = Number.isFinite(at) ? Math.max(0, (a.readAtMs - at) / 1000) : null;
      allowance = { allowanceUsdc: a.allowance.allowanceUsdc, ageS };
    } else {
      notes.push(`allowance: ${a.why}`);
      this.d.log.warn("Circle's Fast allowance could not be read — the chooser cannot downgrade on it", { why: a.why });
    }
    return { fees, allowance, notes };
  }

  private async get(path: string, signal?: AbortSignal): Promise<{ kind: "ok"; body: unknown; readAtMs: number } | { kind: "unavailable"; why: string }> {
    const url = `${this.d.baseUrl.replace(/\/+$/, "")}${path}`;
    // The deadline aborts the REQUEST, not just the wait on it (the attestation client's rule): one controller
    // carries both the timeout and the tick's own abort.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`Circle GET ${path}: deadline ${this.d.deadlineMs} ms`)), this.d.deadlineMs);
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    } catch (e) {
      // A tick that was told to stop must unwind, never be reported as a service fault.
      if (signal?.aborted) throw new AbortedError(`Circle GET ${path}`, signal.reason);
      return { kind: "unavailable", why: `Circle's fee service unreachable: ${errMsg(e)}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!res.ok) return { kind: "unavailable", why: `Circle's fee service answered ${res.status} on ${path}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { kind: "unavailable", why: `Circle's fee service answered unreadable JSON on ${path}: ${errMsg(e)}` };
    }
    return { kind: "ok", body, readAtMs: this.now() };
  }
}
