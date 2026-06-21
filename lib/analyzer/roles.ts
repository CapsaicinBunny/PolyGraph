import { Node, type SourceFile } from "ts-morph";
import type { NodeRole } from "../graph/types";

export type Framework = "react" | "vue" | "angular" | "svelte" | "ecs";

// These lookup tables are Maps, not object literals: every key below is matched
// against a parsed identifier (decorator name, factory-call name), so a plain-object
// `TABLE[name]` would resolve inherited Object.prototype members (`toString`,
// `constructor`, `__proto__`, …) to truthy functions and return one as a NodeRole.
// `Map.get` only matches own entries. See lib/analyzer/facets.ts for the same fix.

// ECS framework factory functions (ECS-specific `define*` idiom).
const ECS_FACTORIES = new Map<string, NodeRole>([
  ["defineSystem", "ecs-system"],
  ["defineQuery", "ecs-system"],
  ["defineEntity", "ecs-entity"],
]);

// Angular's PascalCase class decorators are distinctive and definitive.
const ANGULAR_DECORATORS = new Map<string, NodeRole>([
  ["Component", "angular-component"],
  ["Directive", "angular-directive"],
  ["Pipe", "angular-pipe"],
  ["Injectable", "angular-service"],
  ["NgModule", "angular-module"],
]);

// becsy/ape-ecs style lowercase decorators.
const ECS_DECORATORS = new Map<string, NodeRole>([
  ["component", "ecs-component"],
  ["system", "ecs-system"],
  ["entity", "ecs-entity"],
]);

/** Infer the framework of a file from its extension, then its imports. */
export function detectFramework(file: SourceFile): Framework | undefined {
  const path = file.getFilePath();
  if (path.endsWith(".vue")) return "vue";
  if (path.endsWith(".svelte")) return "svelte";

  for (const imp of file.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec === "@angular/core" || spec.startsWith("@angular/")) return "angular";
    if (spec === "vue" || spec === "vue-router" || spec.startsWith("@vue/")) return "vue";
    if (spec === "svelte" || spec.startsWith("svelte/")) return "svelte";
    if (spec === "bitecs" || spec === "becsy" || spec === "ape-ecs") return "ecs";
    if (spec === "react" || spec === "react-dom") return "react";
  }
  return undefined;
}

/** File-level component role for single-file-component frameworks. */
export function fileRole(framework: Framework | undefined): NodeRole | undefined {
  if (framework === "vue") return "vue-component";
  if (framework === "svelte") return "svelte-component";
  return undefined;
}

function decoratorRole(decl: Node): NodeRole | undefined {
  if (!Node.isDecoratable(decl)) return undefined;
  for (const dec of decl.getDecorators()) {
    const name = dec.getName();
    const angular = ANGULAR_DECORATORS.get(name);
    if (angular) return angular; // exact PascalCase = Angular
    const ecs = ECS_DECORATORS.get(name.toLowerCase());
    if (ecs) return ecs;
  }
  return undefined;
}

/** *System / *Entity / *Component name suffixes (PascalCase), framework-disambiguated. */
function roleFromName(name: string, framework: Framework | undefined): NodeRole | undefined {
  if (/^[A-Z].+System$/.test(name)) return "ecs-system";
  if (/^[A-Z].+Entity$/.test(name)) return "ecs-entity";
  if (/^[A-Z].+Component$/.test(name)) {
    if (framework === "angular") return "angular-component";
    if (framework === "vue") return "vue-component";
    return "ecs-component";
  }
  return undefined;
}

/** Role for a class/interface/type-alias declaration. */
export function classOrInterfaceRole(
  decl: Node,
  name: string,
  framework?: Framework,
): NodeRole | undefined {
  return decoratorRole(decl) ?? roleFromName(name, framework);
}

/** Role for a `const X = factory(...)` declaration. */
export function variableRole(
  initializer: Node | undefined,
  name: string,
  framework?: Framework,
): NodeRole | undefined {
  if (initializer && Node.isCallExpression(initializer)) {
    const expr = initializer.getExpression();
    const fnName = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined;
    if (fnName) {
      const factory = ECS_FACTORIES.get(fnName);
      if (factory) return factory;
      // defineComponent is Vue's primary API and bitECS's; disambiguate by framework.
      if (fnName === "defineComponent")
        return framework === "ecs" ? "ecs-component" : "vue-component";
    }
  }
  return roleFromName(name, framework);
}

/** Role for a named function / arrow (JSX React detection handled separately). */
export function functionRole(name: string, framework?: Framework): NodeRole | undefined {
  return roleFromName(name, framework);
}
