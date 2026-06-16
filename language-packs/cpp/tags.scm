; C++ pack. Classes, structs, unions, enums, namespaces, typedefs, and functions
; (free + in-class methods fold). References resolve by name.
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(function_definition
  declarator: (function_declarator
    declarator: [(identifier) (field_identifier)] @name)) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
