"use client";

import { Badge, Box, HStack, Text } from "@chakra-ui/react";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { LayoutDirection } from "@/lib/layout";
import type { ExternalKind, NodeKind, NodeRole } from "@/lib/graph/types";
import { glyphFor, nodeStyle } from "@/lib/graph/visual";

export interface GraphFlowNodeData {
  label: string;
  kind: NodeKind;
  role?: NodeRole;
  externalKind?: ExternalKind;
  symbolCount: number;
  expanded: boolean;
  matched: boolean;
  searching: boolean;
  direction: LayoutDirection;
  [key: string]: unknown;
}

// Where edges enter (target) and leave (source) a node, per flow direction.
const HANDLES: Record<LayoutDirection, { target: Position; source: Position }> = {
  LR: { target: Position.Left, source: Position.Right },
  RL: { target: Position.Right, source: Position.Left },
  TB: { target: Position.Top, source: Position.Bottom },
  BT: { target: Position.Bottom, source: Position.Top },
};

export function GraphFlowNode({ data, selected }: NodeProps) {
  const d = data as GraphFlowNodeData;
  const style = nodeStyle(d.kind, d.role, d.externalKind);
  const isFile = d.kind === "file";
  const isExternal = d.kind === "external";
  const dimmed = d.searching && !d.matched;
  const handles = HANDLES[d.direction] ?? HANDLES.LR;
  const glyph = glyphFor(d.kind, d.role);

  return (
    <Box
      bg={isExternal ? "bg.subtle" : "bg.panel"}
      borderWidth="1px"
      borderStyle={isExternal ? "dashed" : "solid"}
      borderColor={selected ? `${style.palette}.400` : "border.emphasized"}
      borderLeftWidth="4px"
      borderLeftStyle="solid"
      borderLeftColor={`${style.palette}.500`}
      rounded="md"
      px="3"
      py="2"
      minW={isFile ? "190px" : "160px"}
      shadow={selected ? "md" : "xs"}
      opacity={dimmed ? 0.3 : 1}
      outline={d.matched && d.searching ? "2px solid" : undefined}
      outlineColor="yellow.400"
      transition="opacity 0.15s, box-shadow 0.15s"
      cursor="pointer"
    >
      <Handle
        type="target"
        position={handles.target}
        style={{ background: style.color, border: "none" }}
      />
      <HStack gap="2" align="center">
        <Text color={`${style.palette}.400`} fontSize="sm" fontWeight="bold" lineHeight="1">
          {glyph}
        </Text>
        <Text
          fontWeight={isFile ? "semibold" : "medium"}
          fontSize={isFile ? "sm" : "xs"}
          color="fg"
          truncate
          maxW="130px"
          title={d.label}
        >
          {d.label}
        </Text>
        {isFile && d.symbolCount > 0 && (
          <Badge size="sm" colorPalette={style.palette} variant="subtle" ml="auto">
            {d.expanded ? "−" : "+"}
            {d.symbolCount}
          </Badge>
        )}
      </HStack>
      <Handle
        type="source"
        position={handles.source}
        style={{ background: style.color, border: "none" }}
      />
    </Box>
  );
}
