"use client";

import { useEffect, useRef, useState } from "react";

// Phase-1 proof of concept: load the Vello (Rust→WASM) renderer and draw a card
// onto a WebGPU canvas. Browser-only (WebGPU); loaded via dynamic import in an effect.
export function VelloPoc() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("initializing…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let vc: {
      render: () => void;
      resize: (w: number, h: number) => void;
      free?: () => void;
    } | null = null;

    void (async () => {
      try {
        if (!("gpu" in navigator)) {
          setStatus("WebGPU is not available in this browser (need Chrome/Edge with WebGPU).");
          return;
        }
        const mod = await import("../vello-renderer/pkg/vello_renderer.js");
        await mod.default(); // instantiate the wasm module

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

        vc = await mod.VelloCanvas.create(canvas);
        if (disposed) {
          vc?.free?.();
          return;
        }
        vc.render();
        setStatus("Vello render OK ✓");
      } catch (e) {
        setStatus(`Vello init failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      disposed = true;
      try {
        vc?.free?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh", background: "#15171c" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          font: "13px sans-serif",
          color: status.includes("OK") ? "#4ade80" : "#f87171",
          background: "rgba(0,0,0,0.4)",
          padding: "6px 10px",
          borderRadius: 8,
        }}
      >
        {status}
      </div>
    </div>
  );
}
