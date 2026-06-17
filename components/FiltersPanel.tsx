"use client";

import { Box, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import type { FolderInfo, LanguageInfo } from "@/lib/graph/filters";

interface FiltersPanelProps {
  folders: FolderInfo[];
  languages: LanguageInfo[];
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
  onToggleFolder: (name: string) => void;
  onToggleLanguage: (key: string) => void;
  onSetFolders: (on: boolean) => void;
  onSetLanguages: (on: boolean) => void;
  onClose: () => void;
}

const BORDER_VAR = "var(--chakra-colors-border)";
const ACCENT = "#3b82f6";

function Row({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = color ?? ACCENT;
  return (
    <Flex
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      align="center"
      gap="2"
      px="2.5"
      py="1.5"
      rounded="md"
      borderWidth="1px"
      cursor="pointer"
      userSelect="none"
      fontSize="sm"
      color={active ? "fg" : "fg.muted"}
      opacity={active ? 1 : 0.55}
      _hover={{ opacity: 1 }}
      transition="opacity 0.12s"
      style={{
        backgroundColor: active ? `${accent}1f` : "transparent",
        borderColor: active ? accent : BORDER_VAR,
      }}
    >
      <Box w="8px" h="8px" rounded="full" flexShrink={0} style={{ backgroundColor: accent }} />
      <Text flex="1" lineClamp={1}>
        {label}
      </Text>
      <Text fontSize="xs" color="fg.subtle">
        {count}
      </Text>
    </Flex>
  );
}

function GroupHeader({
  title,
  onAll,
  onNone,
}: {
  title: string;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <Flex align="center" justify="space-between" mb="2">
      <Text
        fontSize="11px"
        fontWeight="semibold"
        textTransform="uppercase"
        letterSpacing="wider"
        color="fg.muted"
      >
        {title}
      </Text>
      <HStack gap="2" fontSize="10px" color="fg.subtle">
        <chakra.button type="button" cursor="pointer" _hover={{ color: "fg" }} onClick={onAll}>
          all
        </chakra.button>
        <chakra.button type="button" cursor="pointer" _hover={{ color: "fg" }} onClick={onNone}>
          none
        </chakra.button>
      </HStack>
    </Flex>
  );
}

export function FiltersPanel({
  folders,
  languages,
  enabledFolders,
  enabledLanguages,
  onToggleFolder,
  onToggleLanguage,
  onSetFolders,
  onSetLanguages,
  onClose,
}: FiltersPanelProps) {
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
          Filters
        </Text>
        <chakra.button
          type="button"
          aria-label="Close filters"
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
        <GroupHeader
          title="Folders"
          onAll={() => onSetFolders(true)}
          onNone={() => onSetFolders(false)}
        />
        <Stack gap="1.5">
          {folders.map((f) => (
            <Row
              key={f.name}
              label={f.name}
              count={f.count}
              active={enabledFolders.has(f.name)}
              onClick={() => onToggleFolder(f.name)}
            />
          ))}
        </Stack>
      </Box>

      <Box>
        <GroupHeader
          title="Languages"
          onAll={() => onSetLanguages(true)}
          onNone={() => onSetLanguages(false)}
        />
        <Stack gap="1.5">
          {languages.map((l) => (
            <Row
              key={l.key}
              label={l.label}
              count={l.count}
              color={l.color}
              active={enabledLanguages.has(l.key)}
              onClick={() => onToggleLanguage(l.key)}
            />
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
