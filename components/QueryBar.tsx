"use client";

import { useState } from "react";
import { Box, Button, Flex, HStack, Input, Stack, Text } from "@chakra-ui/react";
import type { SavedSearch } from "@/lib/graph/query-language";

export type QueryMode = "filter" | "highlight";

interface QueryBarProps {
  query: string;
  onQuery: (value: string) => void;
  mode: QueryMode;
  onMode: (mode: QueryMode) => void;
  /** Parse error for the current query, if any. */
  error?: string;
  /** Number of nodes the current (valid, non-empty) query matches, if known. */
  matchCount?: number;
  builtins: readonly SavedSearch[];
  saved: SavedSearch[];
  onApply: (query: string) => void;
  onSaveCurrent: () => void;
  onDelete: (name: string) => void;
  onReset: () => void;
}

const BORDER_VAR = "var(--chakra-colors-border)";
const ACCENT = "#3b82f6";

function ModeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Box
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
      px="2.5"
      py="0.5"
      rounded="full"
      borderWidth="1px"
      fontSize="11px"
      fontWeight="medium"
      cursor="pointer"
      userSelect="none"
      color={active ? "fg" : "fg.muted"}
      opacity={active ? 1 : 0.6}
      _hover={{ opacity: 1 }}
      style={{
        backgroundColor: active ? `${ACCENT}26` : "transparent",
        borderColor: active ? ACCENT : BORDER_VAR,
      }}
    >
      {label}
    </Box>
  );
}

function SavedChip({
  name,
  onApply,
  onDelete,
}: {
  name: string;
  onApply: () => void;
  onDelete?: () => void;
}) {
  return (
    <HStack
      gap="1"
      px="2"
      py="1"
      rounded="md"
      borderWidth="1px"
      borderColor="border"
      fontSize="11px"
      _hover={{ bg: "bg.muted" }}
    >
      <Box role="button" tabIndex={0} cursor="pointer" onClick={onApply} flex="1" lineClamp={1}>
        {name}
      </Box>
      {onDelete && (
        <Box
          role="button"
          tabIndex={0}
          aria-label={`Delete saved search ${name}`}
          cursor="pointer"
          color="fg.subtle"
          _hover={{ color: "red.fg" }}
          onClick={onDelete}
        >
          ✕
        </Box>
      )}
    </HStack>
  );
}

export function QueryBar({
  query,
  onQuery,
  mode,
  onMode,
  error,
  matchCount,
  builtins,
  saved,
  onApply,
  onSaveCurrent,
  onDelete,
  onReset,
}: QueryBarProps) {
  const [open, setOpen] = useState(false);

  return (
    <Stack gap="2">
      <HStack gap="2">
        <Input
          size="sm"
          rounded="lg"
          placeholder="Search or query…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          borderColor={error ? "red.solid" : undefined}
        />
        <Button size="sm" variant="ghost" colorPalette="gray" onClick={onReset} flexShrink={0}>
          Reset
        </Button>
      </HStack>

      {error ? (
        <Text fontSize="11px" color="red.fg">
          {error}
        </Text>
      ) : (
        query.trim() !== "" &&
        matchCount !== undefined && (
          <Text fontSize="11px" color="fg.subtle">
            {matchCount} match{matchCount === 1 ? "" : "es"}
          </Text>
        )
      )}

      <Flex align="center" justify="space-between" gap="2">
        <HStack gap="1">
          <ModeChip label="Filter" active={mode === "filter"} onClick={() => onMode("filter")} />
          <ModeChip
            label="Highlight"
            active={mode === "highlight"}
            onClick={() => onMode("highlight")}
          />
        </HStack>
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
          fontSize="11px"
          color="fg.muted"
          cursor="pointer"
          userSelect="none"
          _hover={{ color: "fg" }}
        >
          Saved {open ? "▴" : "▾"}
        </Box>
      </Flex>

      {open && (
        <Stack gap="2" pt="1">
          <Stack gap="1">
            <Text fontSize="10px" color="fg.subtle" textTransform="uppercase" letterSpacing="wide">
              Presets
            </Text>
            {builtins.map((s) => (
              <SavedChip key={s.name} name={s.name} onApply={() => onApply(s.query)} />
            ))}
          </Stack>
          {saved.length > 0 && (
            <Stack gap="1">
              <Text
                fontSize="10px"
                color="fg.subtle"
                textTransform="uppercase"
                letterSpacing="wide"
              >
                Yours
              </Text>
              {saved.map((s) => (
                <SavedChip
                  key={s.name}
                  name={s.name}
                  onApply={() => onApply(s.query)}
                  onDelete={() => onDelete(s.name)}
                />
              ))}
            </Stack>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={query.trim() === "" || error !== undefined}
            onClick={onSaveCurrent}
          >
            ＋ Save current query
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
