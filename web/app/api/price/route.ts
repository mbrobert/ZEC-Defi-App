import { NextResponse } from "next/server";
import { ONE_CLICK_BASE_URL, ONE_CLICK_ENDPOINTS, INTENTS_ASSET_IDS } from "@zyo/shared";
import { MOCK_ZEC_PRICE } from "@/lib/mock";

export const revalidate = 60;

/** Live ZEC price via the 1-Click token list (public, no auth), with fallback. */
export async function GET() {
  try {
    const res = await fetch(`${ONE_CLICK_BASE_URL}${ONE_CLICK_ENDPOINTS.tokens}`, {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const tokens = (await res.json()) as { assetId: string; price?: number }[];
      const zec = tokens.find((t) => t.assetId === INTENTS_ASSET_IDS.ZEC);
      if (zec?.price) {
        return NextResponse.json({ zecUsd: zec.price, source: "1click" });
      }
    }
  } catch {
    // fall through to mock
  }
  return NextResponse.json({ zecUsd: MOCK_ZEC_PRICE, source: "mock" });
}
