/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@zyo/shared"],
  webpack: (config, { webpack }) => {
    // @wagmi/connectors → @base-org/account → @coinbase/cdp-sdk declares the
    // x402 payment packages as optional peers and imports them from its node
    // entry. We never take that path (Base Account payments are not used);
    // ignoring them keeps the server bundle from failing on an optional dep.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // MetaMask SDK's React-Native storage shim is irrelevant in a browser build.
    config.resolve.alias["@react-native-async-storage/async-storage"] = false;
    return config;
  },
};

export default nextConfig;
