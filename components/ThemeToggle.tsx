"use client";

import { useEffect, useState } from "react";
import { IconButton, type IconButtonProps } from "@chakra-ui/react";
import { useTheme } from "next-themes";

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/**
 * Sun/moon button that flips between light and dark mode. Shows a sun while dark
 * (click → go light) and a moon while light (click → go dark). Rendering of the
 * icon is gated on mount to avoid a hydration mismatch, since the resolved theme
 * is only known on the client.
 */
export function ThemeToggle(props: Omit<IconButtonProps, "aria-label" | "children">) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <IconButton
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      variant="ghost"
      size="sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      {...props}
    >
      {mounted ? isDark ? <SunIcon /> : <MoonIcon /> : null}
    </IconButton>
  );
}
