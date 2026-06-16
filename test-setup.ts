// Registers a happy-dom backed `window`/`document` into the global scope so that
// component tests can render React into a real DOM under `bun test`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Preserve Bun's native networking globals. happy-dom's DOM-backed fetch/Response
// break Bun.serve (used by the sidecar's tests), and component tests don't need
// them — so capture the native versions and restore them after registering.
const { fetch, Response, Request, Headers } = globalThis;
GlobalRegistrator.register();
Object.assign(globalThis, { fetch, Response, Request, Headers });
