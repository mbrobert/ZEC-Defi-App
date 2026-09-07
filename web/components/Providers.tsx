"use client";

import { Suspense, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { BASE_CHAIN, wagmiConfig } from "@/lib/wagmi";
import { ModeProvider } from "@/lib/mode";
import { NotifyPrefsProvider } from "@/lib/notifyPrefs";
import { ENV } from "@/lib/env";
import E2EMockWalletConnector from "./E2EMockWalletConnector";

/** RainbowKit modal in the Oilcloth palette: brass accent on waxed green. */
const theme = darkTheme({
  accentColor: "#CDA355",
  accentColorForeground: "#171204",
  borderRadius: "medium",
  fontStack: "system",
  overlayBlur: "small",
});
theme.colors.modalBackground = "#1A2116";
theme.colors.modalBorder = "#333C2A";
theme.colors.modalText = "#ECEADF";
theme.colors.modalTextSecondary = "#B4B29F";
theme.colors.profileForeground = "#1A2116";
theme.colors.closeButtonBackground = "#232B1D";
theme.colors.actionButtonBorder = "#333C2A";
theme.colors.generalBorder = "#333C2A";
theme.colors.connectButtonBackground = "#1A2116";
theme.colors.connectButtonInnerBackground = "#232B1D";
theme.colors.connectButtonText = "#ECEADF";

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 0, refetchOnWindowFocus: false, staleTime: 20_000 },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} initialChain={BASE_CHAIN} appInfo={{ appName: "Oilskin" }} modalSize="compact">
          <ModeProvider>
            <NotifyPrefsProvider>
              {ENV.mockWallet && (
                <Suspense fallback={null}>
                  <E2EMockWalletConnector />
                </Suspense>
              )}
              {children}
            </NotifyPrefsProvider>
          </ModeProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
