import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FILTERABLE_EDGE_KINDS } from "@/lib/graph/visual";
import type { FacetKey } from "@/lib/graph/dimensions";
import type { FacetSelection } from "@/lib/graph/facet-selection";
import type { FilterDimension } from "@/lib/graph/filter-derive";
import { Sidebar } from "./Sidebar";
import { Provider } from "./ui/provider";

afterEach(cleanup);

const noop = () => {};

function dim(
  key: FacetKey,
  label: string,
  values: { value: string; label: string; count: number }[],
  stats: Partial<FilterDimension["stats"]> = {},
): FilterDimension {
  return {
    key,
    label,
    dimension: "facet",
    cardinality: "single",
    values: values.map((v) => ({ ...v, color: "#888", declared: true })),
    stats: {
      distinctValues: values.length,
      coverage: 1,
      largestBucketFraction: 0.5,
      eligible: true,
      ...stats,
    },
  };
}

function baseProps(filterDimensions: FilterDimension[] = []) {
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
    onSetEdgeKinds: noop,
    enabledFacets: new Map<FacetKey, FacetSelection>(),
    filterDimensions,
    onToggleFacetValue: noop,
    onSetFacetValues: noop,
    onResetFilters: noop,
    algorithm: "smart" as const,
    onAlgorithm: noop,
    direction: "LR" as const,
    onDirection: noop,
    groupBy: "directory" as const,
    onGroupBy: noop,
  };
}

describe("Sidebar dynamic facet sections", () => {
  test("renders one section per filterable dimension with its values and counts", () => {
    const dims = [
      dim("category", "Category", [
        { value: "ui", label: "UI", count: 3 },
        { value: "feature", label: "Feature", count: 7 },
      ]),
    ];
    render(
      <Provider>
        <Sidebar {...baseProps(dims)} />
      </Provider>,
    );
    expect(screen.getByText("Category")).toBeDefined();
    expect(screen.getByText("UI")).toBeDefined();
    expect(screen.getByText("Feature")).toBeDefined();
    // counts are shown
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("7")).toBeDefined();
  });

  test("a multi-language / multi-framework graph surfaces MULTIPLE facet sections", () => {
    const dims = [
      dim("role", "Role", [
        { value: "react-component", label: "React component", count: 4 },
        { value: "vue-component", label: "Vue component", count: 2 },
      ]),
      dim("env", "Environment", [
        { value: "client", label: "Client", count: 5 },
        { value: "server", label: "Server", count: 6 },
      ]),
      dim("rust.visibility", "Visibility", [
        { value: "pub", label: "pub", count: 9 },
        { value: "crate", label: "crate", count: 3 },
      ]),
    ];
    render(
      <Provider>
        <Sidebar {...baseProps(dims)} />
      </Provider>,
    );
    expect(screen.getByText("Role")).toBeDefined();
    expect(screen.getByText("Environment")).toBeDefined();
    expect(screen.getByText("Visibility")).toBeDefined();
  });

  test("clicking a value chip toggles that facet value", () => {
    const toggled: Array<[string, string]> = [];
    const dims = [dim("category", "Category", [{ value: "ui", label: "UI", count: 1 }])];
    render(
      <Provider>
        <Sidebar
          {...baseProps(dims)}
          onToggleFacetValue={(key: string, value: string) => {
            toggled.push([key, value]);
          }}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByText("UI"));
    expect(toggled).toEqual([["category", "ui"]]);
  });

  test("the section 'all' / 'none' control sets every value of the dimension", () => {
    const calls: Array<[string, string[], boolean]> = [];
    const dims = [
      dim("env", "Environment", [
        { value: "client", label: "Client", count: 1 },
        { value: "server", label: "Server", count: 1 },
      ]),
    ];
    render(
      <Provider>
        <Sidebar
          {...baseProps(dims)}
          onSetFacetValues={(key: string, values: string[], on: boolean) => {
            calls.push([key, values, on]);
          }}
        />
      </Provider>,
    );
    // The eligible Environment section is open by default — hit ITS "hide all"
    // (scoped to the Environment section header, not Relationships/Node-types).
    const header = screen.getByText("Environment").closest("div")!.parentElement!;
    fireEvent.click(within(header).getByText("hide all"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe("env");
    expect(calls[0][1].sort()).toEqual(["client", "server"]);
    expect(calls[0][2]).toBe(false);
  });

  test("an ineligible (dominant single-bucket) dimension is not shown by default", () => {
    const dims = [
      dim(
        "env",
        "Environment",
        [
          { value: "server", label: "Server", count: 100 },
          { value: "client", label: "Client", count: 1 },
        ],
        { eligible: false, largestBucketFraction: 0.99 },
      ),
    ];
    render(
      <Provider>
        <Sidebar {...baseProps(dims)} />
      </Provider>,
    );
    // The ineligible dimension's values aren't rendered up-front.
    expect(screen.queryByText("Server")).toBeNull();
  });

  test("a filter-search box appears when there are many values and filters the chips", () => {
    // Lots of values across sections → the search box is offered.
    const dims = [
      dim(
        "role",
        "Role",
        Array.from({ length: 12 }, (_, i) => ({
          value: `r${i}`,
          label: `Role ${i}`,
          count: i + 1,
        })),
      ),
    ];
    render(
      <Provider>
        <Sidebar {...baseProps(dims)} />
      </Provider>,
    );
    const box = screen.getByPlaceholderText("Filter values…");
    expect(box).toBeDefined();
    fireEvent.change(box, { target: { value: "Role 1" } });
    // "Role 1", "Role 10", "Role 11" match; "Role 2" does not.
    expect(screen.getByText("Role 1")).toBeDefined();
    expect(screen.queryByText("Role 2")).toBeNull();
  });

  test("renders nothing for facets when no dimensions are present (empty graph)", () => {
    render(
      <Provider>
        <Sidebar {...baseProps([])} />
      </Provider>,
    );
    // No crash, and no facet section headers for an empty set (Node types/Relationships
    // remain, but no Category/Environment/Role).
    expect(screen.queryByText("Category")).toBeNull();
    expect(screen.queryByText("Environment")).toBeNull();
    expect(screen.queryByText("Role")).toBeNull();
  });
});
