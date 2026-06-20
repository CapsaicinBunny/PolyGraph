import type { Metadata } from "next";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Provider } from "@/components/ui/provider";

export const metadata: Metadata = {
  title: "PolyGraph",
  description: "Interactive dependency graph for codebases across ~25 languages",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ margin: 0 }}>
        <ErrorBoundary>
          <Provider>{children}</Provider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
