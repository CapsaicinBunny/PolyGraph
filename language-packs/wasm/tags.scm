; WebAssembly text format (.wat). Surface a module's functions, globals, and
; type definitions (named with $identifiers) as nodes.
(module_field_func identifier: (identifier) @name) @definition.function
(module_field_global identifier: (identifier) @name) @definition.variable
(module_field_type identifier: (identifier) @name) @definition.type
