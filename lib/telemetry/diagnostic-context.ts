// A small, app-maintained snapshot of "what was on screen / in flight" that rides on
// every captured error, so a crash log says what the user was DOING — not just where the
// (minified) code threw. The scan crash was a null facet value deep in a memo; the stack
// alone didn't say "a 1,711-node TS scan with externals off was loaded". This does.
//
// Module-global on purpose: errors fire from anywhere, including outside React and after
// the tree has unmounted, so the context can't live in component state. Updated cheaply
// on key transitions (scan loaded, level/group-by/filters changed); read by the error
// handlers (global-errors, ErrorBoundary) and merged into their event payloads.

let context: Record<string, unknown> = {};

/** Merge a patch into the diagnostic context (shallow). Cheap; call freely on transitions. */
export function setDiagnosticContext(patch: Record<string, unknown>): void {
  context = { ...context, ...patch };
}

/** The current diagnostic context, attached to error events. Never throws. */
export function diagnosticContext(): Record<string, unknown> {
  return context;
}

/** Clear the context (tests + a fresh "analyze another"). */
export function resetDiagnosticContext(): void {
  context = {};
}
