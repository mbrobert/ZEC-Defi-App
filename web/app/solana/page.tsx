"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import SolanaPositionCard from "@/components/solana/SolanaPositionCard";
import SolanaWalletButton from "@/components/solana/SolanaWalletButton";
import { SOLANA_RISKS } from "@/lib/solana/copy";
import { SOLANA_ENV } from "@/lib/solana/env";
import { closeSteps, runSolanaClose, runSolanaRevokeAll, type SolanaStepEvent } from "@/lib/solana/execute";
import { useSolanaBorrowView, useSolanaPosition, useSolanaSession } from "@/lib/solana/hooks";
import Chip from "@/components/Chip";

/** The Solana positions page: the connected wallet's account, or the way to open one; the exit hatch is one button. */
export default function SolanaPage() {
  const s = useSolanaSession();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { position, loading, error, refetch } = useSolanaPosition();
  const { view } = useSolanaBorrowView({});
  const [events, setEvents] = useState<SolanaStepEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [nowS, setNowS] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!s.connected) return;
    connection
      .getSlot("confirmed")
      .then((slot) => connection.getBlockTime(slot))
      .then((t) => t && setNowS(t))
      .catch(() => {});
  }, [connection, s.connected]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setEvents([]);
    try {
      await fn();
    } catch {
      /* the last event says why */
    } finally {
      setBusy(false);
      refetch();
    }
  };
  const emit = (e: SolanaStepEvent) => setEvents((xs) => [...xs, e]);
  const programId = s.configured ? new PublicKey(SOLANA_ENV.programId) : null;
  const walletLike = s.publicKey && wallet.sendTransaction ? { publicKey: s.publicKey, sendTransaction: (tx: Parameters<typeof wallet.sendTransaction>[0], c: Parameters<typeof wallet.sendTransaction>[1]) => wallet.sendTransaction(tx, c) } : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px]">ZEC on Solana</h1>
          <p className="mt-1 text-[13.5px] text-oil-ink2">Bridged ZEC as collateral on Kamino&rsquo;s ZCASH market, USDC borrowed, protected by the same ladder as Base — from an account your wallet owns and only the Oilskin program can operate.</p>
        </div>
        <div className="flex items-center gap-3">
          <SolanaWalletButton />
          <Link href="/solana/new" className="btn btn-brass" data-testid="sol-new">
            New position
          </Link>
        </div>
      </div>
      {!s.configured && (
        <div className="card p-4 text-[13px] text-oil-ink2">
          <Chip kind="mute">demo</Chip> This build names no Solana program (<code>NEXT_PUBLIC_SOLANA_CLUSTER</code>, <code>NEXT_PUBLIC_OILSKIN_SOLANA_PROGRAM</code>), so the Solana surfaces run on a labelled snapshot of Kamino&rsquo;s market. The program is built and proven on a local copy of the market; it is not deployed.
        </div>
      )}
      {s.configured && !s.connected && <div className="card p-4 text-[13px] text-oil-ink2">Connect a Solana wallet to see your position.</div>}
      {s.connected && loading && !position && <div className="card p-4 text-[13px] text-oil-ink2">Reading your account…</div>}
      {error && <div className="card p-4 text-[13px] text-oil-crit">Could not read your account: {error}</div>}
      {s.connected && position && !position.exists && (
        <div className="card p-4 text-[13px] text-oil-ink2">
          No Oilskin account on Solana for this wallet yet.{" "}
          <Link href="/solana/new" className="underline">
            Open one
          </Link>
          .
        </div>
      )}
      {s.connected && position && position.exists && programId && walletLike && (
        <SolanaPositionCard position={position} view={view} nowS={nowS} busy={busy} onClose={() => act(() => runSolanaClose({ conn: connection, wallet: walletLike, programId, position, emit }))} onRevoke={() => act(() => runSolanaRevokeAll(connection, walletLike, programId, position.account, emit))} />
      )}
      {position && position.exists && events.length === 0 && !busy && (
        <div className="card p-4 text-[12.5px] text-oil-ink3">
          Closing signs {closeSteps(position).length} transaction{closeSteps(position).length === 1 ? "" : "s"}: {closeSteps(position).map((x) => x.title.toLowerCase()).join("; ")}.
        </div>
      )}
      {events.length > 0 && (
        <ol className="card p-4 space-y-1 text-[13px]" data-testid="sol-events">
          {events.map((e, i) => (
            <li key={i}>
              {e.type === "signing" && `Step ${e.step + 1}: waiting for your wallet…`}
              {e.type === "submitted" && `Step ${e.step + 1}: submitted ${e.signature.slice(0, 12)}…`}
              {e.type === "done" && `Step ${e.step + 1}: confirmed.`}
              {e.type === "failed" && <span className="text-oil-crit">Step {e.step + 1}: {e.error}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="space-y-3">
        {SOLANA_RISKS.filter((r) => s.mode === "demo" || r.id !== "demo").map((r) => (
          <details key={r.id} className="card p-4">
            <summary className="cursor-pointer text-[14px] font-semibold">{r.title}</summary>
            <p className="mt-2 text-[13px] text-oil-ink2">{r.body}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
