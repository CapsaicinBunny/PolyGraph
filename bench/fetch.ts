// Fetch the optional pinned real-world repos listed in REMOTE_FIXTURES into
// bench/.fixtures/<id> (gitignored). Each is shallow-cloned and checked out at its
// pinned sha for reproducibility. The core suite runs without these — they only
// broaden per-language + size-scaling coverage.

import { existsSync } from "node:fs";
import { $ } from "bun";
import { REMOTE_FIXTURES, remoteFixtureRoot } from "./fixtures";

if (REMOTE_FIXTURES.length === 0) {
  console.error(
    "No remote fixtures configured. Add pinned repos to REMOTE_FIXTURES in bench/fixtures.ts.",
  );
  process.exit(0);
}

for (const fx of REMOTE_FIXTURES) {
  const dest = remoteFixtureRoot(fx.id);
  if (existsSync(dest)) {
    console.error(`✓ ${fx.id} already present (${dest})`);
    continue;
  }
  console.error(`↓ ${fx.id}: cloning ${fx.repo} @ ${fx.sha}`);
  try {
    await $`git init -q ${dest}`;
    await $`git -C ${dest} remote add origin ${fx.repo}`;
    await $`git -C ${dest} fetch -q --depth 1 origin ${fx.sha}`;
    await $`git -C ${dest} checkout -q FETCH_HEAD`;
    console.error(`✓ ${fx.id} ready`);
  } catch (e) {
    console.error(`✗ ${fx.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
