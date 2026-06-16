; Rust language pack. struct/union, enum, trait, type-alias, module, and macro
; each map to their own node kind; functions (incl. impl methods, which are
; top-level function_items) and consts/statics become nodes too. References
; resolve by name against the global unique-definer index.

; --- definitions ---
(struct_item name: (type_identifier) @name) @definition.struct
(union_item name: (type_identifier) @name) @definition.union
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(type_item name: (type_identifier) @name) @definition.type
(mod_item name: (identifier) @name) @definition.module
(function_item name: (identifier) @name) @definition.function
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(macro_definition name: (identifier) @name) @definition.macro

; --- calls (foo() and path::foo()) ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call

; --- imports (use a::b::Item -> final segment Item) ---
(use_declaration argument: (scoped_identifier) @module) @import
