/** @type {import('next').NextConfig} */
const nextConfig = {
  // ts-morph pulls in the TypeScript compiler, and web-tree-sitter loads grammar
  // .wasm files from node_modules at runtime; keep all of them external to the
  // server bundle so they resolve from node_modules instead of being bundled.
  serverExternalPackages: ["ts-morph", "web-tree-sitter", "tree-sitter-wasms"],
};

export default nextConfig;
