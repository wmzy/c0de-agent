# Coding Paradigm
This project follows a strict data + functions paradigm:
- Use `type` (not `interface`) for type definitions.
- Use discriminated unions with `_tag` fields for variant types.
- Use plain functions `export function foo(ctx, ...)` with context-first argument.
- No classes; prefer factory functions and pure data transformation.
- Prefer `import type` for type-only imports.
