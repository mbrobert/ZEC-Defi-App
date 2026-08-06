import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          bg: "#0B0E14",
          surface: "#131826",
          raised: "#1A2132",
          border: "#232B3D",
          muted: "#8A94A8",
          soft: "#B9C2D4",
        },
        zec: { DEFAULT: "#F4B728", deep: "#C79215" },
        status: {
          good: "#34D399",
          warn: "#FBBF24",
          serious: "#F87171",
          critical: "#EF4444",
        },
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
