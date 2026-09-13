import type { Connection } from "@solana/web3.js";

/**
 * Hold one standing subscription on the connection for the life of a spec, so @solana/web3.js never idle-closes
 * its websocket. Without it the library marks the socket disconnected the instant the subscription count hits
 * zero and closes it 500 ms later; a `signatureSubscribe` that lands while that close is in flight reconnects
 * into a closing socket, every later confirmation waits its 30 s timeout (Anchor's `.rpc()` confirms over the
 * socket), and the stuck socket keeps the mocha process alive. Seen 2026-09-12 in two of four runs of this suite,
 * with the validator healthy and the transactions landed. Read-only specs do not need it.
 */
export function keepWebSocketWarm(conn: Connection): () => Promise<void> {
  const id = conn.onSlotChange(() => {});
  return () => conn.removeSlotChangeListener(id);
}
