; F# pack. Modules, type definitions (records/unions/classes), and let-bound
; functions/values. References resolve by name against the global definer index.
(module_defn (identifier) @name) @definition.module
(type_name type_name: [(identifier) (long_identifier)] @name) @definition.type
(function_or_value_defn
  (function_declaration_left (identifier) @name)) @definition.function
