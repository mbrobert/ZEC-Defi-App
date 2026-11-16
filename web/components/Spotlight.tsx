"use client";

import type { PointerEvent, ReactNode } from "react";

/**
 * A surface with a light that follows the pointer (see `.spot` in globals.css). The handler writes
 * two CSS variables and nothing else, so moving the mouse never re-renders React.
 */
export default function Spotlight({ children, className = "" }: { children: ReactNode; className?: string }) {
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div className={`spot ${className}`} onPointerMove={onMove}>
      {children}
    </div>
  );
}
