/**
 * The cbZEC B20 policy probe (slice E, 2026-09-10; `docs/RISKS.md` §4): what the app can actually
 * see before a user touches cbZEC. Two reads, both honest about their limits:
 *   1. `multiplier()` — the live rebase factor (the precompile answers it; `owner()` and `paused()`
 *      revert, so there is no policy getter).
 *   2. an `eth_call` of `transfer(from, 0)` FROM the user's own address — a zero-amount self-transfer
 *      needs no balance and is refused when the address is blocked or the token is paused.
 * The words are `@zyo/shared` `describeB20Probe`, so the sentence is the same wherever it shows.
 */
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Address, type Hex } from "viem";
import { describeB20Probe, type B20ProbeInput, type B20ProbeVerdict } from "@zyo/shared";

/** The one ERC-20 write the probe encodes (never sends): `transfer(to, amount)`. */
const TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

export type B20ProbeClient = {
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
  call: (args: { account: Address; to: Address; data: Hex }) => Promise<unknown>;
};

const MULTIPLIER_ABI = [{ type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;

function revertDetail(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.errorName;
    if (r?.reason) return r.reason;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

/** Run both reads. Never throws; every failure is a named part of the verdict. */
export async function probeB20Policy(client: B20ProbeClient, token: Address, from: Address | null): Promise<B20ProbeVerdict> {
  let multiplier: bigint | null = null;
  try {
    const m = await client.readContract({ address: token, abi: MULTIPLIER_ABI, functionName: "multiplier" });
    if (typeof m === "bigint" && m > 0n) multiplier = m;
  } catch {
    multiplier = null;
  }
  const input: B20ProbeInput = { multiplier, transfer: "unavailable", fromKnown: from !== null };
  if (from !== null) {
    try {
      await client.call({ account: from, to: token, data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [from, 0n] }) });
      input.transfer = "ok";
    } catch (e) {
      const isRevert = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
      const msg = revertDetail(e);
      // viem surfaces an eth_call revert as CallExecutionError with "execution reverted" in the message.
      if (isRevert || /execution reverted|revert/i.test(msg)) {
        input.transfer = "reverted";
        input.detail = msg;
      } else {
        input.transfer = "unavailable";
        input.detail = msg;
      }
    }
  }
  return describeB20Probe(input);
}
