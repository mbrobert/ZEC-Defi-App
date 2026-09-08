import type { KeeperStore, OwnerNotifyEntry } from "../store/keeperStore.js";
import type { Channel } from "./notifier.js";

/**
 * The keeper's per-account, durable notification history — NOT a live
 * delivery channel to the owner. It exists because there is currently no
 * data plane between `web/` and this process: the web app is client-only
 * (no write endpoint anywhere) and this process exposes no inbound port (it
 * only ever calls out, e.g. `webhookChannel`) — see docs/ARCHITECTURE.md
 * "Owner notifications (v1)" for the full comparison. Building a real
 * per-owner push channel needs that data plane first, which is out of scope
 * here.
 *
 * What this channel does today: give every rung and escalation a durable,
 * per-account record in the store the founder can already inspect, and — the
 * point of building it now rather than later — the seam a future
 * write-capable backend would read from once one exists, without redesigning
 * the notifier again.
 *
 * An account not yet registered (a startup race between discovery and the
 * first tick) is NOT dropped: the store keeps the entry under the account's
 * address in a deferred bucket and attaches it when the account is
 * registered (audit wave 2, N-MED-1 — it used to be swallowed and the rung
 * still reported NOTIFIED). A genuinely broken store (tampered / lock lost /
 * write failed) propagates, so MultiNotifier counts and logs it like any
 * other channel failure.
 *
 * `reachesAPerson: false` — a record on this host is not a notification.
 */
export function ownerHistoryChannel(store: KeeperStore): Channel {
  return {
    name: "owner-history",
    reachesAPerson: false,
    send: async (e) => {
      if (!e.account) return; // fleet-level event — nothing to attribute to an owner
      const entry: OwnerNotifyEntry = { kind: e.kind, severity: e.severity, rung: e.rung, hf: e.hf ?? null, at: e.at };
      await store.recordOwnerNotification(e.account, entry);
    },
  };
}
