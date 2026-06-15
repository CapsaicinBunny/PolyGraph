"use client";

import { Badge, Box, HStack, Text } from "@chakra-ui/react";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { NodeKind } from "@/lib/graph/types";
import { NODE_STYLES } from "@/lib/graph/visual";

export interface GraphFlowNodeData {
  label: string;
  kind: NodeKind;
  symbolCount: number;
  expanded: boolean;
  matched: boolean;
  searching: boolean;
  [key: string]: unknown;
}

const KIND_GLYPH: Record<NodeKind, string> = {
  file: "▣",
  class: "◆",
  interface: "◇",
  function: "ƒ",
  component: "⬡",
};

export function GraphFlowNode({ data, selected }: NodeProps) {
  const d = data as GraphFlowNodeData;
  const style = NODE_STYLES[d.kind];
  const isFile = d.kind === "file";
  const dimmed = d.searching && !d.matched;

  return (
    <Box
      bg="bg.panel"
      borderWidth="1px"
      borderColor={selected ? `${style.palette}.400` : "border.emphasized"}
      borderLeftWidth="4px"
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
        position={Position.Left}
        style={{ background: style.color, border: "none" }}
      />
      <HStack gap="2" align="center">
        <Text color={`${style.palette}.400`} fontSize="sm" fontWeight="bold" lineHeight="1">
          {KIND_GLYPH[d.kind]}
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
        position={Position.Right}
        style={{ background: style.color, border: "none" }}
      />
    </Box>
  );
}
