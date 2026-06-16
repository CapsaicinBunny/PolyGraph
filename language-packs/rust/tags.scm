; Rust language pack. struct/enum/trait become type-ish nodes; functions (incl.
; impl methods, which are top-level function_items) become function nodes.
; References resolve by name against the global unique-definer index.

; --- definitions ---
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.interface
(function_item name: (identifier) @name) @definition.function

; --- calls (foo() and path::foo()) ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call

; --- imports (use a::b::Item -> final segment Item) ---
(use_declaration argument: (scoped_identifier) @module) @import
