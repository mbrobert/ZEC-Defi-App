import type { Metadata, Viewport } from "next";
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import Providers from "@/components/Providers";
import Nav from "@/components/Nav";
import Banners from "@/components/Banners";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Oilskin",
  description:
    "Borrow USDC against cbBTC or WETH on Base and put it to work in Aerodrome liquidity — from an account your wallet owns. cbZEC holders: spot today, collateral when a market exists.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#12170F",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <Nav />
          <Banners />
          <main className="mx-auto max-w-[1180px] px-4 py-7 sm:px-6">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
