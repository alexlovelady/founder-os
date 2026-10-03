import type { NextConfig } from "next";

// LegalAI runs as its own service. The shell proxies it under /legal-ui so the browser only ever talks to one origin:
// the sign-in cookie is shared and the embedded LegalAI pages are same-origin (no third-party cookie problems).
const LEGAL = process.env.LEGAL_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  // Tools are TypeScript packages in /modules, compiled by the shell.
  transpilePackages: ["@founderos/sdk", "@founderos/finance", "@founderos/compliance", "@founderos/health", "@founderos/tasks", "@founderos/vault", "@founderos/sops", "@founderos/crm", "@founderos/marketing", "@founderos/founderai", "@founderos/product", "@founderos/competitors"],
  outputFileTracingRoot: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  async rewrites() {
    return [
      { source: "/assets/:path*", destination: `${LEGAL}/assets/:path*` },
      { source: "/legal-ui", destination: `${LEGAL}/` },
      { source: "/legal-ui/:path*", destination: `${LEGAL}/:path*` },
    ];
  },
};

export default nextConfig;
