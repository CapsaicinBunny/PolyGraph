/** @type {import('next').NextConfig} */
const nextConfig = {
  // PolyGraph ships as a static SPA inside a Tauri webview; analysis runs in the
  // Bun sidecar, not in Next. Export a static bundle (out/) with no server.
  output: "export",
};

export default nextConfig;
