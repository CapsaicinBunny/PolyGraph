/** @type {import('next').NextConfig} */
const nextConfig = {
  // ts-morph pulls in the TypeScript compiler; keep it external to the server bundle
  // so the API route loads it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["ts-morph"],
};

export default nextConfig;
