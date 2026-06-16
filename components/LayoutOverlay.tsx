"use client";

import { Box, HStack, Spinner, Text } from "@chakra-ui/react";

/** Small "Laying out…" pill shown while a layout computes on the worker. */
export function LayoutOverlay() {
  return (
    <Box
      position="absolute"
      top="3"
      left="50%"
      transform="translateX(-50%)"
      zIndex={5}
      pointerEvents="none"
    >
      <HStack
        gap="2"
        bg="bg.panel"
        borderWidth="1px"
        borderColor="border"
        rounded="full"
        px="3"
        py="1.5"
        shadow="md"
      >
        <Spinner size="xs" />
        <Text fontSize="xs" color="fg.muted">
          Laying out…
        </Text>
      </HStack>
    </Box>
  );
}
