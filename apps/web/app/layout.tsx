import type { Metadata } from "next";
import type React from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Xebra",
  description: "Intent-based swap-capable cross-chain bridge. Arc<->Stellar, Stellar->Solana.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-50 antialiased">
        <Providers>
          <div className="mx-auto max-w-2xl px-4 py-10">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
