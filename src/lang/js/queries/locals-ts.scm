; Names declared inside a function body (TypeScript / TSX grammar). Used only to
; avoid resolving a call to a module-level binding that a local name shadows.
(variable_declarator name: (identifier) @local)
(required_parameter pattern: (identifier) @local)
(optional_parameter pattern: (identifier) @local)
(arrow_function parameter: (identifier) @local)
(function_declaration name: (identifier) @local)
(class_declaration name: (type_identifier) @local)
(catch_clause parameter: (identifier) @local)
(shorthand_property_identifier_pattern) @local
(pair_pattern value: (identifier) @local)
(array_pattern (identifier) @local)
(rest_pattern (identifier) @local)
(assignment_pattern left: (identifier) @local)
