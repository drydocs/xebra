import type { NextConfig } from "next";

/**
 * `distDir` is overridable so a production build can never clobber a running dev server.
 *
 * Both commands default to `.next`. When `next build` runs while `next dev` is live it wipes
 * and rewrites that directory underneath the dev server, which then fails every request with
 * `ENOENT: routes-manifest.json`. The build looks fine; the dev server looks broken; nothing
 * in either message points at the other process.
 *
 * The build script sets `NEXT_DIST_DIR=.next-build`, so the two never share state.
 *
 * A webpack IgnorePlugin rule for /^@x402\// used to live here. It existed only because
 * wagmi's `wagmi/connectors` barrel statically pulled in every connector it ships, including
 * Coinbase Smart Wallet, which transitively imported @coinbase/cdp-sdk's optional x402
 * payments feature and failed the build on peer deps nothing here called. Wagmi is gone —
 * this is a USDC bridge over CCTP (Stellar -> Solana) and never needed an EVM wallet
 * connector — so the workaround went with it.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
