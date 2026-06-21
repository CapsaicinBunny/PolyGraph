"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyPositions,
  buildSceneStructure,
  type Scene,
  type SceneFilters,
} from "@/lib/graph/scene";
import type { DimensionCatalog } from "@/lib/graph/dimensions";
import type { GraphModel } from "@/lib/graph/types";
import {
  type ClusterBox,
  type GroupBy,
  layoutCacheGet,
  layoutCacheSet,
  type LayoutAlgorithm,
  type LayoutDirection,
  layoutFallbackSummary,
  type XYPosition,
} from "@/lib/layout";
import { layoutInWorker } from "@/lib/layout-client";
import { telemetry } from "@/lib/telemetry";

const EMPTY_POS: Map<string, XYPosition> = new Map();
const EMPTY_CLUSTERS: ClusterBox[] = [];

/**
 * Build a positioned scene, running layout off the main thread (Web Worker) so the UI
 * stays responsive on large graphs. Cached layouts resolve synchronously; only a fresh
 * layout goes async (with `layingOut` true while it runs).
 */
export function useScene(
  graph: GraphModel,
  expanded: Set<string>,
  filters: SceneFilters,
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection,
  collapsedClusters: Set<string>,
  groupBy: GroupBy,
  density: number,
  communityCollapse: boolean,
  focusedIds: Set<string> | null,
  queryIds: Set<string> | null = null,
  projected = false,
  catalog?: DimensionCatalog,
): { scene: Scene; layingOut: boolean; ready: boolean } {
  const structure = useMemo(
    () =>
      buildSceneStructure(
        graph,
        expanded,
        filters,
        algorithm,
        direction,
        collapsedClusters,
        groupBy,
        density,
        communityCollapse,
        focusedIds,
        queryIds,
        projected,
        catalog,
      ),
    [
      graph,
      expanded,
      filters,
      algorithm,
      direction,
      collapsedClusters,
      groupBy,
      density,
      communityCollapse,
      focusedIds,
      queryIds,
      projected,
      catalog,
    ],
  );

  const initial = layoutCacheGet(structure.signature);
  const [positions, setPositions] = useState<Map<string, XYPosition>>(
    initial?.positions ?? EMPTY_POS,
  );
  const [clusters, setClusters] = useState<ClusterBox[]>(initial?.clusters ?? EMPTY_CLUSTERS);
  // The structure signature `positions` were actually laid out for. On a structure change this
  // lags by a render (positions update in the effect below), so `ready` is false until the new
  // layout lands — the camera must not re-fit a half-applied scene (surviving nodes at old coords,
  // new nodes still at 0,0). Seeded true on a cache hit, which applies positions synchronously.
  const [positionedSig, setPositionedSig] = useState(initial ? structure.signature : "");
  const [layingOut, setLayingOut] = useState(false);
  const ready = positionedSig === structure.signature;
  const reqId = useRef(0);

  // Always-current positions, read as the seed for the NEXT layout. On a structure
  // change this still holds the prior layout's positions, so engines continue from
  // there and the mental map is preserved across filter/zoom changes.
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    const cached = layoutCacheGet(structure.signature);
    if (cached) {
      // A cache hit costs no layout work — record it so the metrics show how often
      // re-layout is avoided (a high hit rate is why panning/filtering stays smooth).
      telemetry.count("layout.cacheHits");
      telemetry.event(
        "layout",
        "cache-hit",
        { nodes: structure.layoutInput.nodes.length, clusters: cached.clusters.length },
        "debug",
      );
      setPositions(cached.positions);
      setClusters(cached.clusters);
      setPositionedSig(structure.signature);
      setLayingOut(false);
      return;
    }
    const myReq = ++reqId.current;
    setLayingOut(true);
    const tLayout = performance.now();
    // Seed from the previous layout (when there is one) for mental-map stability.
    const seed = positionsRef.current;
    const options =
      seed.size > 0 ? { ...structure.options, previousPositions: seed } : structure.options;
    layoutInWorker(structure.layoutInput, options)
      .then(({ positions: pos, clusters: cl }) => {
        if (myReq !== reqId.current) return; // a newer request superseded this one
        const layoutMs = performance.now() - tLayout;
        telemetry.event("layout", "run", {
          algorithm: structure.options.algorithm ?? "layered",
          nodes: structure.layoutInput.nodes.length,
          edges: structure.layoutInput.edges.length,
          clusters: cl.length,
          layoutMs,
        });
        telemetry.metric("layout.ms", layoutMs);
        telemetry.metric("layout.nodes", structure.layoutInput.nodes.length);
        telemetry.count("layout.runs");
        // Surface Smart's budget-driven engine downgrades (#71) in the session log, so a grid
        // fallback isn't mistaken for the chosen engine producing a poor result.
        const simplified = layoutFallbackSummary(cl);
        if (simplified) telemetry.event("layout", "simplified", { summary: simplified }, "warn");
        layoutCacheSet(structure.signature, { positions: pos, clusters: cl });
        setPositions(pos);
        setClusters(cl);
        setPositionedSig(structure.signature);
        setLayingOut(false);
      })
      .catch((err) => {
        // Tag superseded rejections so a stale layout that errors after a newer one
        // started isn't read as a real failure in the log.
        telemetry.event(
          "layout",
          "error",
          { message: String(err), superseded: myReq !== reqId.current },
          "error",
        );
        if (myReq === reqId.current) setLayingOut(false);
      });
  }, [structure]);

  const scene = useMemo(
    () => applyPositions(structure, positions, clusters),
    [structure, positions, clusters],
  );
  return { scene, layingOut, ready };
}
