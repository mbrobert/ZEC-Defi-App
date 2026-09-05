import type { Config } from "tailwindcss";

/**
 * Oilskin design tokens — the "Oilcloth" theme the founder approved in the
 * prototypes (prototype/index.html, simple.html): waxed-green ground, brass
 * as the ONLY brand accent. Status hues are reserved for state, never
 * decoration; every status chip ships icon + label, never colour alone.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        oil: {
          bg: "#12170F",
          bg2: "#171E12",
          surface: "#1A2116",
          surface2: "#232B1D",
          line: "#333C2A",
          ink: "#ECEADF",
          ink2: "#B4B29F",
          ink3: "#8C8A77",
        },
        brass: { DEFAULT: "#CDA355", hi: "#DDB56A", deep: "#B0863A", on: "#171204" },
        status: {
          good: "#52C98A",
          warn: "#E3B84A",
          crit: "#F06D80",
          info: "#6FA9F2",
        },
      },
      borderRadius: { card: "14px", ctl: "10px" },
      boxShadow: {
        card: "0 12px 32px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.25)",
        brass: "0 2px 14px rgba(205,163,85,.28)",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
