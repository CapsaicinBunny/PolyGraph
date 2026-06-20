// Three-layer collapse model — the ownership fix at the heart of Phase C0
// (docs/superpowers/specs/2026-06-20-polymorphic-dimension-spine-design.md →
// "Grouping & collapse" / "Three-layer collapse"). The old `collapsedClusters`
// was ONE set with five writers — load-seed, expand/collapse-all, manual drill,
// the camera cut, and workspace restore — and the camera OVERWROTE the whole set,
// clobbering user intent. This module replaces that with three independent layers
// composed by a pure function, so **user intent can never be clobbered by the
// camera**.
//
// The three layers, by who owns them:
//   1. intent          — ONLY real user actions (manual collapse/drill, collapse-all).
//   2. bootstrapClosed — derived SAFETY (the on-load auto-collapse seed, expand-all
//                        budget seed). NOT user intent.
//   3. selection       — the camera's transitional LOD layer: the set of directories
//                        the adaptive cut wants OPEN. Owned by the camera alone.
//
// Pure, no React. Directory-only group ids in C0 (community/facet are later phases),
// but the model is namespaced and mode-agnostic so C1 reuses it unchanged.

/** A namespaced group id, e.g. "directory:src/server" (community/facet later). */
export type GroupId = string;

/**
 * The user's collapse intent — and ONLY real user actions. A group is absent until
 * the user explicitly opens or closes it; absence means "let the auto layers decide".
 * The camera/bootstrap never write here, so a zoom can't clobber what the user chose.
 */
export type CollapseIntent = Map<GroupId, "open" | "closed">;

export interface ComposeInput {
  /** User actions only (manual drill, collapse-all). Highest precedence. */
  intent: CollapseIntent;
  /** Derived safety seed (on-load auto-collapse, expand-all budget). Not intent. */
  bootstrapClosed: ReadonlySet<GroupId>;
  /** The camera/LOD layer: directories the adaptive cut wants OPEN. */
  selection: ReadonlySet<GroupId>;
}

/**
 * Compose the three layers into the effective COLLAPSED set.
 *
 * Precedence, highest-first (spec "Three-layer collapse"):
 *   explicit user 'closed'  →  collapsed
 *   explicit user 'open'    →  open
 *   selection (LOD) open    →  open
 *   bootstrapClosed         →  collapsed
 *   default                 →  open
 *
 * A group is collapsed iff the user closed it, OR (the user didn't open it AND the
 * camera didn't open it AND the bootstrap closed it). `selection` only ever *opens*
 * a group — it can reveal a bootstrap-closed directory but never collapses one the
 * bootstrap left open (it is a set of OPEN dirs, mirroring the transitional
 * DirectoryLodSelection). Pure: inputs are never mutated; a fresh Set is returned.
 */
export function compose({ intent, bootstrapClosed, selection }: ComposeInput): Set<GroupId> {
  const out = new Set<GroupId>();

  // Bootstrap-closed groups collapse unless a higher layer (user-open or LOD-open)
  // overrides them — user-'closed' is handled below and would re-add anyway.
  for (const id of bootstrapClosed) {
    const i = intent.get(id);
    if (i === "open") continue; // explicit user open wins
    if (i === "closed") {
      out.add(id);
      continue;
    }
    if (selection.has(id)) continue; // LOD opened it
    out.add(id);
  }

  // Explicit user 'closed' always collapses, regardless of bootstrap/selection — and
  // covers groups the bootstrap never touched (a manual collapse of a default-open dir).
  for (const [id, value] of intent) {
    if (value === "closed") out.add(id);
  }

  return out;
}
