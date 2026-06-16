import { stat } from "node:fs/promises";
import { type NextRequest, NextResponse } from "next/server";
import { analyzeSources } from "@/lib/analyzer";
import { scanDirectory } from "@/lib/server/scan-dir";

// Reads the local filesystem, so it must run on the Node.js runtime.
export const runtime = "nodejs";
export const maxDuration = 120;

interface ScanBody {
  path?: string;
}

export async function POST(req: NextRequest) {
  let body: ScanBody;
  try {
    body = (await req.json()) as ScanBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const path = body.path?.trim();
  if (!path) {
    return NextResponse.json({ error: "Expected { path: string }" }, { status: 400 });
  }

  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return NextResponse.json({ error: `Not a directory: ${path}` }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: `Path not found: ${path}` }, { status: 400 });
  }

  try {
    const { files, skipped } = await scanDirectory(path);
    const fileCount = Object.keys(files).length;
    if (fileCount === 0) {
      return NextResponse.json(
        { error: "No .ts / .tsx / .js / .jsx files found under that path." },
        { status: 400 },
      );
    }
    const result = analyzeSources(files);
    return NextResponse.json({ ...result, fileCount, skipped, root: path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
