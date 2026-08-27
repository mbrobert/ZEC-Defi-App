/**
 * Rhea (Burrow) borrow/supply rates over bare NEAR JSON-RPC view calls.
 *
 * Burrow's `get_asset(token_id)` view returns current utilization-derived
 * APRs. Response shape (verified live 2026-08-27 against the mainnet
 * contract — see docs/YIELD-SERVICE.md verification log): the asset object
 * carries "borrow_apr" and "supply_apr" as DECIMAL-FRACTION STRINGS (e.g.
 * "0.1315…" = 13.15%). If the shape ever drifts, this module throws with
 * the raw keys it saw rather than serving a misread number.
 */

import type { RatesSample } from "./types.js";

export class RheaRates {
  private id = 0;

  constructor(
    private readonly nearRpcUrl: string,
    private readonly lendingContract: string,
    private readonly usdcTokenId: string,
    private readonly zecTokenId?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async viewCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.nearRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "oilskin-yield/0.1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${++this.id}`,
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.lendingContract,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`near rpc http ${res.status}`);
    const body = (await res.json()) as {
      result?: { result: number[] };
      error?: { message?: string; cause?: { name?: string } };
    };
    if (body.error) throw new Error(`near rpc: ${body.error.message ?? body.error.cause?.name}`);
    if (!body.result?.result) throw new Error("near rpc: empty view result");
    return JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString("utf8")) as T;
  }

  async sample(): Promise<RatesSample> {
    const asset = await this.viewCall<Record<string, unknown>>("get_asset", {
      token_id: this.usdcTokenId,
    });
    const borrow = asset["borrow_apr"];
    const supply = asset["supply_apr"];
    if (typeof borrow !== "string" || typeof supply !== "string") {
      throw new Error(
        `rhea get_asset: unexpected shape — saw keys [${Object.keys(asset).join(", ")}]`
      );
    }

    // Collateral-side ZEC supply APR — best-effort (rates still serve
    // without it; the consumer falls back to its static supply constant).
    let zecSupplyAprPct: number | null = null;
    if (this.zecTokenId) {
      try {
        const zec = await this.viewCall<Record<string, unknown>>("get_asset", {
          token_id: this.zecTokenId,
        });
        const zs = zec["supply_apr"];
        if (typeof zs === "string") zecSupplyAprPct = round2(Number(zs) * 100);
      } catch {
        zecSupplyAprPct = null;
      }
    }

    return {
      borrowAprPct: round2(Number(borrow) * 100),
      supplyAprPct: round2(Number(supply) * 100),
      zecSupplyAprPct,
      asset: "USDC",
      market: this.lendingContract,
      sampledAt: new Date().toISOString(),
      source: "rhea-burrow",
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
