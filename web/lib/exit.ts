/**
 * Door 1 in the web app — the choice, at the end of an unwind, to send withdrawn USDC out as ZEC
 * (ZEC = Zcash's native coin) to a Zcash address the user controls
 * (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3). SHIPPED DARK.
 *
 * Two locks, and they are not the same lock:
 *
 * 1. `NEXT_PUBLIC_ZEC_EXIT_ENABLED` — the operator's switch, checked here. While it is off nothing
 *    renders and no request leaves the browser.
 * 2. `docs/VERIFIED-ZEC-ROUTES-<date>.md` — the precondition, checked by the yield service, which
 *    is the side with a filesystem. `/v1/exit-quote` answers 503 `facts-missing` while it is
 *    absent, whatever the flag says. A flag is a decision; the facts file is whether anybody has
 *    read the route, and `CLAUDE.md` rule 3 does not let the first override the second.
 *
 * So the browser never decides Door 1 is open. The most it can do is stop asking.
 *
 * What is true here whatever Step Z1 finds: Oilskin never holds the funds and never signs
 * (`CLAUDE.md` rule 1). This module quotes and gates; the user's own wallet signs, and a deposit
 * address, if the route needs one, is shown in full and never auto-submitted.
 */
import { zecExitReadiness, zecExitRefusal, type ZecExitQuote, type ZecExitRefusal } from "@zyo/shared";
import { ENV } from "@/lib/env";

/**
 * Whether this build even offers the choice. The browser cannot see the facts file, so it passes
 * `factsPresent: true` and lets the flag be the only thing it knows — and then the service is asked,
 * and the service is the one that can refuse on the real precondition. Optimism here costs nothing
 * because nothing acts on it: a flag that is on merely means the request is allowed to be made.
 */
export function zecExitOffered(): boolean {
  return zecExitReadiness({ factsPresent: true, flagEnabled: ENV.zecExitEnabled }).ready;
}

/** The sentence to show when the choice is not offered. Never blank; never softened. */
export function zecExitClosedReason(): string {
  const r = zecExitReadiness({ factsPresent: true, flagEnabled: ENV.zecExitEnabled });
  return r.ready ? "" : r.reason;
}

export type ZecExitQuoteResult = { ok: true; quote: ZecExitQuote } | { ok: false; refusal: ZecExitRefusal };

/**
 * Ask the yield service for a live quote.
 *
 * While the flag is off this does not touch the network at all — the refusal is built locally and
 * returned. That is deliberate: a dark feature that still pings an endpoint is not dark, and
 * `test/exit.test.ts` asserts no fetch happens.
 *
 * When the flag is on, the service still holds the real veto and a 503 comes back as a refusal
 * rather than an error, so the UI can print the service's own reason instead of "something went
 * wrong". Anything else — a network failure, a shape this build does not recognise — is also a
 * refusal, because a quote that cannot be read is not a quote.
 */
export async function fetchExitQuote(
  input: { usdcInAtomic: string; destination: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ZecExitQuoteResult> {
  const local = zecExitReadiness({ factsPresent: true, flagEnabled: ENV.zecExitEnabled });
  if (!local.ready) return { ok: false, refusal: zecExitRefusal(local) };

  const url = new URL("/v1/exit-quote", ENV.yieldUrl);
  url.searchParams.set("usdcIn", input.usdcInAtomic);
  url.searchParams.set("destination", input.destination);
  let body: unknown;
  try {
    const res = await fetchImpl(url.toString());
    body = await res.json();
  } catch {
    return {
      ok: false,
      refusal: { error: "zec_exit_unavailable", blockedBy: "facts-missing", reason: "Could not reach the quote service, so there is no quote to show you. Nothing has been sent." },
    };
  }
  if (isRefusal(body)) return { ok: false, refusal: body };
  if (isQuote(body)) return { ok: true, quote: body };
  return {
    ok: false,
    refusal: { error: "zec_exit_unavailable", blockedBy: "facts-missing", reason: "The quote service answered with something this build cannot read. Nothing has been sent." },
  };
}

function isRefusal(v: unknown): v is ZecExitRefusal {
  const o = v as Record<string, unknown> | null;
  return !!o && o.error === "zec_exit_unavailable" && typeof o.reason === "string";
}

/**
 * Every field, present and of the right type — no defaults and no coercion. A quote with a missing
 * fee is not a quote with a zero fee, and the one place that mistake can enter is here.
 */
function isQuote(v: unknown): v is ZecExitQuote {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const strings = ["usdcInAtomic", "zecOutZatoshi", "feeUsdcAtomic", "destination", "quoteRef", "verifiedIn"] as const;
  return strings.every((k) => typeof o[k] === "string" && (o[k] as string).length > 0) && typeof o.expiresAtS === "number" && Number.isFinite(o.expiresAtS);
}
