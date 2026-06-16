"use client";

import { ChakraProvider, createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
import { ThemeProvider } from "next-themes";

// Soften the default near-black dark theme into a charcoal/slate palette that's
// easier on the eyes. Only the background + border semantic tokens are overridden;
// everything else (text, accent palettes) inherits Chakra's defaults.
const config = defineConfig({
  theme: {
    semanticTokens: {
      colors: {
        bg: {
          DEFAULT: { value: { _light: "{colors.white}", _dark: "#15171c" } },
          subtle: { value: { _light: "{colors.gray.50}", _dark: "#1b1e24" } },
          muted: { value: { _light: "{colors.gray.100}", _dark: "#212530" } },
          emphasized: { value: { _light: "{colors.gray.200}", _dark: "#2a2f3a" } },
          panel: { value: { _light: "{colors.white}", _dark: "#1c1f26" } },
        },
        border: {
          DEFAULT: { value: { _light: "{colors.gray.200}", _dark: "#32373f" } },
          muted: { value: { _light: "{colors.gray.100}", _dark: "#272b33" } },
          emphasized: { value: { _light: "{colors.gray.300}", _dark: "#3b414c" } },
        },
      },
    },
  },
});

const system = createSystem(defaultConfig, config);

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
        {children}
      </ThemeProvider>
    </ChakraProvider>
  );
}
