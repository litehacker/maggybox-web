import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript sources directly.
  transpilePackages: ["@maggybox/contracts", "@maggybox/db", "@maggybox/storage", "@tonejs/piano"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // @tonejs/piano imports ToneBufferSource from "tone"; Tone 14.9 does not
        // re-export that name from the package root. Client-only so API routes
        // do not pick up the Web Audio shim.
        tone$: path.join(dir, "src/shims/tone.js"),
      };
    }
    return config;
  },
};

export default nextConfig;
