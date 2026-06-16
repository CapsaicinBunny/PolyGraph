; Java language pack. Classes, interfaces, enums, records, annotations, and their
; members (methods, constructors, fields) all become nodes; references resolve by
; simple name (jvm import style).

; --- definitions ---
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(annotation_type_declaration name: (identifier) @name) @definition.annotation
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field

; --- inheritance ---
(superclass (type_identifier) @name) @reference.extends
(super_interfaces (type_list (type_identifier) @name)) @reference.implements
(extends_interfaces (type_list (type_identifier) @name)) @reference.extends

; --- usage ---
(method_invocation name: (identifier) @name) @reference.call
(object_creation_expression type: (type_identifier) @name) @reference.instantiates

; --- imports (import a.b.C; -> simple name C) ---
(import_declaration (scoped_identifier) @module) @import
