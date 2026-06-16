; Kotlin language pack (tree-sitter-kotlin-ng). Classes, objects, functions, and
; top-level properties become nodes. Supertypes -> extends.

; --- definitions ---
(class_declaration name: (identifier) @name) @definition.class
(object_declaration name: (identifier) @name) @definition.object
(function_declaration name: (identifier) @name) @definition.function
(property_declaration (variable_declaration (identifier) @name)) @definition.property

; --- inheritance (supertypes via delegation_specifiers) ---
(class_declaration
  (delegation_specifiers
    (delegation_specifier (constructor_invocation (user_type (identifier) @name))))) @reference.extends
(class_declaration
  (delegation_specifiers
    (delegation_specifier (type (user_type (identifier) @name))))) @reference.extends

; --- calls ---
(call_expression (identifier) @name) @reference.call

; --- imports (import a.b.C -> simple name C) ---
(import [(identifier) (qualified_identifier)] @module) @import
