# PolyGraph CLI

PolyGraph ships a CLI that turns the analyzer into an **architectural guardrail**
(`check`). It runs the same multi-language kernel the desktop app uses, so it
covers every supported language.

```bash
bun run cli/index.ts <command> [path] [options]
# or, once installed (package.json "bin"):
polygraph <command> [path] [options]
```

`path` defaults to `.` (the current directory). `check --baseline` requires the
path to be inside a git repo.

---

## `polygraph check` — architecture rules in CI

Loads `.polygraph.yml`, scans the working tree, evaluates every rule and
threshold, and exits **non-zero if any error-severity rule is violated** — ready
to drop into CI.

```bash
polygraph check .                    # human-readable report
polygraph check . --format sarif     # SARIF 2.1.0 for GitHub code scanning
polygraph check . --baseline main    # only fail on violations new vs. main
```

| Option             | Default                 | Meaning                                                                                                                         |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--config <file>`  | `<path>/.polygraph.yml` | Config file location                                                                                                            |
| `--format <fmt>`   | `text`                  | `text` or `sarif`                                                                                                               |
| `--baseline <rev>` | —                       | Report only violations **not already present** on `<rev>`. Lets a team adopt rules without first fixing every legacy violation. |

### `.polygraph.yml`

```yaml
rules:
  # Dependency rule: nothing matching `from` may depend on anything in `disallow`.
  - name: Domain must not depend on UI
    from: src/domain/** # glob, list of globs, or a selector object
    disallow:
      - src/ui/**

  # Cycle rule: flag strongly-connected components (import cycles).
  - name: No circular package dependencies
    scope: packages/** # optional — only cycles fully inside the scope
    cycles: error # error | warning

  # Selectors can match by kind/role/environment/category, not just path.
  - name: Components cannot access database directly
    from:
      kind: component
    disallow:
      path: src/database/**

thresholds:
  maxFanOut: 25 # flag nodes depending on > 25 distinct nodes
  maxDependencyDepth: 12 # flag dependency chains deeper than 12 levels
  # severity: error             # severity for threshold breaches (default error)
```

**Selectors** (`from`, `disallow`, `scope`) accept:

- a bare glob string — shorthand for `{ path: … }`
- a list of globs
- an object with any of `path`, `kind`, `role`, `environment`, `category`
  (each a single value or a list). Facets are AND-ed; values within a facet are
  OR-ed.

**Severity & exit code.** Dependency rules default to `error`; cycle rules take
their severity from `cycles:`; thresholds use `thresholds.severity` (default
`error`). `check` exits `1` when any **error** survives (after baseline
filtering), `0` otherwise. Warnings are reported but never fail the build.

Globs use `**` (crosses directories), `*` (within a segment), and `?` (single
char), matched against forward-slash relative paths.

---

## Architecture of the implementation

Pure, language-agnostic, and unit-tested — nothing here is tied to one language
or to the UI:

| Module                           | Responsibility                                             |
| -------------------------------- | ---------------------------------------------------------- |
| `lib/glob/match.ts`              | Dependency-free glob → RegExp matcher                      |
| `lib/config/{schema,load}.ts`    | Parse & validate `.polygraph.yml`                          |
| `lib/rules/{selector,engine}.ts` | Evaluate rules + thresholds → violations                   |
| `lib/rules/sarif.ts`             | SARIF 2.1.0 serializer                                     |
| `lib/cli/*`                      | Scan (working tree / git revision), reporters, arg parsing |
| `cli/index.ts`                   | Command dispatch                                           |
