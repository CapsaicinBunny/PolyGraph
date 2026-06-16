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
  layoutCacheGet,
  layoutCacheSet,
  type LayoutAlgorithm,
  type LayoutDirection,
  type XYPosition,
} from "@/lib/layout";
import { layoutInWorker } from "@/lib/layout-client";

const EMPTY: Map<string, XYPosition> = new Map();

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
): { scene: Scene; layingOut: boolean } {
  const structure = useMemo(
    () => buildSceneStructure(graph, expanded, filters, algorithm, direction),
    [graph, expanded, filters, algorithm, direction],
  );

  const [positions, setPositions] = useState<Map<string, XYPosition>>(
    () => layoutCacheGet(structure.signature) ?? EMPTY,
  );
  const [layingOut, setLayingOut] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const cached = layoutCacheGet(structure.signature);
    if (cached) {
      setPositions(cached);
      setLayingOut(false);
      return;
    }
    const myReq = ++reqId.current;
    setLayingOut(true);
    layoutInWorker(structure.layoutInput, structure.options)
      .then((pos) => {
        if (myReq !== reqId.current) return; // a newer request superseded this one
        layoutCacheSet(structure.signature, pos);
        setPositions(pos);
        setLayingOut(false);
      })
      .catch(() => {
        if (myReq === reqId.current) setLayingOut(false);
      });
  }, [structure]);

  const scene = useMemo(() => applyPositions(structure, positions), [structure, positions]);
  return { scene, layingOut };
}
