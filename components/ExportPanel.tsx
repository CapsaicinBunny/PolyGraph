"use client";

import { useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  SimpleGrid,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import type { Insight } from "@/lib/graph/insights";
import {
  applyPositions,
  buildSceneStructure,
  type Scene,
  type SceneFilters,
} from "@/lib/graph/scene";
import type { GraphModel } from "@/lib/graph/types";
import { layoutCacheGet } from "@/lib/layout";
import { toDOT, toGraphML, toMermaid, toPolyGraphJSON } from "@/lib/export/graph-formats";
import { boundsOf, sceneToSVG } from "@/lib/export/svg";
import { toHTMLReport } from "@/lib/export/html-report";
import { saveBlobFile, saveTextFile, svgToPngBlob } from "@/lib/client/download";
import type { ExplorerWorkspaceState } from "@/lib/workspace/schema";
import {
  captureWorkspace,
  parseWorkspace,
  restoreWorkspace,
  workspaceToJSON,
} from "@/lib/workspace/serialize";
import {
  deleteWorkspace,
  listWorkspaces,
  type NamedWorkspace,
  saveWorkspace,
} from "@/lib/workspace/store";

interface ExportPanelProps {
  graph: GraphModel;
  insights: Insight[];
  state: ExplorerWorkspaceState;
  onApplyWorkspace: (s: ExplorerWorkspaceState) => void;
  onClose: () => void;
}

function GroupLabel({ title }: { title: string }) {
  return (
    <Text
      fontSize="11px"
      fontWeight="semibold"
      textTransform="uppercase"
      letterSpacing="wider"
      color="fg.muted"
      mb="2"
    >
      {title}
    </Text>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "polygraph";
}

function sceneFiltersOf(s: ExplorerWorkspaceState): SceneFilters {
  return {
    showExternal: s.showExternal,
    enabledFacets: s.enabledFacets,
    enabledEdgeKinds: s.enabledEdgeKinds,
    enabledFolders: s.enabledFolders,
    enabledLanguages: s.enabledLanguages,
  };
}

export function ExportPanel({
  graph,
  insights,
  state,
  onApplyWorkspace,
  onClose,
}: ExportPanelProps) {
  const [status, setStatus] = useState<string>("");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<NamedWorkspace[]>(() => listWorkspaces());
  const fileInput = useRef<HTMLInputElement>(null);

  const project = baseName(state.projectPath);

  // Rebuild the positioned scene from the layout cache (the canvas already laid
  // it out under the same signature). Null when nothing has been rendered yet.
  const currentScene = (): Scene | null => {
    const structure = buildSceneStructure(
      graph,
      state.expanded,
      sceneFiltersOf(state),
      state.algorithm,
      state.direction,
      state.collapsedClusters,
      state.groupBy,
      state.density,
      state.communityCollapse,
      state.focusedIds,
    );
    const cached = layoutCacheGet(structure.signature);
    return cached ? applyPositions(structure, cached.positions, cached.clusters) : null;
  };

  const sceneOrWarn = (): Scene | null => {
    const scene = currentScene();
    if (!scene) setStatus("Render the graph first (let the current view finish laying out).");
    return scene;
  };

  const exportText = async (ext: string, text: string, mime: string) => {
    const fileName = `${project}.${ext}`;
    if (await saveTextFile(fileName, text, mime)) setStatus(`Exported ${fileName}`);
  };

  const exportSVG = () => {
    const scene = sceneOrWarn();
    if (scene) void exportText("svg", sceneToSVG(scene), "image/svg+xml");
  };

  const exportPNG = async () => {
    const scene = sceneOrWarn();
    if (!scene) return;
    try {
      const b = boundsOf(scene);
      const blob = await svgToPngBlob(sceneToSVG(scene), b.width, b.height, 2);
      if (await saveBlobFile(`${project}.png`, blob)) setStatus(`Exported ${project}.png`);
    } catch (e) {
      setStatus(`PNG export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const exportHTML = () => {
    const scene = sceneOrWarn();
    if (!scene) return;
    const html = toHTMLReport({
      projectName: project,
      graph,
      svg: sceneToSVG(scene),
      insights,
      generatedAt: new Date().toLocaleString(),
    });
    void exportText("html", html, "text/html");
  };

  const exportWorkspaceFile = async () => {
    const fileName = `${project}.polygraph-workspace.json`;
    if (
      await saveTextFile(fileName, workspaceToJSON(captureWorkspace(state)), "application/json")
    ) {
      setStatus("Exported workspace JSON");
    }
  };

  const saveNamed = () => {
    const n = name.trim();
    if (!n) {
      setStatus("Enter a name to save the workspace.");
      return;
    }
    saveWorkspace(n, captureWorkspace(state), Date.now());
    setSaved(listWorkspaces());
    setName("");
    setStatus(`Saved workspace "${n}"`);
  };

  const applyNamed = (ws: NamedWorkspace) => {
    onApplyWorkspace(restoreWorkspace(ws.workspace));
    setStatus(`Loaded workspace "${ws.name}"`);
  };

  const removeNamed = (n: string) => {
    deleteWorkspace(n);
    setSaved(listWorkspaces());
  };

  const importFile = async (file: File) => {
    try {
      const ws = parseWorkspace(await file.text());
      onApplyWorkspace(restoreWorkspace(ws));
      setStatus("Imported workspace JSON");
    } catch (e) {
      setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Stack
      w="300px"
      h="full"
      p="4"
      gap="5"
      bg="bg.panel"
      borderLeftWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <Flex align="center" justify="space-between">
        <Text fontSize="sm" fontWeight="semibold">
          Export & workspaces
        </Text>
        <chakra.button
          type="button"
          aria-label="Close export panel"
          onClick={onClose}
          color="fg.muted"
          _hover={{ color: "fg" }}
          fontSize="lg"
          lineHeight="1"
        >
          ✕
        </chakra.button>
      </Flex>

      <Box>
        <GroupLabel title="Graph data" />
        <SimpleGrid columns={2} gap="2">
          <Button
            size="sm"
            variant="subtle"
            onClick={() => void exportText("json", toPolyGraphJSON(graph), "application/json")}
          >
            JSON
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() =>
              void exportText("dot", toDOT(graph, state.direction), "text/vnd.graphviz")
            }
          >
            DOT
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => void exportText("graphml", toGraphML(graph), "application/xml")}
          >
            GraphML
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => void exportText("mmd", toMermaid(graph, state.direction), "text/plain")}
          >
            Mermaid
          </Button>
        </SimpleGrid>
      </Box>

      <Box>
        <GroupLabel title="Image & report" />
        <SimpleGrid columns={2} gap="2">
          <Button size="sm" variant="subtle" colorPalette="blue" onClick={exportSVG}>
            SVG
          </Button>
          <Button size="sm" variant="subtle" colorPalette="blue" onClick={() => void exportPNG()}>
            PNG
          </Button>
          <Button
            size="sm"
            variant="subtle"
            colorPalette="blue"
            gridColumn="span 2"
            onClick={exportHTML}
          >
            Standalone HTML report
          </Button>
        </SimpleGrid>
      </Box>

      <Box>
        <GroupLabel title="Workspace" />
        <HStack gap="2" mb="2">
          <Input
            size="sm"
            rounded="lg"
            placeholder="Workspace name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveNamed();
            }}
          />
          <Button size="sm" variant="solid" colorPalette="green" onClick={saveNamed}>
            Save
          </Button>
        </HStack>
        <HStack gap="2">
          <Button size="sm" variant="subtle" onClick={() => void exportWorkspaceFile()}>
            Export JSON
          </Button>
          <Button size="sm" variant="subtle" onClick={() => fileInput.current?.click()}>
            Import JSON
          </Button>
          <chakra.input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            display="none"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = "";
            }}
          />
        </HStack>

        {saved.length > 0 && (
          <Stack gap="1" mt="3">
            {saved.map((w) => (
              <HStack key={w.name} gap="2" justify="space-between">
                <chakra.button
                  type="button"
                  flex="1"
                  textAlign="left"
                  fontSize="sm"
                  color="fg"
                  _hover={{ color: "blue.fg" }}
                  truncate
                  title={`Load "${w.name}"`}
                  onClick={() => applyNamed(w)}
                >
                  {w.name}
                </chakra.button>
                <chakra.button
                  type="button"
                  aria-label={`Delete ${w.name}`}
                  color="fg.muted"
                  _hover={{ color: "red.fg" }}
                  fontSize="sm"
                  onClick={() => removeNamed(w.name)}
                >
                  ✕
                </chakra.button>
              </HStack>
            ))}
          </Stack>
        )}
      </Box>

      {status && (
        <Text fontSize="xs" color="fg.muted">
          {status}
        </Text>
      )}
    </Stack>
  );
}
