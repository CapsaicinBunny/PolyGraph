; Scala language pack. Classes, objects, traits, type members, and functions
; become nodes (methods fold into their class/object). Supertypes -> extends.
; References resolve by name against the global unique-definer index.

; --- definitions ---
(class_definition name: (identifier) @name) @definition.class
(object_definition name: (identifier) @name) @definition.object
(trait_definition name: (identifier) @name) @definition.trait
(type_definition name: (type_identifier) @name) @definition.type
(function_definition name: (identifier) @name) @definition.function
(function_declaration name: (identifier) @name) @definition.function

; --- inheritance ---
(class_definition extend: (extends_clause type: (type_identifier) @name)) @reference.extends
(trait_definition extend: (extends_clause type: (type_identifier) @name)) @reference.extends
(object_definition extend: (extends_clause type: (type_identifier) @name)) @reference.extends

; --- calls ---
(call_expression function: (identifier) @name) @reference.call
