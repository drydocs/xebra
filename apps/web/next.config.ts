import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Biome lints/formats this monorepo instead of ESLint; nothing to wire here.
  webpack: (config, { webpack }) => {
    // wagmi's default connector barrel (`wagmi/connectors`) statically pulls in every
    // connector implementation it ships, including Coinbase Smart Wallet — which transitively
    // imports @coinbase/cdp-sdk's optional x402 payments feature. That feature's own optional
    // peer deps (@x402/evm, @x402/core, @x402/svm, and their subpaths) aren't installed here
    // (this app only uses the plain `injected()` connector), and webpack's module-graph
    // resolution runs before tree-shaking can drop the unused code, so it fails the build on
    // packages nothing here actually calls. IgnorePlugin is the standard fix for exactly this
    // "optional dependency doesn't exist and isn't needed" shape of problem — installing the
    // @x402/* packages would add real weight for a payments feature this app doesn't use.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    return config;
  },
};

export default nextConfig;
