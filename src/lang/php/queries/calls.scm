; Call sites. Each is attributed to the innermost enclosing method, function or
; route closure by byte range, and resolved with the rules in extract.ts.
(member_call_expression) @call.member
(nullsafe_member_call_expression) @call.member
(scoped_call_expression) @call.scoped
(object_creation_expression) @call.new
(function_call_expression) @call.function
