import type { Metadata } from "next";
import { Provider } from "@/components/ui/provider";

export const metadata: Metadata = {
  title: "Code Atlas",
  description: "Interactive dependency graph for codebases across ~25 languages",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ margin: 0 }}>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
