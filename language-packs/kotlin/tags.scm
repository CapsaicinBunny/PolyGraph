; Kotlin language pack. Classes, objects, functions, and top-level properties
; become nodes. Supertypes (class or interface) -> extends.

; --- definitions ---
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.object
(function_declaration (simple_identifier) @name) @definition.function
(property_declaration (variable_declaration (simple_identifier) @name)) @definition.property

; --- inheritance (Kotlin lists supertypes via delegation_specifier) ---
(class_declaration
  (delegation_specifier (constructor_invocation (user_type (type_identifier) @name)))) @reference.extends
(class_declaration
  (delegation_specifier (user_type (type_identifier) @name))) @reference.extends

; --- calls ---
(call_expression (simple_identifier) @name) @reference.call

; --- imports (import a.b.C -> simple name C) ---
(import_header (identifier) @module) @import
