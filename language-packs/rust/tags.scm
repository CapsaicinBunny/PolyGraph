; Rust language pack. struct/union, enum, trait, type-alias, module, and macro
; each map to their own node kind; functions (incl. impl methods, which are
; top-level function_items) and consts/statics become nodes too. References
; resolve by name against the global unique-definer index.
;
; Facets (Phase E): each visibility-bearing item captures its visibility_modifier
; as @facet.rust.visibility (text-valued: "pub", "pub(crate)", "pub(super)", …).
; Items with no modifier are private — the rust.visibility descriptor's
; defaultValue, so private is never materialized per node. Functions additionally
; tag async / unsafe via the @facet.<key>.<value> literal form; these patterns
; re-capture @definition.function so the facet lands on the same function node
; (facets accumulate across matches by node).

; --- definitions (with visibility facet) ---
(struct_item (visibility_modifier)? @facet.rust.visibility
  name: (type_identifier) @name) @definition.struct
(union_item (visibility_modifier)? @facet.rust.visibility
  name: (type_identifier) @name) @definition.union
(enum_item (visibility_modifier)? @facet.rust.visibility
  name: (type_identifier) @name) @definition.enum
(trait_item (visibility_modifier)? @facet.rust.visibility
  name: (type_identifier) @name) @definition.trait
(type_item (visibility_modifier)? @facet.rust.visibility
  name: (type_identifier) @name) @definition.type
(mod_item (visibility_modifier)? @facet.rust.visibility
  name: (identifier) @name) @definition.module
(function_item (visibility_modifier)? @facet.rust.visibility
  name: (identifier) @name) @definition.function
(const_item (visibility_modifier)? @facet.rust.visibility
  name: (identifier) @name) @definition.constant
(static_item (visibility_modifier)? @facet.rust.visibility
  name: (identifier) @name) @definition.constant
(macro_definition name: (identifier) @name) @definition.macro

; --- function modifier facets (async / unsafe) ---
; Separate patterns re-capture the function so the facet attaches to the same
; node. The modifier keywords are anonymous tokens inside function_modifiers.
(function_item (function_modifiers "async")
  name: (identifier) @name) @definition.function @facet.rust.async.async
(function_item (function_modifiers "unsafe")
  name: (identifier) @name) @definition.function @facet.rust.unsafe.unsafe

; --- calls (foo() and path::foo()) ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call

; --- imports (use a::b::Item -> final segment Item) ---
(use_declaration argument: (scoped_identifier) @module) @import
