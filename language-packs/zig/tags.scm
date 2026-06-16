; Zig pack. Functions and top-level declarations. (Zig types are `const X =
; struct {...}`, so they surface as variables here.)
(function_declaration name: (identifier) @name) @definition.function
(variable_declaration (identifier) @name) @definition.variable
