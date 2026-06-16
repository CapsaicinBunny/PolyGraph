import { type NextRequest, NextResponse } from "next/server";
import type { SourceFileMap } from "@/lib/graph/types";
import { analyzeProject } from "@/lib/kernel";

// ts-morph + tree-sitter need the Node.js runtime (fs / compiler / wasm), not edge.
export const runtime = "nodejs";
export const maxDuration = 60;

interface AnalyzeBody {
  files?: SourceFileMap;
}

export async function POST(req: NextRequest) {
  let body: AnalyzeBody;
  try {
    body = (await req.json()) as AnalyzeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const files = body.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return NextResponse.json(
      { error: "Expected { files: Record<string, string> }" },
      { status: 400 },
    );
  }

  try {
    const result = await analyzeProject(files);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
