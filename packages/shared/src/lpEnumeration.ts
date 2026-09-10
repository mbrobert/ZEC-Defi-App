/**
 * Naming a refused `SnuggleLpVenue.positionsOf` (slice A, 2026-09-10; `docs/RISKS.md` §12).
 *
 * The live engine's end-of-list revert is empty — the shape of a bare revert, an out-of-gas and a
 * proxy miss alike — so the venue accepts an end only when gas, shape, consistency and ownership
 * agree, and otherwise reverts `EnumerationAmbiguous(fault, index, data)`. The keeper REFUSES the
 * dispatch with the fault named and the dashboard shows the account's positions as unreadable;
 * neither ever turns a refusal into "owns nothing". This module is the one place both read the
 * fault's name and its plain sentence from.
 */

/**
 * `SnuggleLpVenue.EnumerationFault`, in declaration order — the ABI carries it as a `uint8`, so the
 * order IS the contract. `agent/scripts/verify-abi.mjs` pins this list against the Solidity source.
 */
export const LP_ENUMERATION_FAULTS = [
  "InsufficientGas",
  "ProbeOutOfGas",
  "CanaryAnswered",
  "TerminalShapeUnknown",
  "InconsistentEnd",
  "LivenessLost",
  "PositionUnreadable",
  "OwnerMismatch",
] as const;

export type LpEnumerationFault = (typeof LP_ENUMERATION_FAULTS)[number];

/** Plain sentence per fault: what the venue saw, in words a person who never used DeFi can read. */
export const LP_ENUMERATION_FAULT_TEXT: Readonly<Record<LpEnumerationFault, string>> = {
  InsufficientGas: "the read itself was not given enough gas to probe the engine safely",
  ProbeOutOfGas: "an engine probe ran out of gas, which is not the end of the list",
  CanaryAnswered: "the engine answered at an index no bounded list can have",
  TerminalShapeUnknown: "the engine's end-of-list revert had a shape this app has never measured",
  InconsistentEnd: "the engine failed at one index but answered at the next — not an end",
  LivenessLost: "the engine stopped answering a plain view during the read",
  PositionUnreadable: "an id in the list did not read back as a full position",
  OwnerMismatch: "an id in the account's list is owned by someone else",
};

/** The three reverts `positionsOf` can produce. Anything else is not an enumeration verdict. */
export const LP_ENUMERATION_ERRORS = ["EnumerationAmbiguous", "EnumerationFailed", "EngineUnreachable"] as const;

const CAVEAT = "this is not a statement that the account holds no positions";

/**
 * A sentence for a `positionsOf` revert decoded by name (`errorName` and `args` as viem decodes
 * them), or `null` when the error is not one of the venue's enumeration verdicts — the caller keeps
 * its own message then. The sentence always names the Solidity fault and always carries the caveat
 * that a refusal is not an empty list.
 */
export function describeLpEnumerationFault(errorName: string | undefined, args: readonly unknown[] | undefined): string | null {
  if (errorName === "EnumerationAmbiguous") {
    const code = Number(args?.[0]);
    const fault = Number.isInteger(code) && code >= 0 && code < LP_ENUMERATION_FAULTS.length ? LP_ENUMERATION_FAULTS[code] : null;
    const index = args?.[1];
    const at = typeof index === "bigint" ? (index === 2n ** 256n - 1n ? "the canary index" : `index ${index}`) : "an unknown index";
    if (!fault) return `LP positions unreadable: the venue named an enumeration fault this app does not know (code ${String(args?.[0])}) at ${at} — ${CAVEAT}`;
    return `LP positions unreadable: ${LP_ENUMERATION_FAULT_TEXT[fault]} (${fault} at ${at}) — ${CAVEAT}`;
  }
  if (errorName === "EnumerationFailed") {
    const data = typeof args?.[0] === "string" ? args[0] : "0x";
    return `LP positions unreadable: the engine reverted mid-list with a shape that is neither an answer nor its end (EnumerationFailed, data ${data}) — ${CAVEAT}`;
  }
  if (errorName === "EngineUnreachable") {
    return `LP positions unreadable: the engine did not answer a plain view (EngineUnreachable) — ${CAVEAT}`;
  }
  return null;
}
