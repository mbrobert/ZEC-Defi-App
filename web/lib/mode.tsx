"use client";

/**
 * Simple / Advanced — a product-wide toggle (founder requirement).
 *
 *   Simple   = the guided path only: connect → collateral → setting → ONE
 *              recommended strategy → sign. No spot, no custom width/delay,
 *              no raw data, no slippage controls. Every step explained in one
 *              plain sentence.
 *   Advanced = the full suite: every pool × setting with the model's numbers,
 *              custom width / delay / band tolerance, spot via CoW, claim /
 *              unwind / keeper grant management, raw position data.
 *
 * Persisted per browser in localStorage (a per-viewer convenience, never
 * authoritative). Default: Simple.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Mode = "simple" | "advanced";
const KEY = "oilskin.mode";

const Ctx = createContext<{ mode: Mode; setMode: (m: Mode) => void }>({ mode: "simple", setMode: () => undefined });

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>("simple");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(KEY);
      if (v === "advanced" || v === "simple") setModeState(v);
    } catch {
      /* storage unavailable → Simple */
    }
  }, []);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMode() {
  return useContext(Ctx);
}
