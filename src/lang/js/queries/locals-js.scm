; Names declared inside a function body (JavaScript grammar). See locals-ts.scm.
(variable_declarator name: (identifier) @local)
(formal_parameters (identifier) @local)
(arrow_function parameter: (identifier) @local)
(function_declaration name: (identifier) @local)
(class_declaration name: (identifier) @local)
(catch_clause parameter: (identifier) @local)
(shorthand_property_identifier_pattern) @local
(pair_pattern value: (identifier) @local)
(array_pattern (identifier) @local)
(rest_pattern (identifier) @local)
(assignment_pattern left: (identifier) @local)
