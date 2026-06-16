(module_definition name: (identifier) @name) @definition.module
(struct_definition (type_head (identifier) @name)) @definition.struct
(function_definition (signature (call_expression (identifier) @name))) @definition.function
