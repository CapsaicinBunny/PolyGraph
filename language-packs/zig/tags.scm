; Zig pack. Functions, and the struct/enum types declared as `const X = struct
; {...}` / `const X = enum {...}`.
(function_declaration name: (identifier) @name) @definition.function
(variable_declaration (identifier) @name (struct_declaration)) @definition.struct
(variable_declaration (identifier) @name (enum_declaration)) @definition.enum
