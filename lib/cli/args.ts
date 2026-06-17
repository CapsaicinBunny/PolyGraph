// Tiny argv parser for the polygraph CLI. Splits `--flag value` / `--flag=value`
// from positionals. No external dependency — the surface is small enough that a
// real arg library would be overkill.

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true"; // boolean flag
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
