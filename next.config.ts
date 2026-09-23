import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Tauri serves a static bundle from ./out; there is no Next.js server at runtime (D11).
  output: 'export',
  // next/image optimization needs a server, which a static export does not have.
  images: { unoptimized: true },
};

export default nextConfig;
