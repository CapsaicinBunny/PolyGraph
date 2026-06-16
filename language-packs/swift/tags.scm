; Swift pack. class/struct/enum/actor (one node type, distinguished by
; declaration_kind), protocols, and functions. References resolve by name.
(class_declaration declaration_kind: "class" name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "actor" name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "struct" name: (type_identifier) @name) @definition.struct
(class_declaration declaration_kind: "enum" name: (type_identifier) @name) @definition.enum
(protocol_declaration name: (type_identifier) @name) @definition.protocol
(function_declaration name: (simple_identifier) @name) @definition.function
(call_expression (simple_identifier) @name) @reference.call
