/**
 * cbZEC B20 policy probe — the words (slice E, 2026-09-10; `docs/RISKS.md` §4).
 *
 * What the app CAN see about the issuer's policy on the B20 precompile, and nothing more: the live
 * `multiplier()` (the rebase factor every balance is scaled by), and whether a zero-amount transfer
 * from the user's own address to itself succeeds right now — which fails when that address is on
 * the issuer's blocklist or the token is paused, and needs no balance to try. `owner()` and
 * `paused()` revert on the precompile (VERIFIED-BASE-FACTS, 2026-09-05), so there is no policy
 * getter to read. A probe is a snapshot: the issuer can change any of it after the read.
 */

export type B20TransferProbe = "ok" | "reverted" | "unavailable";

export interface B20ProbeInput {
  /** `multiplier()` as read, or null when the read failed. */
  multiplier: bigint | null;
  /** Outcome of the simulated zero-amount self-transfer. */
  transfer: B20TransferProbe;
  /** Decoded revert name or message, when `transfer` is "reverted" or "unavailable". */
  detail?: string;
  /** Whether a wallet address was available to simulate from. */
  fromKnown: boolean;
}

export interface B20ProbeVerdict {
  /** Rebase multiplier as a plain number (1 = no rebase), or null. */
  multiplierRatio: number | null;
  /** One plain sentence for the page. Always names what was NOT seen. */
  sentence: string;
  /** "clear" only when the multiplier read and the transfer simulation both succeeded. */
  status: "clear" | "blocked" | "unknown";
}

const WAD = 10n ** 18n;

export function describeB20Probe(p: B20ProbeInput): B20ProbeVerdict {
  const ratio = p.multiplier === null ? null : Number(p.multiplier) / Number(WAD);
  const mult =
    ratio === null
      ? "the rebase multiplier could not be read"
      : ratio === 1
        ? "the rebase multiplier reads 1.0 (no rebase applied)"
        : `the rebase multiplier reads ${ratio.toFixed(6)} (balances are scaled by it)`;
  const cannot = "Oilskin cannot see the issuer's policy beyond that, and it can change after this read";
  if (!p.fromKnown) {
    return {
      multiplierRatio: ratio,
      status: "unknown",
      sentence: `Read just now: ${mult}. No wallet address to simulate a transfer from, so whether transfers from you are blocked or paused was not checked; ${cannot}.`,
    };
  }
  if (p.transfer === "ok" && ratio !== null) {
    return {
      multiplierRatio: ratio,
      status: "clear",
      sentence: `Read just now: ${mult}, and a zero-amount transfer from your address to itself succeeded, so your address is not blocked and the token is not paused at this moment; ${cannot}.`,
    };
  }
  if (p.transfer === "reverted") {
    return {
      multiplierRatio: ratio,
      status: "blocked",
      sentence: `Read just now: ${mult}, and a zero-amount transfer from your address to itself was refused (${p.detail ?? "no reason given"}) — your address may be blocked or the token paused; do not send cbZEC here until you know why. ${cannot}.`,
    };
  }
  return {
    multiplierRatio: ratio,
    status: "unknown",
    sentence: `Read just now: ${mult}; the transfer simulation did not come back${p.detail ? ` (${p.detail})` : ""}, so whether transfers from you are blocked or paused is not known; ${cannot}.`,
  };
}
