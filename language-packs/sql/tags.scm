; SQL pack (DDL). Tables/views become struct nodes with their columns as fields;
; CREATE FUNCTION -> function, CREATE TYPE -> type.
(create_table (object_reference name: (identifier) @name)) @definition.struct
(create_view (object_reference name: (identifier) @name)) @definition.struct
(create_function (object_reference name: (identifier) @name)) @definition.function
(create_type name: (identifier) @name) @definition.type
(column_definition name: (identifier) @name) @definition.field
