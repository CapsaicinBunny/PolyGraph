; Go language pack. struct/interface type declarations and top-level functions
; become nodes; calls resolve by name against the global unique-definer index
; (Go shares all top-level names within a package without imports).

; --- definitions ---
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface
(function_declaration name: (identifier) @name) @definition.function

; --- calls (foo() and pkg.Foo()) ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call
