import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import Providers from "@/components/Providers";
import Nav from "@/components/Nav";
import Banners from "@/components/Banners";
import Footer from "@/components/Footer";

// Two families, clearly apart: a display grotesque with some grain for headings and the wordmark,
// and a plain, even one for everything that is read or compared. Both are self-hosted by Next at
// build time; if the download fails the system stack in tailwind.config.ts takes over.
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Oilskin",
  description:
    "Borrow USDC against cbBTC or WETH on Base and put it to work in Aerodrome liquidity — from an account your wallet owns. cbZEC holders: spot today; as collateral it is not enabled yet.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#12170F",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
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
