; Go language pack. struct/interface types, type aliases, top-level functions
; and methods, and package-level const/var become nodes (locals fold into their
; function). Calls resolve by name against the global unique-definer index (Go
; shares all top-level names within a package without imports).

; --- definitions ---
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface
(type_declaration (type_alias name: (type_identifier) @name)) @definition.type
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(const_spec name: (identifier) @name) @definition.constant
(var_spec name: (identifier) @name) @definition.variable

; --- calls (foo() and pkg.Foo()) ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call
