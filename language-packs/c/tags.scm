; C pack. Functions, structs, unions, enums, and typedefs become nodes; calls
; resolve by name against the global unique-definer index.
(function_definition
  declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(struct_specifier name: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(call_expression function: (identifier) @name) @reference.call
