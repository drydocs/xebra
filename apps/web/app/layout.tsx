import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type React from "react";
import { AmbientBackground } from "../components/site/ambient-background";
import { Providers } from "./providers";
import "./globals.css";

/**
 * # Why the typefaces are local files and not `next/font/google`
 *
 * `next/font/google` fetches the font at *build* time. This app's production image is built
 * in CI, and a build that silently depends on fonts.gstatic.com being reachable is a build
 * that fails on the day it is not. The two latin subsets are 52 KB committed to the repo,
 * self-hosted from our own origin, and cannot be broken by someone else's outage.
 *
 * Geist is a variable font across 100-900, so weight is free: the interface uses 400, 500,
 * 600 and 700 for hierarchy rather than the regular/bold pair that makes a design read as
 * two-tone.
 */
const geist = localFont({
  src: "./fonts/geist-variable.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Xebra — USDC from Stellar to Solana", template: "%s · Xebra" },
  description:
    "Move native USDC from Stellar to Solana over Circle's CCTP. One signature, no wrapped assets, no custody.",
  applicationName: "Xebra",
  // Served from `public/` rather than as an `app/icon.svg` convention file: Next's static
  // metadata handler tries to register that path as a route and fails page-data collection
  // for it at build time.
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  openGraph: {
    title: "Xebra — USDC from Stellar to Solana",
    description:
      "Move native USDC from Stellar to Solana over Circle's CCTP. One signature, no wrapped assets, no custody.",
    siteName: "Xebra",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Xebra — USDC from Stellar to Solana",
    description: "Native USDC, Stellar to Solana, over Circle's CCTP.",
  },
};

export const viewport: Viewport = {
  // Matches --obsidian, so the mobile browser chrome continues the page instead of framing it.
  themeColor: "#0a0b0e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="grain min-h-[100dvh] bg-obsidian font-sans text-bone antialiased">
        {/* Keyboard users should not have to tab the wallet control to reach the amount. */}
        <a
          href="#bridge"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-bone focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-obsidian"
        >
          Skip to the bridge
        </a>
        <AmbientBackground />
        <Providers>{children}</Providers>
        {/* Entry animations start hidden in the server-rendered markup so the page does not
            flash on load (see components/ui/reveal.tsx). Without JavaScript nothing would
            ever reveal them, so without JavaScript they are simply never hidden. */}
        <noscript>
          <style>
            {"[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}"}
          </style>
        </noscript>
      </body>
    </html>
  );
}
