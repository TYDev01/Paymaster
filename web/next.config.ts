import type {NextConfig} from "next";

const nextConfig: NextConfig = {
  // A self-contained server in `.next/standalone`, so the production image carries the traced
  // runtime files and not the whole `node_modules` (the identity SDK alone is most of it). See
  // web/Dockerfile.
  output: "standalone",
};

export default nextConfig;
