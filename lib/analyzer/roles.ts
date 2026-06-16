import { Node } from "ts-morph";
import type { NodeRole } from "../graph/types";

// ECS framework factory functions, mapped to the role they produce. Restricted to
// the ECS-specific `define*` idiom (bitECS / becsy) to avoid colliding with common
// non-ECS factories like Chakra's createSystem or generic create*/Component helpers.
const ECS_FACTORIES: Record<string, NodeRole> = {
  defineComponent: "ecs-component",
  defineSystem: "ecs-system",
  defineQuery: "ecs-system",
  defineEntity: "ecs-entity",
};

// Decorator names that mark an ECS role (case-insensitive match on the bare name).
const ECS_DECORATORS: Record<string, NodeRole> = {
  component: "ecs-component",
  system: "ecs-system",
  entity: "ecs-entity",
};

function roleFromName(name: string): NodeRole | undefined {
  // Require a PascalCase prefix so camelCase factories (defineComponent, useSystem)
  // and bare words aren't mistaken for ECS types.
  if (/^[A-Z].+System$/.test(name)) return "ecs-system";
  if (/^[A-Z].+Component$/.test(name)) return "ecs-component";
  if (/^[A-Z].+Entity$/.test(name)) return "ecs-entity";
  return undefined;
}

function roleFromDecorators(decl: Node): NodeRole | undefined {
  if (!Node.isDecoratable(decl)) return undefined;
  for (const dec of decl.getDecorators()) {
    const key = dec.getName().toLowerCase();
    if (ECS_DECORATORS[key]) return ECS_DECORATORS[key];
  }
  return undefined;
}

/** Role for a class or interface declaration, from decorators then name. */
export function classOrInterfaceRole(decl: Node, name: string): NodeRole | undefined {
  return roleFromDecorators(decl) ?? roleFromName(name);
}

/** Role for a `const X = factory(...)` declaration, from the factory call then name. */
export function variableRole(initializer: Node | undefined, name: string): NodeRole | undefined {
  if (initializer && Node.isCallExpression(initializer)) {
    const expr = initializer.getExpression();
    const fnName = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined;
    if (fnName && ECS_FACTORIES[fnName]) return ECS_FACTORIES[fnName];
  }
  return roleFromName(name);
}

/** Role for a named function declaration / arrow, from name only (JSX handled separately). */
export function functionRole(name: string): NodeRole | undefined {
  return roleFromName(name);
}
