import { NextResponse } from "next/server";
import { MOCK_STRATEGIES } from "@/lib/mock";

/**
 * v1 BFF stubs. In production these proxy the agent's API / indexer:
 *   GET  → strategies for the connected user
 *   POST → create a strategy intent; returns the personal ZEC deposit address
 *          from Rhea MCA creation (agent-side).
 */
export async function GET() {
  return NextResponse.json({ strategies: MOCK_STRATEGIES });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // TODO(agent): forward to the agent, which calls rhea.ensureAccount(...)
  // and persists the strategy. Mocked deterministic response for now.
  const id = `strat-${Math.random().toString(16).slice(2, 6)}`;
  return NextResponse.json({
    id,
    zecDepositAddress: "t1MockDepositAddrGeneratedByRheaMCA00",
    received: body,
    note: "mock — wire to agent API",
  });
}
