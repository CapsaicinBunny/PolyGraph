"use client";

import { Box, Button, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";

interface SettingsPanelProps {
  edgeRouting: "curved" | "orthogonal";
  onEdgeRouting: (v: "curved" | "orthogonal") => void;
  communityCollapse: boolean;
  onCommunityCollapse: (v: boolean) => void;
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

export function SettingsPanel({
  edgeRouting,
  onEdgeRouting,
  communityCollapse,
  onCommunityCollapse,
  onClose,
}: SettingsPanelProps) {
  return (
    <Stack
      w="260px"
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
          Settings
        </Text>
        <chakra.button
          type="button"
          aria-label="Close settings"
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
        <GroupLabel title="Edge routing" />
        <HStack gap="2">
          <Button
            size="sm"
            aria-pressed={edgeRouting === "curved"}
            variant={edgeRouting === "curved" ? "subtle" : "ghost"}
            colorPalette={edgeRouting === "curved" ? "blue" : "gray"}
            onClick={() => onEdgeRouting("curved")}
          >
            Curved
          </Button>
          <Button
            size="sm"
            aria-pressed={edgeRouting === "orthogonal"}
            variant={edgeRouting === "orthogonal" ? "subtle" : "ghost"}
            colorPalette={edgeRouting === "orthogonal" ? "blue" : "gray"}
            onClick={() => onEdgeRouting("orthogonal")}
          >
            Orthogonal
          </Button>
        </HStack>
      </Box>

      <Box>
        <GroupLabel title="Collapse community groups" />
        <Button
          size="sm"
          aria-pressed={communityCollapse}
          variant={communityCollapse ? "subtle" : "ghost"}
          colorPalette={communityCollapse ? "blue" : "gray"}
          onClick={() => onCommunityCollapse(!communityCollapse)}
        >
          {communityCollapse ? "On" : "Off"}
        </Button>
        <Text fontSize="xs" color="fg.muted" mt="2">
          Only affects the Smart layout&apos;s Community grouping.
        </Text>
      </Box>
    </Stack>
  );
}
