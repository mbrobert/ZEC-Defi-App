/**
 * Circle's attestation service ("Iris") as the keeper uses it — step 3 of the five-step cross-chain rung
 * (`docs/SOLANA-ARCHITECTURE.md` §14.6; BUILD-PLAN D6 / Stream C).
 *
 * One job: given a Base burn we made, ask Circle whether its message is attested yet, and hand back only an
 * answer that IS that burn. Every judgement lives in `packages/shared` (`parseAttestationResponse`), which
 * decodes the raw message bytes itself — Circle null-fills `decodedMessage` for a non-EVM destination, and
 * Solana is one (`VERIFIED-SOLANA-FACTS.md` Addendum 4) — so this module is transport only: a bounded GET, a
 * JSON parse, and the classification of everything that can go wrong with the network rather than the message.
 *
 * Nothing here signs, and nothing here decides to deliver: `pending` and `not-found` are normal answers the
 * keeper waits on, `mismatch` is a refusal that must reach a person.
 */
import { CCTP_IRIS, attestationPathByNonce, attestationPathByTx, parseAttestationResponse, type CctpAttestationOutcome, type CctpBurnExpectation } from "@zyo/shared";
import type { Logger } from "../log.js";
import { AbortedError } from "../services/deadline.js";

/** A transport failure is not an answer about the message: the keeper retries it, it never blocks a rung. */
export type AttestationResult = CctpAttestationOutcome | { kind: "unavailable"; why: string };

export interface AttestationClientDeps {
  /** `CCTP_IRIS.mainnet` in production, `.testnet` on devnet ↔ Sepolia. */
  baseUrl: string;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  log: Logger;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

export class CircleAttestationClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly d: AttestationClientDeps) {
    this.fetchImpl = d.fetchImpl ?? fetch;
    try {
      const u = new URL(d.baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
    } catch {
      throw new RangeError(`attestation base URL is not a URL: ${String(d.baseUrl)}`);
    }
  }

  /** The lookup by burn transaction — what the keeper has right after `confirmBurn`. */
  async byTx(sourceDomain: number, txHash: string, expect: CctpBurnExpectation, signal?: AbortSignal): Promise<AttestationResult> {
    return this.get(attestationPathByTx(sourceDomain, txHash), expect, signal);
  }

  /**
   * The lookup by nonce — the one that survives a re-org renaming the transaction. The keeper prefers it once
   * it has the nonce (it reads it off the burn's own `MessageSent`, not off Circle).
   */
  async byNonce(sourceDomain: number, nonce: string, expect: CctpBurnExpectation, signal?: AbortSignal): Promise<AttestationResult> {
    return this.get(attestationPathByNonce(sourceDomain, nonce), expect, signal);
  }

  private async get(path: string, expect: CctpBurnExpectation, signal?: AbortSignal): Promise<AttestationResult> {
    const url = `${this.d.baseUrl.replace(/\/+$/, "")}${path}`;
    // The deadline has to abort the REQUEST, not just stop waiting on it: a socket left open on every tick is
    // how a poller leaks. One controller carries both the timeout and the tick's own abort.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`attestation GET ${path}: deadline ${this.d.deadlineMs} ms`)), this.d.deadlineMs);
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    } catch (e) {
      // A tick that was told to stop must unwind, never be reported as a service fault.
      if (signal?.aborted) throw new AbortedError(`attestation GET ${path}`, signal.reason);
      return { kind: "unavailable", why: `attestation service unreachable: ${errMsg(e)}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    // Circle answers 404 while it has not indexed the burn yet — a normal early state, not a fault.
    if (res.status === 404) return { kind: "not-found" };
    if (!res.ok) return { kind: "unavailable", why: `attestation service answered ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { kind: "unavailable", why: `attestation service answered unreadable JSON: ${errMsg(e)}` };
    }
    const out = parseAttestationResponse(body, expect);
    if (out.kind === "mismatch") {
      this.d.log.error("ATTESTATION MISMATCH — Circle returned a message that is not the burn we made; nothing will be delivered", {
        why: out.why,
        nonce: expect.nonce,
      });
    }
    return out;
  }
}

export { CCTP_IRIS };
