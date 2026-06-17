// Built-in saved searches — the named queries shipped with the app. Each is just a
// label + a query string in the v1 grammar, so they're fully transparent and tunable.

export interface SavedSearch {
  name: string;
  query: string;
}

export const BUILTIN_SEARCHES: readonly SavedSearch[] = [
  {
    name: "Public API",
    query: "(kind:function | kind:method | kind:class | kind:interface) incoming:>0",
  },
  { name: "High-impact modules", query: "incoming:>5" },
  { name: "React rendering tree", query: "role:react-component | kind:component" },
  { name: "Database access", query: 'depends-on:"database" | depends-on:"db"' },
  { name: "Circular dependencies", query: "cycle:true" },
];
