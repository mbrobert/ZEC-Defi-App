"use client";

/**
 * Owner notification opt-in — Simple: one toggle ("tell me in the app").
 * Advanced: the same toggle plus a channel choice between the two in-app
 * channels v1 has. See docs/ARCHITECTURE.md "Owner notifications (v1)" for
 * why there is no email or push-service channel yet: no data plane exists
 * between this app and the keeper (the app holds no backend; the keeper
 * exposes no inbound port), and building one is out of scope here.
 *
 * Persisted per browser in localStorage, exactly like lib/mode.tsx: a
 * per-viewer convenience, never sent anywhere, never read by the keeper.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type NotifyChannel = "banner" | "browser";

export interface NotifyPrefs {
  optIn: boolean;
  channel: NotifyChannel;
}

const KEY = "oilskin.notify";
const DEFAULT_PREFS: NotifyPrefs = { optIn: false, channel: "banner" };

function isChannel(v: unknown): v is NotifyChannel {
  return v === "banner" || v === "browser";
}

const Ctx = createContext<{ prefs: NotifyPrefs; setPrefs: (p: NotifyPrefs) => void }>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => undefined,
});

export function NotifyPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<NotifyPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as Partial<NotifyPrefs>;
      if (typeof v.optIn === "boolean" && isChannel(v.channel)) setPrefsState({ optIn: v.optIn, channel: v.channel });
    } catch {
      /* storage unavailable or malformed → default (opted out) */
    }
  }, []);
  const setPrefs = useCallback((p: NotifyPrefs) => {
    setPrefsState(p);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ prefs, setPrefs }), [prefs, setPrefs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifyPrefs() {
  return useContext(Ctx);
}
