/** Token circle marks — vector, dependency-free, carried from the prototype. */
const MARK: Record<string, { bg: string; fg: string; glyph: string }> = {
  USDC: { bg: "#2775ca", fg: "#fff", glyph: "$" },
  WETH: { bg: "#454a75", fg: "#fff", glyph: "Ξ" },
  cbBTC: { bg: "#0052ff", fg: "#fff", glyph: "₿" },
  cbZEC: { bg: "#f4b728", fg: "#1a1204", glyph: "Z" },
  AERO: { bg: "#1652f0", fg: "#fff", glyph: "A" },
  USDT: { bg: "#26a17b", fg: "#fff", glyph: "₮" },
  cbETH: { bg: "#3b8beb", fg: "#fff", glyph: "Ξ" },
  LINK: { bg: "#2a5ada", fg: "#fff", glyph: "⬡" },
};

export function TokenMark({ symbol, size = 30 }: { symbol: string; size?: number }) {
  const m = MARK[symbol] ?? { bg: "#8C8A77", fg: "#171204", glyph: symbol.slice(0, 1) };
  return (
    <span
      aria-hidden
      className="grid flex-none place-items-center rounded-full border-2 border-oil-surface font-extrabold"
      style={{ width: size, height: size, background: m.bg, color: m.fg, fontSize: size * 0.4 }}
    >
      {m.glyph}
    </span>
  );
}

export function TokenPair({ a, b, size = 30 }: { a: string; b?: string; size?: number }) {
  return (
    <span className="flex items-center">
      <TokenMark symbol={a} size={size} />
      {b && (
        <span style={{ marginLeft: -size * 0.3 }}>
          <TokenMark symbol={b} size={size} />
        </span>
      )}
    </span>
  );
}
