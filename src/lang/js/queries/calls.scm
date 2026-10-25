; Call sites, captured by their callee so most calls (to locals and globals) can be
; discarded by name without touching the rest of the call node.
;   foo(...)            -> @callee.id      (the identifier)
;   obj.prop(...)       -> @callee.member  (the object identifier)
;   import('./x')       -> @callee.import
; Which ones matter is decided in extract.ts using the file's imports and top-level bindings.
(call_expression function: (identifier) @callee.id)
(call_expression function: (member_expression object: (identifier) @callee.member))
(call_expression function: (import) @callee.import)
