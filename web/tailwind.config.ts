import type { Config } from "tailwindcss";

/**
 * ZYO design tokens (see docs/UX-TEARDOWN.md).
 * Dark-first: warm charcoal ground, ZEC gold as the ONLY brand accent.
 * Status hues are reserved for state (never decoration) and were validated
 * for separation from the gold brand accent on the dark surface.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          bg: "#121016",
          bg2: "#17141d",
          surface: "#1c1824",
          raised: "#262031",
          border: "#2e2839",
          muted: "#7a7190",
          soft: "#a89fbc",
          hi: "#f2eff7",
        },
        zec: { DEFAULT: "#f4b728", hi: "#ffcd45", deep: "#d3920e", on: "#211906" },
        status: {
          good: "#3dd68c",
          warn: "#ff6b2c",
          serious: "#e5484d",
          critical: "#b3212f",
          info: "#8b9cf9",
        },
      },
      borderRadius: { card: "14px", ctl: "10px" },
      boxShadow: {
        card: "0 12px 32px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.25)",
        gold: "0 2px 14px rgba(244,183,40,.28)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
