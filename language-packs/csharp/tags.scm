; C# pack. Classes, interfaces, structs, enums, records, namespaces, and their
; members (methods, constructors, properties, fields). Base types -> extends.
; References resolve by name against the global unique-definer index.

; --- definitions ---
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(namespace_declaration name: (_) @name) @definition.namespace
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.property
(field_declaration
  (variable_declaration (variable_declarator name: (identifier) @name))) @definition.field

; --- inheritance / interfaces (C# doesn't distinguish them syntactically) ---
(class_declaration (base_list (identifier) @name)) @reference.extends
(interface_declaration (base_list (identifier) @name)) @reference.extends

; --- usage ---
(invocation_expression function: (identifier) @name) @reference.call
(invocation_expression
  function: (member_access_expression name: (identifier) @name)) @reference.call
(object_creation_expression type: (identifier) @name) @reference.instantiates
