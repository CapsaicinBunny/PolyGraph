/** @type {import('next').NextConfig} */
const nextConfig = {
  // ts-morph pulls in the TypeScript compiler; keep it external to the server
  // bundle so the API route loads it from node_modules at runtime. (The native
  // analyzer-core addon is loaded by absolute path, so it needs no entry here.)
  serverExternalPackages: ["ts-morph"],
};

export default nextConfig;
