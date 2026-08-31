/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript sources directly.
  transpilePackages: ["@maggybox/contracts", "@maggybox/db", "@maggybox/storage"],
  serverComponentsExternalPackages: ["@prisma/client"],
};

export default nextConfig;
