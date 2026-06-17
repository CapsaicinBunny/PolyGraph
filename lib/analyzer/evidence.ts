import type { Node } from "ts-morph";
import type { EdgeConfidence, EdgeEvidence } from "../graph/types";
import { toRelativePath } from "./project";

/** Build an EdgeEvidence from the AST node a relationship originates at (provider: TypeScript). */
export function nodeEvidence(node: Node, confidence: EdgeConfidence): EdgeEvidence {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  return {
    filePath: toRelativePath(sf.getFilePath()),
    line,
    column,
    provider: "TypeScript",
    confidence,
  };
}
