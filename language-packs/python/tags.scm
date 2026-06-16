; Python language pack for the TS Module Scanner kernel.
; Capture convention understood by the extractor:
;   @definition.<kind> + @name    -> a symbol node
;   @reference.<rel> + @name       -> a call / extends edge (resolved by name)
;   @import + @module [+ @import.name] -> an import edge (and a name binding)

; --- definitions ---
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

; --- inheritance: base classes become `extends` edges from the class ---
(class_definition
  superclasses: (argument_list
    [(identifier) @name
     (attribute attribute: (identifier) @name)])) @reference.extends

; --- calls ---
(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name)) @reference.call

; --- imports ---
; from X import a, b [as c]
(import_from_statement
  module_name: [(dotted_name) (relative_import)] @module
  name: [(dotted_name (identifier) @import.name)
         (aliased_import alias: (identifier) @import.name)]) @import

; from X import *
(import_from_statement
  module_name: [(dotted_name) (relative_import)] @module
  (wildcard_import)) @import

; import X [as y]
(import_statement
  name: [(dotted_name) @module
         (aliased_import name: (dotted_name) @module)]) @import
