# Settings Pane + Opt-in Advanced Features — Plan

> Execute with superpowers:subagent-driven-development. One subagent per task, two-stage review each.

**Goal:** A right-side **Settings** pane housing two opt-in features that default to current behavior: **Edge routing** (Curved default / Orthogonal) and **Collapse community groups** (default off).

**Architecture:** Mirror the existing `FiltersPanel` (right-side 260px drawer toggled from the toolbar). New state lives in `Explorer`, threads to the renderer (orthogonal) and the collapse transform (community collapse). Defaults preserve all current behavior + the 141 passing tests.

**Patterns to follow (read these first):**
- `components/FiltersPanel.tsx` — drawer layout (`Stack w="260px" bg="bg.panel" borderLeftWidth`, header with ✕ close).
- `components/Explorer.tsx` — `filtersOpen` state + the "Filters" toolbar button (~line 278) + conditional `<FiltersPanel … />` render (~line 340). Mirror for `settingsOpen`/`<SettingsPanel>`.
- `components/Sidebar.tsx` — `Chip`/`ChipRow`/`MiniLabel`/`Section` primitives for consistent toggle UI (exported? if not, the SettingsPanel can use plain Chakra Buttons styled similarly).
- `lib/graph/collapse.ts` — `collapseClusters(graph, collapsed)`; `lib/layout/community.ts` — `detectCommunities`.
- `components/VelloGraphCanvas.tsx` — the `payload` useMemo (edges array) + `vello-renderer/src/lib.rs` edge-drawing block (the `CubicBez` S-curve at the `for e in &self.data.edges` loop).

Run all commands from `C:\Git\TSModuleScanner`. Commit as CapsaicinBunny, no Co-Authored-By trailer. Gate after each task: `bun run typecheck && bun run lint && bun run format:check && bun test`.

---

### Task 1: Settings pane shell + state scaffold

**Files:** Create `components/SettingsPanel.tsx`; modify `components/Explorer.tsx`.

- Add `SettingsPanel` (mirror `FiltersPanel`): props `{ edgeRouting: "curved" | "orthogonal"; onEdgeRouting; communityCollapse: boolean; onCommunityCollapse; onClose }`. Header "Settings" + ✕. Two control groups:
  - **Edge routing** — two buttons Curved / Orthogonal (active = current value).
  - **Collapse community groups** — an on/off toggle button.
- In `Explorer`: add state `edgeRouting` (default `"curved"`) and `communityCollapse` (default `false`); a `settingsOpen` state; a "Settings" toolbar button next to "Filters"; conditionally render `<SettingsPanel>` on the right (same slot pattern as FiltersPanel). Wire the setters. Do NOT consume the values yet (Tasks 2–3 do). Reset both to defaults in `handleResult` (new scan).
- **Verify:** typecheck/lint/format/test all green; the pane opens/closes and the toggles flip (visually trivial; no behavior change yet).

### Task 2: Collapse community groups (opt-in)

**Files:** `lib/graph/collapse.ts` (+ `lib/graph/collapse.test.ts`); `lib/graph/scene.ts`; `components/{useScene,VelloGraphCanvas,Explorer}.tsx`.

- Extend `collapseClusters` to optionally fold by community: add a 3rd param `communityOf?: Map<string,string>` (node id → community id). When a collapsed id is a community id present in `communityOf`, absorb nodes whose `communityOf.get(id) === collapsedId` (alongside the existing directory-prefix logic). Aggregate id/label/count reuse the existing scheme (`aggregateNodeId(communityId)`, label `"<communityId> · <count>"`).
- `buildSceneStructure`: when `groupBy === "community"` AND `communityCollapse` is on, compute `detectCommunities` once on the (filtered) graph and pass the map to `collapseClusters`; otherwise pass undefined (directory-only collapse, unchanged). Thread a `communityCollapse: boolean` param + include in the cache signature.
- Thread `communityCollapse` Explorer → VelloGraphCanvas → useScene → buildSceneStructure.
- **Tests:** `collapse.test.ts` — collapsing a community id with a provided `communityOf` map folds that community into one aggregate + reroutes edges; without the flag/map it's unchanged.
- **Verify:** full gate green.

### Task 3: Orthogonal edge routing (opt-in)

**Files:** `lib/layout.ts` or scene options plumb for `edgeRouting`; `components/{VelloGraphCanvas,useScene,Explorer}.tsx`; `vello-renderer/src/lib.rs`; rebuild `vello-renderer/pkg`.

- Thread `edgeRouting: "curved" | "orthogonal"` Explorer → VelloGraphCanvas. Add it to the Vello JSON payload (top-level field, e.g. `routing: "orthogonal"`).
- `vello-renderer/src/lib.rs`: `SceneData` gains `#[serde(default)] routing: String`. In the edge loop, when `routing == "orthogonal"`, build a right-angle path (BezPath: from start, to a mid elbow, to end — e.g. for LR go horizontal to mid-x then vertical then horizontal; pick elbow by dominant axis) instead of the `CubicBez`. Keep the existing curved path as the default. Preserve the dash/marching-ants stroke + fade.
- Rebuild WASM: `cd vello-renderer && wasm-pack build --target web --release`.
- **Verify:** full gate green + WASM builds. Visual check is done by the controller via the browser loop (not the subagent).

---

## Final
- [ ] Full gate green on the branch.
- [ ] Controller does a visual pass (orthogonal routing + community collapse) via the browser.
- [ ] finishing-a-development-branch → PR → merge.
