import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FILTERABLE_EDGE_KINDS, FILTERABLE_NODE_KINDS } from "@/lib/graph/visual";
import type { Environment, NodeCategory, Runtime } from "@/lib/graph/types";
import { Sidebar } from "./Sidebar";
import { Provider } from "./ui/provider";

afterEach(cleanup);

const noop = () => {};

function baseProps(
  present: {
    categories?: NodeCategory[];
    environments?: Environment[];
    runtimes?: Runtime[];
  } = {},
) {
  return {
    search: "",
    onSearch: noop,
    queryMode: "filter" as const,
    onQueryMode: noop,
    builtinSearches: [],
    savedSearches: [],
    onApplySearch: noop,
    onSaveSearch: noop,
    onDeleteSearch: noop,
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    onToggleEdgeKind: noop,
    enabledNodeKinds: new Set(FILTERABLE_NODE_KINDS),
    onToggleNodeKind: noop,
    onSetNodeKinds: noop,
    enabledCategories: new Set<NodeCategory>(["ui", "feature"]),
    onToggleCategory: noop,
    enabledEnvironments: new Set<Environment>(["client", "server"]),
    onToggleEnvironment: noop,
    enabledRuntimes: new Set<Runtime>(["node", "deno", "bun"]),
    onToggleRuntime: noop,
    presentCategories: new Set<NodeCategory>(present.categories ?? []),
    presentEnvironments: new Set<Environment>(present.environments ?? []),
    presentRuntimes: new Set<Runtime>(present.runtimes ?? []),
    onResetFilters: noop,
    algorithm: "smart" as const,
    onAlgorithm: noop,
    direction: "LR" as const,
    onDirection: noop,
    groupBy: "directory" as const,
    onGroupBy: noop,
  };
}

describe("Sidebar scope section", () => {
  test("hides the Scope section when no scope values are present (C/Rust project)", () => {
    render(
      <Provider>
        <Sidebar {...baseProps()} />
      </Provider>,
    );
    expect(screen.queryByText("Scope")).toBeNull();
  });

  test("shows only the present groups, filtered to present values", () => {
    render(
      <Provider>
        <Sidebar {...baseProps({ runtimes: ["node"] })} />
      </Provider>,
    );

    const header = screen.getByText("Scope");
    expect(header).toBeDefined();
    fireEvent.click(header);

    // Runtime group is present, narrowed to the single detected runtime.
    expect(screen.getByText("Runtime")).toBeDefined();
    expect(screen.getByText("node")).toBeDefined();
    expect(screen.queryByText("deno")).toBeNull();
    expect(screen.queryByText("bun")).toBeNull();

    // Category / Environment have nothing present, so their groups stay hidden.
    expect(screen.queryByText("Category")).toBeNull();
    expect(screen.queryByText("Environment")).toBeNull();
  });
});
