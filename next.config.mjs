/** @type {import('next').NextConfig} */
const nextConfig = {
  // PolyGraph ships as a static SPA inside a Tauri webview; analysis runs in the
  // Bun sidecar, not in Next. Export a static bundle (out/) with no server.
  output: "export",
  // Emit browser source maps in the production/static build so a minified crash stack in
  // session.ndjson decodes back to real file:line — the scan crash shipped as opaque
  // chunk-hash frames (e.g. "2um562…:59:52856") that took a headless repro to locate.
  // The .map files ride alongside the chunks in the local desktop bundle.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
