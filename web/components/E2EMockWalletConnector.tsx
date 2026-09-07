"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, useConnect } from "wagmi";
import { e2eMockConnector } from "@/lib/wagmi";

/**
 * Test-only: connects wagmi's mock wallet once, on initial load, when the
 * page has ?e2eMockWallet=1 (used by web/e2e/demo-flow.spec.ts's
 * connected-pill test). Renders nothing. Only mounted when ENV.mockWallet is
 * on (see Providers.tsx) — inert in a normal/production build regardless,
 * since the mock connector isn't even registered with wagmi in that case.
 *
 * Attempts the connect at most once per mount (tracked in `attempted`), so an
 * explicit disconnect afterwards (isConnected flipping back to false) is
 * honoured instead of being immediately reconnected.
 */
export default function E2EMockWalletConnector() {
  const params = useSearchParams();
  const { isConnected } = useAccount();
  const { connect } = useConnect();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    if (isConnected) return;
    if (params.get("e2eMockWallet") !== "1") return;
    attempted.current = true;
    connect({ connector: e2eMockConnector });
  }, [params, isConnected, connect]);

  return null;
}
