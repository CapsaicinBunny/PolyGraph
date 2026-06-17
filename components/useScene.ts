"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyPositions,
  buildSceneStructure,
  type Scene,
  type SceneFilters,
} from "@/lib/graph/scene";
import type { GraphModel } from "@/lib/graph/types";
import {
  type ClusterBox,
  type GroupBy,
  layoutCacheGet,
  layoutCacheSet,
  type LayoutAlgorithm,
  type LayoutDirection,
  type XYPosition,
} from "@/lib/layout";
import { layoutInWorker } from "@/lib/layout-client";

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
): { scene: Scene; layingOut: boolean } {
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
    ],
  );

  const initial = layoutCacheGet(structure.signature);
  const [positions, setPositions] = useState<Map<string, XYPosition>>(
    initial?.positions ?? EMPTY_POS,
  );
  const [clusters, setClusters] = useState<ClusterBox[]>(initial?.clusters ?? EMPTY_CLUSTERS);
  const [layingOut, setLayingOut] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const cached = layoutCacheGet(structure.signature);
    if (cached) {
      setPositions(cached.positions);
      setClusters(cached.clusters);
      setLayingOut(false);
      return;
    }
    const myReq = ++reqId.current;
    setLayingOut(true);
    const tLayout = performance.now();
    layoutInWorker(structure.layoutInput, structure.options)
      .then(({ positions: pos, clusters: cl }) => {
        if (myReq !== reqId.current) return; // a newer request superseded this one
        console.info(
          `[polygraph] layout (${structure.options.algorithm ?? "layered"}) ${(performance.now() - tLayout).toFixed(0)}ms, ${structure.layoutInput.nodes.length} nodes`,
        );
        layoutCacheSet(structure.signature, { positions: pos, clusters: cl });
        setPositions(pos);
        setClusters(cl);
        setLayingOut(false);
      })
      .catch(() => {
        if (myReq === reqId.current) setLayingOut(false);
      });
  }, [structure]);

  const scene = useMemo(
    () => applyPositions(structure, positions, clusters),
    [structure, positions, clusters],
  );
  return { scene, layingOut };
}
