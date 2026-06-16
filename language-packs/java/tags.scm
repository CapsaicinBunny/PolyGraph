; Java language pack. Methods fold into their class; same-package and imported
; type references resolve by simple name (jvm import style).

; --- definitions ---
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method

; --- inheritance ---
(superclass (type_identifier) @name) @reference.extends
(super_interfaces (type_list (type_identifier) @name)) @reference.implements
(extends_interfaces (type_list (type_identifier) @name)) @reference.extends

; --- usage ---
(method_invocation name: (identifier) @name) @reference.call
(object_creation_expression type: (type_identifier) @name) @reference.instantiates

; --- imports (import a.b.C; -> simple name C) ---
(import_declaration (scoped_identifier) @module) @import
