// Registers a happy-dom backed `window`/`document` into the global scope so that
// component tests can render React into a real DOM under `bun test`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
