// Public surface of the search query language.

export { type EvalOptions, type QueryResult, runQuery } from "./evaluate";
export { type Node as QueryNode, parse } from "./parse";
export { BUILTIN_SEARCHES, type SavedSearch } from "./presets";

import { parse } from "./parse";

/** Validate a query string; returns an error message, or undefined when it's valid. */
export function queryError(src: string): string | undefined {
  return parse(src).error;
}
